import { describe, expect, test } from "bun:test";
import { ImportController } from "../../src/controller.ts";
import { fingerprint } from "../../src/security.ts";
import type { Candidate, Clipboard, ImportHost, Ocr, Receipt } from "../../src/types.ts";
import type { Validator } from "../../src/validator.ts";
const candidate: Candidate = { name: "test", url: "https://api.example.test/v1", key: "unit_test_key_123456789", protocol: "chat-completions", model: "one", models: ["one", "two"], needsKeyReview: false };
const clipboard: Clipboard = { kind: "text", text: JSON.stringify(candidate) };
const receipt = (c: Candidate, now = Date.now()): Receipt => ({ fingerprint: fingerprint(c), checkedAt: now, expiresAt: now + 300_000, model: c.model, protocol: "chat-completions" });
function setup(options: { clipboard?: Clipboard; existing?: boolean; validate?: Validator["validate"]; models?: Validator["models"]; read?: ImportHost["readClipboard"]; save?: ImportHost["save"]; now?: () => number } = {}) {
  const counts = { reads: 0, validates: 0, saves: 0, ocr: 0 }, saved: Candidate[] = [];
  let auto = true;
  const host: ImportHost = {
    async readClipboard(signal) { counts.reads++; return options.read ? options.read(signal) : options.clipboard ?? clipboard; },
    async exists() { return options.existing ?? false; },
    async save(c,r,s) { counts.saves++; if (options.save) return options.save(c,r,s); saved.push(c); return { id: "new" }; },
    async getAuto() { return auto; }, async setAuto(v) { auto = v; },
  };
  const validator: Validator = { async validate(c,s) { counts.validates++; return options.validate ? options.validate(c,s) : receipt(c, options.now?.()); }, async models(c,s) { return options.models ? options.models(c,s) : ["one", "two"]; } };
  const ocr: Ocr = { async recognize() { counts.ocr++; return { text: JSON.stringify(candidate), keyReviewRequired: true }; } };
  return { engine: new ImportController(host, validator, ocr, options.now), counts, saved };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
describe("page-scoped import lifecycle", () => {
  test("other pages cannot read clipboard, validate, OCR or save", async () => {
    const { engine, counts } = setup();
    for (const page of ["providers", "provider/editor", "providers/custom", "agents", "settings"]) {
      await engine.setPage(page); await engine.detect(true); await engine.verify(); await engine.confirm();
    }
    expect(counts).toEqual({ reads: 0, validates: 0, saves: 0, ocr: 0 });
  });
  test("successful real validation prompts once, saves once and hides raw key", async () => {
    const { engine, counts, saved } = setup(); await engine.setPage("providers/custom/new");
    expect(engine.snapshot().status).toBe("verified"); expect(counts.saves).toBe(0);
    expect(JSON.stringify(engine.snapshot())).not.toContain(candidate.key);
    expect(await engine.confirm()).toBe(true); expect(await engine.confirm()).toBe(false); expect(saved).toHaveLength(1);
    expect(saved[0]?.models).toEqual(["one", "two"]); expect(engine.snapshot().status).toBe("saved");
  });
  test("an existing config is detected before a paid validation", async () => {
    const { engine, counts } = setup({ existing: true }); await engine.setPage("providers/custom/new");
    expect(engine.snapshot().status).toBe("duplicate"); expect(counts.validates).toBe(0); expect(engine.snapshot().confirmation).toBeNull();
  });
  test("failed verification never asks to add and does not echo a raw error", async () => {
    const { engine, counts } = setup({ validate: async () => { throw new Error(candidate.key); } });
    await engine.setPage("providers/custom/new"); expect(engine.snapshot().status).toBe("failed"); expect(engine.snapshot().confirmation).toBeNull();
    expect(engine.snapshot().message).not.toContain(candidate.key); expect(await engine.confirm()).toBe(false); expect(counts.saves).toBe(0);
  });
  test("cancel suppresses the same content until manual re-detection", async () => {
    const { engine, counts } = setup(); await engine.setPage("providers/custom/new"); engine.dismiss(); await engine.setPage("agents"); await engine.setPage("providers/custom/new");
    expect(engine.snapshot().status).toBe("dismissed"); expect(counts.validates).toBe(1);
    await engine.detect(true); expect(engine.snapshot().confirmation).not.toBeNull();
  });
  test("leaving while reading discards late content and performs no validation", async () => {
    const read = deferred<Clipboard>(); const { engine, counts } = setup({ read: () => read.promise });
    const pending = engine.setPage("providers/custom/new"); await Bun.sleep(0); await engine.setPage("agents"); read.resolve(clipboard); await pending;
    expect(counts.validates).toBe(0); expect(engine.snapshot().confirmation).toBeNull(); expect(engine.revealKey()).toBe("");
  });
  test("leaving during validation aborts and suppresses a late success", async () => {
    const validating = deferred<Receipt>(); let aborted = false;
    const { engine } = setup({ validate: async (_c,s) => { s.addEventListener("abort", () => aborted = true); return validating.promise; } });
    const pending = engine.setPage("providers/custom/new"); await Bun.sleep(0); expect(engine.snapshot().status).toBe("validating");
    await engine.setPage("settings"); validating.resolve(receipt(candidate)); await pending;
    expect(aborted).toBe(true); expect(engine.snapshot().confirmation).toBeNull(); expect(await engine.confirm()).toBe(false);
  });
  test("changing any bound field invalidates the prior receipt", async () => {
    for (const change of [{ url: "https://b.example.test/v1" }, { key: candidate.key + "B" }, { model: "two" }, { protocol: "responses" as const }]) {
      const { engine } = setup(); await engine.setPage("providers/custom/new"); engine.edit(change);
      expect(engine.snapshot().confirmation).toBeNull(); expect(await engine.confirm()).toBe(false);
    }
  });
  test("editing while validation runs suppresses a stale receipt", async () => {
    const validating = deferred<Receipt>(); const { engine } = setup({ validate: () => validating.promise });
    const pending = engine.setPage("providers/custom/new"); await Bun.sleep(0); engine.edit({ model: "two" }); validating.resolve(receipt(candidate)); await pending;
    expect(engine.snapshot().confirmation).toBeNull(); expect(await engine.confirm()).toBe(false);
  });
  test("multiple keys wait for a user selection", async () => {
    const { engine, counts, saved } = setup({ clipboard: { kind: "text", text: JSON.stringify([candidate, { ...candidate, name: "other", key: candidate.key + "B" }]) } });
    await engine.setPage("providers/custom/new"); expect(engine.snapshot().status).toBe("selecting"); expect(counts.validates).toBe(0);
    await engine.select(1); await engine.confirm(); expect(saved[0]?.key).toBe(candidate.key + "B");
  });
  test("OCR credentials require manual review and never silently validate", async () => {
    const { engine, counts } = setup({ clipboard: { kind: "image", png: new Uint8Array([1]) } }); await engine.setPage("providers/custom/new");
    expect(engine.snapshot().status).toBe("review"); expect(counts.validates).toBe(0); expect(engine.revealKey()).toBe(candidate.key);
    engine.edit({}, true); await engine.verify(); expect(engine.snapshot().confirmation).not.toBeNull();
  });
  test("only model list retrieval never authorizes adding", async () => {
    const { engine } = setup({ clipboard: { kind: "text", text: JSON.stringify({ ...candidate, model: "", models: [] }) } });
    await engine.setPage("providers/custom/new"); await engine.loadModels(); expect(engine.snapshot().status).toBe("incomplete"); expect(await engine.confirm()).toBe(false);
  });
  test("a New API connection without a model discovers the list but never guesses or makes a paid call", async () => {
    let lists = 0;
    const { engine, counts } = setup({ clipboard: { kind: "text", text: JSON.stringify({ _type: "newapi_channel_conn", url: "https://api.example.test", key: candidate.key }) }, models: async c => { lists++; expect(c.url).toBe("https://api.example.test/v1"); return ["one", "two"]; } });
    await engine.setPage("providers/custom/new");
    expect(lists).toBe(1); expect(counts.validates).toBe(0); expect(engine.snapshot().candidates[0]?.model).toBe("");
    expect(engine.snapshot().candidates[0]?.models).toEqual(["one", "two"]);
    expect(engine.snapshot().message).toContain("已获取 2 个模型"); expect(await engine.confirm()).toBe(false);
    engine.edit({ model: "two" }); await engine.verify(); expect(counts.validates).toBe(1); expect(engine.snapshot().confirmation?.model).toBe("two");
  });
  test("leaving during automatic model discovery drops the late list", async () => {
    const list = deferred<string[]>();
    const { engine, counts } = setup({ clipboard: { kind: "text", text: JSON.stringify({ ...candidate, model: "", models: [] }) }, models: () => list.promise });
    const pending = engine.setPage("providers/custom/new"); await Bun.sleep(0); await engine.setPage("agents"); list.resolve(["one"]); await pending;
    expect(engine.snapshot().candidates).toHaveLength(0); expect(counts.validates).toBe(0);
  });
  test("missing key or unsupported protocol cannot start automatic model discovery", async () => {
    let lists = 0;
    for (const changes of [{ key: "" }, { protocol: "responses" }]) {
      const { engine, counts } = setup({ clipboard: { kind: "text", text: JSON.stringify({ ...candidate, ...changes, model: "", models: [] }) }, models: async () => { lists++; return ["one"]; } });
      await engine.setPage("providers/custom/new"); expect(counts.validates).toBe(0); engine.dispose();
    }
    expect(lists).toBe(0);
  });
  test("manual model listing also waits for OCR key review", async () => {
    let lists = 0;
    const { engine } = setup({ clipboard: { kind: "image", png: new Uint8Array([1]) }, models: async () => { lists++; return ["one"]; } });
    await engine.setPage("providers/custom/new"); await engine.loadModels(); expect(lists).toBe(0); expect(engine.snapshot().status).toBe("review");
    engine.edit({}, true); await engine.loadModels(); expect(lists).toBe(1);
  });
  test("automatic detection can be disabled and explicit re-detection works", async () => {
    const { engine, counts } = setup(); await engine.setAuto(false); await engine.setPage("providers/custom/new"); expect(counts.reads).toBe(0);
    await engine.detect(true); expect(engine.snapshot().status).toBe("verified");
  });
  test("expired verification cannot be saved", async () => {
    let now = Date.now(); const { engine } = setup({ now: () => now }); await engine.setPage("providers/custom/new"); now += 300_001;
    expect(await engine.confirm()).toBe(false); expect(engine.snapshot().status).toBe("incomplete");
  });
  test("rapid double confirmation starts only one save", async () => {
    const wait = deferred<{ id: string }>(); const { engine, counts } = setup({ save: () => wait.promise }); await engine.setPage("providers/custom/new");
    const first = engine.confirm(); const second = engine.confirm(); await Bun.sleep(0); expect(counts.saves).toBe(1); wait.resolve({ id: "new" });
    expect(await first).toBe(true); expect(await second).toBe(false);
  });
  test("manual retry uses newly read content and disposal drops all sensitive state", async () => {
    const { engine } = setup(); await engine.setPage("providers/custom/new"); engine.dispose();
    expect(engine.snapshot().candidates).toHaveLength(0); expect(engine.revealKey()).toBe(""); await engine.detect(true); expect(await engine.confirm()).toBe(false);
  });
  test("unrelated clipboard contents remain quiet on repeated page entry", async () => {
    const { engine } = setup({ clipboard: { kind: "text", text: "只是普通笔记" } });
    await engine.setPage("providers/custom/new"); await engine.setPage("agents"); await engine.setPage("providers/custom/new");
    expect(engine.snapshot().status).toBe("idle"); expect(engine.snapshot().message).toBe("");
  });
  test("same credentials with different formatting do not trigger another automatic call", async () => {
    let reads = 0;
    const { engine, counts } = setup({ read: async () => ({ kind: "text", text: JSON.stringify(candidate, null, ++reads === 1 ? 0 : 2) }) });
    await engine.setPage("providers/custom/new"); engine.dismiss(); await engine.setPage("agents"); await engine.setPage("providers/custom/new");
    expect(counts.validates).toBe(1); expect(engine.snapshot().confirmation).toBeNull();
  });
});
