import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ImportError, abortIfNeeded } from "./security.ts";
import type { Ocr, OcrResult } from "./types.ts";

const require = createRequire(import.meta.url);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export class LocalOcr implements Ocr {
  async recognize(png: Uint8Array, signal: AbortSignal): Promise<OcrResult> {
    abortIfNeeded(signal);
    if (png.length > 20 * 1024 * 1024 || png.length < 24 || !Buffer.from(png.subarray(0, 8)).equals(pngSignature))
      throw new ImportError("IMAGE", "请使用小于 20 MB 的 PNG 剪贴板图片。");
    const header = Buffer.from(png.subarray(16, 24));
    if (header.readUInt32BE(0) * header.readUInt32BE(4) > 25_000_000) throw new ImportError("IMAGE", "图片像素过多，请裁剪 API 信息区域。");
    // Only public language weights are copied to this directory. Clipboard
    // image/text/key data stays in memory and the child's private stdin/stdout.
    const langPath = await mkdtemp(path.join(tmpdir(), "magpie-import-tessdata-"));
    try {
      await Promise.all(["eng", "chi_sim"].map(code => copyFile(path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), "4.0.0_best_int", `${code}.traineddata.gz`), path.join(langPath, `${code}.traineddata.gz`))));
      abortIfNeeded(signal);
      const workerPath = fileURLToPath(new URL("../src/ocr-worker.mjs", import.meta.url));
      const result = await new Promise<OcrResult>((resolve, reject) => {
        // Process isolation keeps errors in WASM/workers from taking down
        // Magpie's shared Bun plugin host. No stderr is logged.
        const child = spawn(process.execPath, [workerPath, langPath], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        const chunks: Buffer[] = []; let size = 0, stopped = false;
        const stop = () => { stopped = true; child.kill(); };
        const timeout = setTimeout(stop, 45_000);
        signal.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > 1_048_576) stop(); else chunks.push(data); });
        child.stdin.on("error", () => {});
        child.on("error", () => { stopped = true; });
        child.on("close", code => {
          clearTimeout(timeout); signal.removeEventListener("abort", stop);
          if (stopped || code !== 0) { reject(new ImportError("OCR", "本地截图识别失败或已取消，请裁剪图片或复制文字重试。")); return; }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (typeof data.text !== "string") throw new Error();
            resolve({ text: data.text, keyReviewRequired: true });
          } catch { reject(new ImportError("OCR", "本地截图识别失败，请复制文字重试。")); }
        });
        child.stdin.end(png);
        if (signal.aborted) stop();
      });
      abortIfNeeded(signal);
      return result;
    } finally {
      // langPath is the absolute task-specific directory returned by mkdtemp.
      await rm(langPath, { recursive: true, force: true });
    }
  }
}
