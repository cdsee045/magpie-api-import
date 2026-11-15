import { ImportController } from "./controller.ts";
import { ImportError, candidateIssues, configFingerprint, fingerprint } from "./security.ts";
import { HttpValidator } from "./validator.ts";
import { LocalOcr } from "./ocr.ts";
import type { Candidate, Clipboard, ImportHost, Ocr, Receipt, ViewState } from "./types.ts";
import type { Validator } from "./validator.ts";

export interface NativeHost {
  // Internal adapter running in Bun. The official flow supplies explicit user
  // input and hands validated auth back to Magpie; this is not a Magpie API.
  readClipboard(signal: AbortSignal): Promise<Clipboard>;
  hasProvider(identity: string, signal: AbortSignal): Promise<boolean>;
  // Accept a privately validated result once. The official adapter resolves
  // the login callback; Magpie itself owns account persistence and merging.
  appendProvider(input: { candidate: Candidate; identity: string; verifiedModel: string; receipt: Receipt; preserveDefaults: true }, signal: AbortSignal): Promise<{ id: string }>;
  options: { get(): Promise<{ auto?: boolean }>; set(options: { auto: boolean }): Promise<void> };
  // Owned by the adapter's lifecycle, never an arbitrary route from a frame.
  onPage(listener: (page: string) => void): () => void;
  currentPage(): string;
}
export type Command =
  | { type: "detect" } | { type: "verify" } | { type: "models" } | { type: "confirm" } | { type: "dismiss" }
  | { type: "select"; index: number } | { type: "auto"; value: boolean }
  | { type: "decode"; encoded: string }
  | { type: "edit"; changes: Partial<Pick<Candidate, "name" | "url" | "key" | "model" | "protocol">>; reviewed?: boolean };

export interface ImportSession {
  subscribe(listener: (state: ViewState) => void): () => void;
  command(command: Command): Promise<void>;
  revealKey(): string;
  revealEncodedKey(): string;
  dispose(): void;
}

export function createSession(native: NativeHost, deps: { validator?: Validator; ocr?: Ocr; now?: () => number; scope?: string } = {}): ImportSession {
  const now = deps.now ?? Date.now;
  // The official plugin owns a short-lived browser login scope. The default
  // remains for the original isolated creation-form harness, not a host API.
  const scope = deps.scope ?? "providers/custom/new";
  const controllerPage = (page: string) => page === scope ? "providers/custom/new" : "";
  let active = native.currentPage() === scope;
  let closed = false;
  const assertPage = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (closed || !active || native.currentPage() !== scope) throw new ImportError("PAGE", "请在当前导入页面操作。");
  };
  // Only receipts emitted by this validator instance may authorize a save.
  const receipts = new Map<string, Receipt>();
  const validator = deps.validator ?? new HttpValidator();
  const checkedValidator: Validator = {
    models: async (candidate, signal) => { assertPage(signal); return validator.models(candidate, signal); },
    validate: async (candidate, signal) => {
      assertPage(signal);
      const receipt = await validator.validate(candidate, signal);
      assertPage(signal);
      receipts.clear(); receipts.set(receipt.fingerprint, { ...receipt });
      return receipt;
    },
  };
  const host: ImportHost = {
    async readClipboard(signal) { assertPage(signal); return native.readClipboard(signal); },
    async exists(candidate, signal) { assertPage(signal); return native.hasProvider(configFingerprint(candidate), signal); },
    async save(candidate, receipt, signal) {
      assertPage(signal);
      const identity = fingerprint(candidate), issued = receipts.get(identity);
      if (!issued || receipt.fingerprint !== identity || issued.expiresAt <= now() || receipt.model !== candidate.model || candidateIssues(candidate).length)
        throw new ImportError("RECEIPT", "需要重新验证这条配置。");
      receipts.delete(identity);
      return native.appendProvider({ candidate, identity: configFingerprint(candidate), verifiedModel: receipt.model, receipt: { ...issued }, preserveDefaults: true }, signal);
    },
    async getAuto() { return (await native.options.get()).auto !== false; },
    async setAuto(auto) { await native.options.set({ auto }); },
  };
  const controller = new ImportController(host, checkedValidator, deps.ocr ?? new LocalOcr(), now);
  const off = native.onPage(page => {
    active = page === scope;
    if (!active) receipts.clear();
    void controller.setPage(controllerPage(page));
  });
  void controller.setPage(controllerPage(native.currentPage()));
  return {
    subscribe: listener => controller.subscribe(listener),
    async command(command) {
      assertPage();
      switch (command.type) {
        case "detect": receipts.clear(); await controller.detect(true); break;
        case "verify": receipts.clear(); await controller.verify(); break;
        case "models": receipts.clear(); await controller.loadModels(); break;
        case "confirm": await controller.confirm(); break;
        case "dismiss": receipts.clear(); controller.dismiss(); break;
        case "auto": if (typeof command.value !== "boolean") throw new ImportError("COMMAND", "设置格式错误。"); await controller.setAuto(command.value); break;
        case "select": receipts.clear(); await controller.select(command.index); break;
        case "decode":
          if (typeof command.encoded !== "string" || command.encoded.length > 11_000) throw new ImportError("COMMAND", "编码格式错误。");
          receipts.clear(); controller.decodeKey(command.encoded); break;
        case "edit": {
          receipts.clear();
          const changes: Partial<Candidate> = {};
          for (const field of ["name", "url", "key", "model", "protocol"] as const) {
            const value = command.changes?.[field];
            if (value !== undefined && (typeof value !== "string" || value.length > 8192)) throw new ImportError("COMMAND", "配置格式错误。");
            if (value !== undefined) Object.assign(changes, { [field]: value });
          }
          controller.edit(changes, command.reviewed === true);
          break;
        }
        default: throw new ImportError("COMMAND", "无法识别操作。");
      }
    },
    revealKey() { assertPage(); return controller.revealKey(); },
    revealEncodedKey() { assertPage(); return controller.revealEncodedKey(); },
    dispose() { closed = true; active = false; receipts.clear(); off(); controller.dispose(); },
  };
}
