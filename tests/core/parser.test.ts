import { describe, expect, test } from "bun:test";
import { parseText } from "../../src/parser.ts";
import { candidateIssues, fingerprint, maskKey, normalizeUrl } from "../../src/security.ts";
import { sharedText, keys as sharedKeys, models as sharedModels, urls as sharedUrls } from "../fixtures/shared-api.mjs";

const key = "unit_test_key_123456789";
describe("recognition", () => {
  test("numbered wrapped Base64 keys retain their own models and offer both preamble URLs", () => {
    const { candidates } = parseText(sharedText(), true);
    expect(candidates).toHaveLength(3);
    for (const [i, c] of candidates.entries()) {
      expect(c.name).toBe(`Key ${i + 1}`); expect(c.key).toBe(sharedKeys[i]!);
      expect(c.models).toEqual(sharedModels[i]!); expect(c.url).toBe("");
      expect(c.urlOptions).toEqual(sharedUrls); expect(c.needsKeyReview).toBe(true);
    }
  });
  test("OCR URL icons/labels and whitespace in explicit encoded blocks are supported", () => {
    const text = sharedText().replace("url: ↗", "urlLZ").replace("url（CDN加速）： ↗", "url (CDN 加 速 ) : 四").replace("key2(BASE64):", "API Key 2（ BASE64 ）：").replace(/(c2st\w{12})/g, "$1 ");
    const { candidates } = parseText(text, true);
    expect(candidates.map(c => c.key)).toEqual(sharedKeys);
    expect(candidates.every(c => c.urlOptions?.length === 2 && !c.url)).toBe(true);
  });
  test("failed OCR Base64 remains editable without inventing a decoded credential", () => {
    const { candidates, issues } = parseText(sharedText().replace(/c2st/g, "c2st%%%").replace(/可用模型:.*/g, "可用模型: same-model"), true);
    expect(candidates).toHaveLength(3); expect(candidates.every(c => !c.key && c.encodedKey?.startsWith("c2st%%%"))).toBe(true);
    expect(issues).toContain("Base64 Key 无效，请手动补全。");
  });
  test("unpadded Base64 does not absorb the following English heading", () => {
    const encoded = Buffer.from("sk-fixture_official_key_123456789").toString("base64");
    expect(encoded).not.toEndWith("=");
    const result = parseText(`url: https://api.example.test/v1\nFirst fixture\nKey(base64): ${encoded}\nSecond fixture\nKey: sk-fixture_second_123456789`);
    expect(result.candidates.map(c => c.name)).toEqual(["First fixture", "Second fixture"]);
    expect(result.candidates[0]?.key).toBe("sk-fixture_official_key_123456789");
  });
  test("JSON extracts fields and normalizes a complete endpoint", () => {
    const result = parseText(JSON.stringify({ name: "测试 API", base_url: "https://api.example.test/v1/chat/completions/", api_key: key, model: "test-model", models: ["other"] }));
    expect(result.candidates[0]).toMatchObject({ name: "测试 API", url: "https://api.example.test/v1", key, protocol: "chat-completions", model: "test-model", models: ["test-model", "other"] });
    expect(candidateIssues(result.candidates[0]!)).toEqual([]);
  });
  test("New API connection JSON expands a site root to /v1 and leaves model selection pending", () => {
    for (const url of ["https://new-api.example.test", "https://new-api.example.test/"]) {
      const c = parseText(JSON.stringify({ _type: "newapi_channel_conn", key, url })).candidates[0]!;
      expect(c).toMatchObject({ url: "https://new-api.example.test/v1", key, model: "", models: [] });
      expect(candidateIssues(c)).toEqual(["请选择或填写要验证的模型。"]);
    }
  });
  test("New API explicit paths are preserved and unmarked roots do not gain /v1", () => {
    for (const path of ["/v1", "/gateway/v1", "/custom"]) {
      expect(parseText(JSON.stringify({ _type: "newapi_channel_conn", key, url: "https://api.example.test" + path })).candidates[0]?.url).toBe("https://api.example.test" + path);
    }
    for (const extra of [{}, { type: "newapi_channel_conn" }, { _type: "another_format" }])
      expect(parseText(JSON.stringify({ ...extra, key, url: "https://api.example.test" })).candidates[0]?.url).toBe("https://api.example.test");
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
  test("one URL is shared by inline and next-line Base64 keys without losing headings", () => {
    const keys = [key, key + "B", key + "C"];
    const text = `baseurl: https://api.example.test/v1\n第一组\nKey(base64): ${Buffer.from(keys[0]!).toString("base64")}\n第二组\nKey(base64):\n\n${Buffer.from(keys[1]!).toString("base64")}\n第三组\nKey（base64）：\n\`${Buffer.from(keys[2]!).toString("base64")}\``;
    const result = parseText(text);
    expect(result.issues).toEqual([]);
    expect(result.candidates.map(c => [c.name, c.url, c.key, c.model])).toEqual(keys.map((k, i) => [["第一组", "第二组", "第三组"][i]!, "https://api.example.test/v1", k, ""]));
  });
  test("multiple plain keys and mixed encodings share a URL and model", () => {
    const keys = ["sk-fixture_first_123456789", "sk-fixture_second_123456789", "sk-fixture_third_123456789", "sk-fixture_fourth_123456789"];
    const { candidates, issues } = parseText(`baseurl: https://api.example.test/v1\nmodel: one\nKey(base64):\n${Buffer.from(keys[0]!).toString("base64")}\nKey:\n${keys[1]}\n${keys[2]}\nAPI Key: ${keys[3]}`);
    expect(issues).toEqual([]);
    expect(candidates.map(c => c.key)).toEqual(keys);
    expect(candidates.every(c => c.url === "https://api.example.test/v1" && c.model === "one")).toBe(true);
  });
  test("shared URLs stay with their own group when several groups have multiple keys", () => {
    const { candidates } = parseText(`url: https://a.example.test/v1\nkey: ${key}\nkey: ${key}B\nurl: https://b.example.test/v1\nkey: ${key}C\nkey: ${key}D`);
    expect(candidates.map(c => [c.url, c.key])).toEqual([["https://a.example.test/v1", key], ["https://a.example.test/v1", key + "B"], ["https://b.example.test/v1", key + "C"], ["https://b.example.test/v1", key + "D"]]);
  });
  test("a missing next-line Base64 value cannot consume another field or heading", () => {
    const { candidates, issues } = parseText(`url: https://api.example.test/v1\nKey(base64):\n下一条\nkey: ${key}\nKey(base64):\nmodel: one\nkey: ${key}B`);
    expect(issues).toContain("Base64 Key 无效，请手动补全。");
    expect(candidates.filter(c => c.key).map(c => c.key)).toEqual([key, key + "B"]);
    expect(candidates.find(c => c.key === key)?.name).toBe("下一条");
  });
  test("explicit Base64 accepts omitted padding but rejects malformed data", () => {
    const encoded = Buffer.from(key + "AB").toString("base64");
    expect(encoded).toEndWith("=");
    for (const value of [encoded, encoded.replace(/=+$/, "")]) {
      expect(parseText(`url: https://api.example.test/v1\nKey(base64):\n${value}`).candidates[0]?.key).toBe(key + "AB");
      expect(parseText(JSON.stringify({ url: "https://api.example.test/v1", keyBase64: value })).candidates[0]?.key).toBe(key + "AB");
    }
    for (const value of ["Z", "Zh==", "Zg=", "Zg===", "%%%", "/w==", "c2stZml4dHVyZQ== trailing"]) {
      const result = parseText(`url: https://api.example.test/v1\nKey(base64): ${value}`);
      expect(result.candidates[0]?.key).toBe("");
      expect(result.issues).toContain("Base64 Key 无效，请手动补全。");
    }
  });
  test("explicit literal key fields are not auto-decoded", () => {
    const encoded = Buffer.from(key).toString("base64");
    expect(parseText(`url: https://api.example.test\nkey: ${encoded}`).candidates[0]?.key).toBe(encoded);
    expect(parseText(JSON.stringify({ url: "https://api.example.test", key: encoded, keyEncoding: "base64" })).candidates[0]?.key).toBe(key);
    expect(parseText(`url: https://api.example.test\nKey(base64): invalid%%%`).issues).toContain("Base64 Key 无效，请手动补全。");
  });
  test("an inline URL and unlabelled Base64 sk-key are separated and require review", () => {
    const fixtureKey = "sk-fixture_inline_123456789";
    const encoded = Buffer.from(fixtureKey).toString("base64");
    for (const prefix of ["url:", "baseurl: ", ""]) {
      const { candidates, issues } = parseText(`${prefix}https://api.example.test/ ${encoded}`);
      expect(issues).toEqual([]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ name: "我的 API", url: "https://api.example.test", key: fixtureKey, model: "", needsKeyReview: true });
      expect(candidateIssues(candidates[0]!, false)).toEqual(["识别的 Key 需要核对后确认，插件不会猜测字符。"]);
    }
  });
  test("unlabelled encoded keys share their URL without changing explicit literal keys", () => {
    const first = "sk-fixture_inferred_first_123456789", second = "sk-fixture_inferred_second_123456789";
    const encoded = Buffer.from(first).toString("base64");
    const { candidates } = parseText(`url: https://a.example.test/v1 ${encoded}\n第二条\n${Buffer.from(second).toString("base64")}\nkey: ${encoded}\nurl: https://b.example.test/v1 sk-fixture_plain_123456789`);
    expect(candidates.map(c => [c.url, c.key, c.needsKeyReview])).toEqual([["https://a.example.test/v1", first, true], ["https://a.example.test/v1", second, true], ["https://a.example.test/v1", encoded, false], ["https://b.example.test/v1", "sk-fixture_plain_123456789", false]]);
    expect(candidates[1]?.name).toBe("第二条");
    expect(parseText(JSON.stringify({ url: "https://a.example.test/v1", key: encoded })).candidates[0]?.key).toBe(encoded);
    expect(parseText(`url: https://a.example.test/v1\nkeyEncoding: base64\n${encoded}`).candidates[0]?.key).toBe(first);
  });
  test("inline multiple encoded keys remain separate candidates", () => {
    const keys = ["sk-fixture_inline_first_123456789", "sk-fixture_inline_second_123456789"];
    const result = parseText(`url: https://api.example.test/v1 ${keys.map(k => Buffer.from(k).toString("base64")).join(" ")}`);
    expect(result.candidates.map(c => c.key)).toEqual(keys);
    expect(result.candidates.every(c => c.url === "https://api.example.test/v1" && c.needsKeyReview)).toBe(true);
  });
  test("unlabelled random or malformed Base64 is not treated as a credential or URL path", () => {
    for (const value of [Buffer.from(key).toString("base64"), "c2st%%%", "c2stZml4dHVyZQ===", Buffer.from("sk-x").toString("base64")]) {
      const { candidates } = parseText(`url:https://api.example.test/ ${value}`);
      expect(candidates[0]).toMatchObject({ url: "https://api.example.test", key: "", needsKeyReview: false });
      expect(candidates[0]?.url).not.toContain(value);
    }
    expect(parseText(Buffer.from("sk-fixture_without_url_123456789").toString("base64"))).toEqual({ candidates: [], issues: [] });
    const ambiguous = parseText(`url: https://a.example.test/v1 or https://b.example.test/v1\nkey: ${key}`);
    expect(ambiguous.candidates[0]?.url).toBe("");
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
    for (const url of ["javascript:alert(1)", "https://user:password@api.example.test", "https://api.example.test?key=secret", "https://api.example.test/#key", "http://api.example.test", "https://api.example.test/ fixture-token", "https://api.example.test/\nfixture-token"])
      expect(() => normalizeUrl(url)).toThrow();
    expect(normalizeUrl("http://127.0.0.1:1234/v1/chat/completions")).toBe("http://127.0.0.1:1234/v1");
    expect(maskKey(key)).not.toContain(key); expect(maskKey("short")).toBe("••••••••");
  });
  test("verification binding changes with any credential, protocol or model", () => {
    const c = parseText(JSON.stringify({ url: "https://api.example.test/v1", key, model: "one" })).candidates[0]!;
    for (const change of [{ url: "https://other.example.test/v1" }, { key: key + "B" }, { model: "two" }, { protocol: "responses" as const }]) expect(fingerprint({ ...c, ...change })).not.toBe(fingerprint(c));
  });
});
