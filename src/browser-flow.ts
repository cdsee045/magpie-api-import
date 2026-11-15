import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSession } from "./host.ts";
import type { Command } from "./host.ts";
import { ImportError, publicError } from "./security.ts";
import { makeAuth } from "./official-auth.ts";
import type { AuthResult } from "./official-auth.ts";
import type { Clipboard, Ocr, ViewState } from "./types.ts";
import type { Validator } from "./validator.ts";

export interface BrowserFlow {
  url: string;
  result: Promise<AuthResult>;
  wait(signal?: AbortSignal): Promise<AuthResult>;
  close(): Promise<void>;
}
export async function startBrowserFlow(options: { signal?: AbortSignal; validator?: Validator; ocr?: Ocr; timeoutMs?: number; graceMs?: number } = {}): Promise<BrowserFlow> {
  options.signal?.throwIfAborted();
  const token = randomBytes(32).toString("hex"), prefix = `/import/${token}/`;
  let origin = "", active = true, finished = false, closed = false, opened = false;
  let input: Clipboard = { kind: "empty" }, latest: ViewState;
  let onPage = (_page: string) => {}, lastSeen = Date.now(), completion: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (value: AuthResult) => void;
  const result = new Promise<AuthResult>(resolve => { resolveResult = resolve; });
  const finish = (value: AuthResult) => {
    if (finished) return;
    finished = true; input = { kind: "empty" };
    clearInterval(heartbeat); clearTimeout(deadline);
    // Let the confirmation response and submitted state reach the browser.
    resolveResult(value);
    completion = setTimeout(() => { void close(); }, options.graceMs ?? 15_000);
    completion.unref();
  };
  const flowSession = createSession({
    currentPage: () => active ? "api-import" : "",
    onPage(fn) { onPage = fn; return () => { onPage = () => {}; }; },
    async readClipboard(signal) { signal.throwIfAborted(); const value = input; input = { kind: "empty" }; return value; },
    async hasProvider() { return false; },
    async appendProvider({ candidate, receipt }, signal) {
      signal.throwIfAborted();
      if (!active || finished) throw new ImportError("PAGE", "本次导入已经结束。");
      // createSession already checked its private receipt against this exact
      // candidate. The returned auth exposes only the verified model.
      const auth = makeAuth(candidate, receipt);
      finish(auth);
      return { id: auth.metadata.identity };
    },
    options: { async get() { return { auto: false }; }, async set() { throw new ImportError("INPUT", "请主动粘贴或选择图片。"); } },
  }, { scope: "api-import", validator: options.validator, ocr: options.ocr });
  flowSession.subscribe(state => { latest = state.status === "saved" ? { ...state, message: "配置已提交给 Magpie。请返回 Magpie 查看登录结果；保存由 Magpie 完成。" } : state; });
  const cancel = () => { active = false; onPage(""); finish({ type: "failed", error: "已取消本次 API 导入，未提交配置。" }); };
  const onAbort = () => { cancel(); void close(); };
  const deadline = setTimeout(cancel, options.timeoutMs ?? 600_000); deadline.unref();
  const heartbeat = setInterval(() => { if (Date.now() - lastSeen > (opened ? 30_000 : 120_000)) cancel(); }, 5_000); heartbeat.unref();
  const assets = new Map([
    ["", ["official.html", "text/html; charset=utf-8"]],
    ["style.css", ["style.css", "text/css; charset=utf-8"]],
    ["import.js", ["import.js", "application/javascript"]],
    ["local-bridge.js", ["local-bridge.js", "application/javascript"]],
  ]);
  function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
    res.writeHead(status, {
      "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${origin}; img-src 'self' blob: data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    });
    res.end(type === "application/json" ? JSON.stringify(body) : body as string | Buffer);
  }
  async function json(req: IncomingMessage) {
    if (req.headers["content-type"] !== "application/json") throw new ImportError("INPUT", "请求格式错误。");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 29_000_000) throw new ImportError("SIZE", "输入内容过大。"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }
  const server = createServer(async (req, res) => {
    try {
      if (closed || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "请求来源无效。" });
      const url = new URL(req.url ?? "", origin);
      if (!url.pathname.startsWith(prefix) || url.search) return send(res, 404, { error: "导入页面不存在。" });
      const part = url.pathname.slice(prefix.length);
      if (req.method === "GET" && assets.has(part)) {
        if (part === "") { opened = true; lastSeen = Date.now(); }
        const [file, type] = assets.get(part)!;
        return send(res, 200, await readFile(new URL(`../ui/${file}`, import.meta.url)), type);
      }
      if (req.headers["x-api-import"] !== "1") return send(res, 403, { error: "导入会话无效。" });
      if (req.method === "GET" && part === "state") { lastSeen = Date.now(); return send(res, 200, latest!); }
      if (req.method !== "POST" || req.headers.origin !== origin) return send(res, 403, { error: "请求来源无效。" });
      const body = await json(req);
      if (part === "cancel") { cancel(); return send(res, 200, { ok: true }); }
      if (finished) return send(res, 409, { error: "本次导入已结束，请返回 Magpie。" });
      if (part === "suspend") { active = false; input = { kind: "empty" }; onPage(""); return send(res, 200, { ok: true }); }
      if (part === "resume") { active = true; lastSeen = Date.now(); onPage("api-import"); return send(res, 200, { ok: true }); }
      if (!active) return send(res, 409, { error: "请回到导入页面重试。" });
      if (part === "input") {
        if (body.kind === "text" && typeof body.text === "string" && Buffer.byteLength(body.text) <= 1_048_576) input = { kind: "text", text: body.text };
        else if (body.kind === "image" && typeof body.png === "string" && body.png.length <= 28_000_000 && body.png.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body.png)) input = { kind: "image", png: Buffer.from(body.png, "base64") };
        else throw new ImportError("INPUT", "请粘贴文字，或选择小于 20 MB 的图片。");
        // Replacing an input revokes an earlier confirmation synchronously.
        await flowSession.command({ type: "dismiss" });
        return send(res, 200, { ok: true });
      }
      if (part === "key") return send(res, 200, { key: flowSession.revealKey() });
      if (part === "encoded-key") return send(res, 200, { encoded: flowSession.revealEncodedKey(body.original === true) });
      if (part === "command") {
        if (!["detect", "verify", "models", "confirm", "dismiss", "select", "edit", "decode"].includes(String(body.type))) throw new ImportError("COMMAND", "无法识别操作。");
        await flowSession.command(body as unknown as Command);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "操作不存在。" });
    } catch (error) { send(res, 400, { error: publicError(error) }); }
  });
  server.requestTimeout = 65_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("loopback server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  async function close() {
    if (closed) return;
    closed = true; active = false; input = { kind: "empty" };
    if (!finished) finish({ type: "failed", error: "本次导入已关闭，未提交配置。" });
    clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(completion);
    options.signal?.removeEventListener("abort", onAbort);
    flowSession.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return {
    url: origin + prefix, result, close,
    async wait(signal) {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try { return await result; } finally { signal?.removeEventListener("abort", onAbort); }
    },
  };
}
