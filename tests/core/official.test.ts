import { describe, expect, test } from "bun:test";
import plugin from "../../index.ts";
import { startBrowserFlow } from "../../src/browser-flow.ts";
import { loaderFor, makeAuth, modelsFor, PROVIDER_ID, readAuth } from "../../src/official-auth.ts";
import { fingerprint } from "../../src/security.ts";
import type { Candidate, ViewState } from "../../src/types.ts";

const candidate: Candidate = { name: "我的 API", url: "https://api.example.test/v1", key: "fixture_import_key_123456789", protocol: "chat-completions", model: "shared-model", models: ["shared-model", "unverified-model"], needsKeyReview: false };
const receipt = (c = candidate) => ({ fingerprint: fingerprint(c), model: c.model, protocol: "chat-completions" as const, checkedAt: Date.now(), expiresAt: Date.now() + 300_000 });
const savedAuth = (c = candidate) => ({ ...makeAuth(c, receipt(c)), type: "api" as const });

async function flowCall(url: string, path: string, body?: unknown, extra: HeadersInit = {}) {
  return fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST", headers: { Origin: new URL(url).origin, "X-API-Import": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function state(url: string) { const r = await flowCall(url, "state"); expect(r.status).toBe(200); return r.json() as Promise<ViewState>; }

describe("official Magpie provider hooks", () => {
  test("registers real auth/config/models hooks without starting an import on load", async () => {
    const hooks = await plugin();
    expect(hooks.auth.provider).toBe(PROVIDER_ID);
    expect(hooks.auth.methods[0]?.type).toBe("oauth");
    const custom = { name: "保留用户配置" }, cfg = { provider: { [PROVIDER_ID]: custom } };
    await hooks.config(cfg); expect(cfg.provider[PROVIDER_ID]).toBe(custom);
    expect(await hooks.provider.models({})).toEqual({});
  });
  test("only the bound verified model is persisted, with no raw key in metadata", () => {
    const auth = savedAuth(); expect(auth.metadata.model).toBe(candidate.model);
    expect(JSON.stringify(auth.metadata)).not.toContain(candidate.key);
    expect(JSON.stringify(auth.metadata)).not.toContain("unverified-model");
    const encoded = Buffer.from(candidate.key).toString("base64");
    expect(JSON.stringify(savedAuth({ ...candidate, encodedKey: encoded }).metadata)).not.toContain(encoded);
    expect(() => makeAuth(candidate, { ...receipt(), model: "other" })).toThrow();
    expect(() => makeAuth(candidate, { ...receipt(), expiresAt: 0 })).toThrow();
    expect(() => readAuth({ ...auth, key: "another_fixture_key_123456" })).toThrow();
  });
  test("same-named models on different URLs or keys never share a routing id", () => {
    const one = modelsFor(savedAuth());
    const two = modelsFor(savedAuth({ ...candidate, url: "https://other.example.test/v1" }));
    const three = modelsFor(savedAuth({ ...candidate, key: "different_fixture_key_123456789" }));
    expect(Object.keys(one)).toHaveLength(1);
    expect(Object.keys(one)[0]).not.toBe(Object.keys(two)[0]);
    expect(Object.keys(one)[0]).not.toBe(Object.keys(three)[0]);
    expect(modelsFor(savedAuth())).toEqual(one);
    expect(JSON.stringify(one)).not.toContain(candidate.key);
    expect(Object.values(one)[0]).toMatchObject({ api: { id: candidate.model, url: candidate.url } });
  });
  test("loader restricts destinations, attaches only the current key, and never follows redirects", async () => {
    let count = 0;
    const loader = loaderFor(savedAuth(), (async (input, init) => {
      count++; expect((input as Request).url).toBe(candidate.url + "/chat/completions");
      const headers = new Headers(init?.headers); expect(headers.get("authorization")).toBe("Bearer " + candidate.key);
      expect(headers.has("cookie")).toBe(false); expect(headers.has("x-api-key")).toBe(false);
      expect(init?.redirect).toBe("error");
      return Response.json({ error: { message: candidate.key } }, { status: 401 });
    }) as typeof fetch);
    expect((await loader.fetch("https://other.example.test/v1/chat/completions", { method: "POST", body: "{}" })).status).toBe(400);
    expect(count).toBe(0);
    const failed = await loader.fetch(candidate.url + "/chat/completions", { method: "POST", body: "{}", headers: { cookie: "private", "x-api-key": "unrelated" } });
    expect(failed.status).toBe(401); expect(await failed.text()).not.toContain(candidate.key); expect(count).toBe(1);
  });
});

describe("explicit, short-lived browser import", () => {
  test("encoded credentials are private, editable and revoked on navigation", async () => {
    let validates = 0, lists = 0;
    const encoded = Buffer.from(candidate.key).toString("base64");
    const flow = await startBrowserFlow({ validator: { async models() { lists++; return [candidate.model]; }, async validate(c) { validates++; return receipt(c); } } });
    try {
      await flowCall(flow.url, "input", { kind: "text", text: `url: ${candidate.url}\nKey1(BASE64): invalid%%%\nmodel: ${candidate.model}` });
      await flowCall(flow.url, "command", { type: "detect" });
      const publicState = await state(flow.url); expect(publicState.candidates[0]?.hasEncodedKey).toBe(true);
      expect(JSON.stringify(publicState)).not.toContain("invalid%%%");
      expect((await flowCall(flow.url, "encoded-key", {}, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await (await flowCall(flow.url, "encoded-key", {})).json()).encoded).toBe("invalid%%%");
      expect((await flowCall(flow.url, "command", { type: "decode", encoded: 123 })).status).toBe(400);
      await flowCall(flow.url, "command", { type: "decode", encoded });
      const reviewed = await state(flow.url); expect(reviewed.status).toBe("review");
      expect(JSON.stringify(reviewed)).not.toContain(encoded); expect(JSON.stringify(reviewed)).not.toContain(candidate.key);
      await flowCall(flow.url, "command", { type: "models" }); await flowCall(flow.url, "command", { type: "verify" });
      expect(lists).toBe(0); expect(validates).toBe(0);
      await flowCall(flow.url, "command", { type: "edit", changes: {}, reviewed: true });
      await flowCall(flow.url, "command", { type: "verify" }); expect(validates).toBe(1);
      await flowCall(flow.url, "command", { type: "decode", encoded: "%%%" });
      expect((await state(flow.url)).confirmation).toBeNull();
      await flowCall(flow.url, "suspend", {}); expect((await flowCall(flow.url, "encoded-key", {})).status).toBe(409);
    } finally { await flow.close(); }
  });
  test("real HTTP validation plus one confirmation yields official API auth, never a disk/config write", async () => {
    let requests = 0;
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { requests++; expect(request.headers.get("authorization")).toBe("Bearer " + candidate.key); return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] }); } });
    const flow = await startBrowserFlow();
    try {
      expect((await state(flow.url)).candidates).toHaveLength(0); expect(requests).toBe(0);
      await flowCall(flow.url, "command", { type: "confirm" }); expect(requests).toBe(0);
      const current = { ...candidate, url: `http://127.0.0.1:${api.port}/v1` };
      expect((await flowCall(flow.url, "input", { kind: "text", text: JSON.stringify(current) })).status).toBe(200);
      expect((await flowCall(flow.url, "command", { type: "detect" })).status).toBe(200);
      const checked = await state(flow.url); expect(checked.status).toBe("verified"); expect(requests).toBe(1);
      expect(JSON.stringify(checked)).not.toContain(candidate.key);
      expect((await flowCall(flow.url, "command", { type: "confirm" })).status).toBe(200);
      const result = await flow.result; expect(result.type).toBe("success");
      if (result.type === "success") { expect(result.key).toBe(candidate.key); expect(result.metadata.model).toBe(candidate.model); }
      expect((await state(flow.url)).message).toContain("提交给 Magpie");
      expect((await flowCall(flow.url, "command", { type: "confirm" })).status).toBe(409);
    } finally { await flow.close(); api.stop(true); }
  });
  test("cross-origin, missing capability, invalid commands and oversized text are refused", async () => {
    const flow = await startBrowserFlow();
    try {
      expect((await fetch(new URL("/state", flow.url))).status).toBe(404);
      expect((await fetch(new URL("state", flow.url))).status).toBe(403);
      expect((await flowCall(flow.url, "key", {}, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await flowCall(flow.url, "command", { type: "auto", value: true })).status).toBe(400);
      expect((await flowCall(flow.url, "input", { kind: "text", text: "x".repeat(1_048_577) })).status).toBe(400);
      expect((await flowCall(flow.url, "input", { kind: "image", png: "not-base64!" })).status).toBe(400);
    } finally { await flow.close(); }
  });
  test("navigation revokes key access and confirmation, resume never reads input automatically", async () => {
    const flow = await startBrowserFlow({ validator: { async models() { return []; }, async validate(c) { return receipt(c); } } });
    try {
      await flowCall(flow.url, "input", { kind: "text", text: JSON.stringify(candidate) });
      await flowCall(flow.url, "command", { type: "detect" }); expect((await state(flow.url)).status).toBe("verified");
      await flowCall(flow.url, "suspend", {}); expect((await state(flow.url)).confirmation).toBeNull();
      expect((await flowCall(flow.url, "key", {})).status).toBe(409);
      await flowCall(flow.url, "resume", {}); expect((await state(flow.url)).candidates).toHaveLength(0);
      await flowCall(flow.url, "cancel", {}); expect((await flow.result).type).toBe("failed");
    } finally { await flow.close(); }
  });
  test("official callback cancellation closes a pending import and returns no credential", async () => {
    const flow = await startBrowserFlow();
    const controller = new AbortController(), waiting = flow.wait(controller.signal);
    controller.abort(); const result = await waiting;
    expect(result.type).toBe("failed"); expect(JSON.stringify(result)).not.toContain(candidate.key);
    await flow.close();
  });
  test("OCR input requires manual key review before any external validation", async () => {
    let validates = 0;
    const flow = await startBrowserFlow({ ocr: { async recognize() { return { text: JSON.stringify(candidate), keyReviewRequired: true }; } }, validator: { async models() { return []; }, async validate(c) { validates++; return receipt(c); } } });
    try {
      await flowCall(flow.url, "input", { kind: "image", png: Buffer.from("fixture image").toString("base64") });
      await flowCall(flow.url, "command", { type: "detect" });
      expect((await state(flow.url)).status).toBe("review"); expect(validates).toBe(0);
    } finally { await flow.close(); }
  });
});
