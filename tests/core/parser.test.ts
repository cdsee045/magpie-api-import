import { describe, expect, test } from "bun:test";
import { parseText } from "../../src/parser.ts";
import { candidateIssues, fingerprint, maskKey, normalizeUrl } from "../../src/security.ts";

const key = "unit_test_key_123456789";
describe("recognition", () => {
  test("JSON extracts fields and normalizes a complete endpoint", () => {
    const result = parseText(JSON.stringify({ name: "测试 API", base_url: "https://api.example.test/v1/chat/completions/", api_key: key, model: "test-model", models: ["other"] }));
    expect(result.candidates[0]).toMatchObject({ name: "测试 API", url: "https://api.example.test/v1", key, protocol: "chat-completions", model: "test-model", models: ["test-model", "other"] });
    expect(candidateIssues(result.candidates[0]!)).toEqual([]);
  });
  test("supports shared fields with explicitly selected multiple JSON keys", () => {
    const { candidates } = parseText(JSON.stringify({ url: "https://api.example.test/v1", model: "one", keys: [{ name: "A", key }, { name: "B", key: key + "B" }] }));
    expect(candidates).toHaveLength(2); expect(candidates[1]).toMatchObject({ name: "B", key: key + "B", model: "one" });
  });
  test("plain text and Chinese headings pair each key with its label", () => {
    const text = `baseurl: https://api.example.test/v1\nmodel: one\nBLG 1:1\nKey(base64): ${Buffer.from(key).toString("base64")}\nBLG 2:1\nKey(base64): ${Buffer.from(key + "B").toString("base64")}`;
    const { candidates } = parseText(text);
    expect(candidates).toHaveLength(2); expect(candidates[0]?.name).toBe("BLG 1:1"); expect(candidates[1]?.name).toBe("BLG 2:1"); expect(candidates[1]?.key).toBe(key + "B");
    expect(candidates.every(c => c.url === "https://api.example.test/v1" && c.model === "one")).toBe(true);
  });
  test("only explicitly labelled Base64 keys are decoded", () => {
    const encoded = Buffer.from(key).toString("base64");
    expect(parseText(`url: https://api.example.test\nkey: ${encoded}`).candidates[0]?.key).toBe(encoded);
    expect(parseText(JSON.stringify({ url: "https://api.example.test", key: encoded, keyEncoding: "base64" })).candidates[0]?.key).toBe(key);
    expect(parseText(`url: https://api.example.test\nKey(base64): invalid%%%`).issues).toContain("Base64 Key 无效，请手动补全。");
  });
  test("unrelated contents are quiet and malformed JSON is actionable", () => {
    expect(parseText("今天是个好日子")).toEqual({ candidates: [], issues: [] });
    expect(parseText('{"unrelated":"hello"}')).toEqual({ candidates: [], issues: [] });
    expect(parseText('{"url":')).toMatchObject({ candidates: [], issues: ["JSON 格式不完整，请修正后重新检测。"] });
  });
  test("masked keys, missing model, unsupported protocol and OCR require correction", () => {
    const c = parseText(`url: https://api.example.test\nkey: sk-******\nprotocol: responses`, true).candidates[0]!;
    expect(candidateIssues(c)).toHaveLength(4);
    expect(c.needsKeyReview).toBe(true);
  });
  test("two separate URL/key pairs retain the correct association", () => {
    const { candidates } = parseText(`url: https://a.example.test/v1\nkey: ${key}\nurl: https://b.example.test/v1\nkey: ${key}B`);
    expect(candidates.map(c => [c.url, c.key])).toEqual([["https://a.example.test/v1", key], ["https://b.example.test/v1", key + "B"]]);
  });
  test("ambiguous addresses are never paired with a guessed URL", () => {
    const { candidates } = parseText(`https://a.example.test/v1 or https://b.example.test/v1\nkey: ${key}`);
    expect(candidates[0]?.url).toBe("");
  });
  test("recognition is bounded and does not execute clipboard text", () => {
    expect(() => parseText("x".repeat(1_048_577))).toThrow();
    expect(parseText('$(Get-Content ~/.ssh/id_rsa)')).toEqual({ candidates: [], issues: [] });
    const result = parseText(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ url: "https://api.example.test", key: key + i }))));
    expect(result.candidates.length).toBeLessThanOrEqual(50);
  });
  test("normalization rejects credential leakage and insecure remote HTTP", () => {
    for (const url of ["javascript:alert(1)", "https://user:password@api.example.test", "https://api.example.test?key=secret", "https://api.example.test/#key", "http://api.example.test"])
      expect(() => normalizeUrl(url)).toThrow();
    expect(normalizeUrl("http://127.0.0.1:1234/v1/chat/completions")).toBe("http://127.0.0.1:1234/v1");
    expect(maskKey(key)).not.toContain(key); expect(maskKey("short")).toBe("••••••••");
  });
  test("verification binding changes with any credential, protocol or model", () => {
    const c = parseText(JSON.stringify({ url: "https://api.example.test/v1", key, model: "one" })).candidates[0]!;
    for (const change of [{ url: "https://other.example.test/v1" }, { key: key + "B" }, { model: "two" }, { protocol: "responses" as const }]) expect(fingerprint({ ...c, ...change })).not.toBe(fingerprint(c));
  });
});
