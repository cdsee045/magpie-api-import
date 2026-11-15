import { afterAll, describe, expect, test } from "bun:test";
import { HttpValidator } from "../../src/validator.ts";
import type { Candidate } from "../../src/types.ts";

const calls: Array<{ path: string; auth: string | null; body?: Record<string, unknown> }> = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req): Promise<Response> {
  const url = new URL(req.url), body = req.method === "POST" ? await req.json() : undefined;
  calls.push({ path: url.pathname, auth: req.headers.get("authorization"), body });
  if (url.pathname.startsWith("/unauthorized")) return Response.json({ error: "must not expose key" }, { status: 401 });
  if (url.pathname.startsWith("/redirect")) return Response.redirect(`${server.url}captured`, 302);
  if (url.pathname.startsWith("/slow")) { await Bun.sleep(100); return Response.json({}); }
  if (url.pathname.startsWith("/stalled-body")) return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
  }), { headers: { "Content-Type": "application/json" } });
  if (url.pathname.startsWith("/fake")) return Response.json({ data: [{ id: "one" }] });
  if (url.pathname.startsWith("/huge")) return new Response(' '.repeat(262_145));
  if (url.pathname.startsWith("/missing")) return new Response("Not found", { status: 404 });
  if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "one" }, { id: "two" }] });
  return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { completion_tokens: 1 } });
} });
const make = (prefix = ""): Candidate => ({ name: "test", url: `${server.url}${prefix}v1`, key: "unit_test_key_123456789", protocol: "chat-completions", model: "one", models: ["one", "two"], needsKeyReview: false });
afterAll(() => server.stop(true));
describe("real HTTP verification", () => {
  test("POSTs a single bounded generation and binds receipt only to selected model", async () => {
    const c = make(), before = calls.length;
    const receipt = await new HttpValidator().validate(c, new AbortController().signal);
    expect(calls.length - before).toBe(1); expect(calls.at(-1)).toMatchObject({ path: "/v1/chat/completions", auth: `Bearer ${c.key}`, body: { model: "one", stream: false, max_tokens: 1 } });
    expect(receipt.model).toBe("one"); expect(receipt.expiresAt - receipt.checkedAt).toBe(300_000);
  });
  test("model list retrieval returns IDs and cannot create a receipt", async () => {
    const models = await new HttpValidator().models(make(), new AbortController().signal);
    expect(models).toEqual(["one", "two"]);
    await expect(new HttpValidator().validate(make("fake/"), new AbortController().signal)).rejects.toMatchObject({ code: "RESPONSE" });
  });
  test("rejects auth failure without propagating server error contents", async () => {
    await expect(new HttpValidator().validate(make("unauthorized/"), new AbortController().signal)).rejects.toMatchObject({ code: "AUTH" });
  });
  test("a missing model-list path suggests the base address and is distinguished from generation failure", async () => {
    await expect(new HttpValidator().models(make("missing/"), new AbortController().signal)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("模型列表接口") });
    await expect(new HttpValidator().validate(make("missing/"), new AbortController().signal)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("接口路径或模型不存在") });
  });
  test("refuses redirects without sending credentials to the target", async () => {
    const start = calls.length;
    await expect(new HttpValidator().validate(make("redirect/"), new AbortController().signal)).rejects.toMatchObject({ code: "NETWORK" });
    expect(calls.slice(start).some(c => c.path === "/captured")).toBe(false);
  });
  test("times out without retries and responds to cancellation", async () => {
    await expect(new HttpValidator(fetch, 20).validate(make("slow/"), new AbortController().signal)).rejects.toMatchObject({ code: "TIMEOUT" });
    const abort = new AbortController(); const pending = new HttpValidator().validate(make("slow/"), abort.signal); abort.abort();
    await expect(pending).rejects.toBeDefined();
  });
  test("the same deadline also bounds a response body that never finishes", async () => {
    const before=calls.length;
    await expect(new HttpValidator(fetch,50).validate(make("stalled-body/"),new AbortController().signal)).rejects.toMatchObject({code:"TIMEOUT"});
    expect(calls.length-before).toBe(1);
  });
  test("rejects an oversized response and does not request unsupported protocols", async () => {
    await expect(new HttpValidator().validate(make("huge/"), new AbortController().signal)).rejects.toMatchObject({ code: "RESPONSE" });
    const start = calls.length;
    await expect(new HttpValidator().validate({ ...make(), protocol: "responses" }, new AbortController().signal)).rejects.toMatchObject({ code: "FIELDS" });
    expect(calls.length).toBe(start);
  });
});
