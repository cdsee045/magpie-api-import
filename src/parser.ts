import { ImportError, keyIssue, normalizeUrl } from "./security.ts";
import type { Candidate, Protocol, Recognition } from "./types.ts";

const urlFields = ["url", "baseurl", "apiurl", "apiaddress", "endpoint", "api", "地址", "接口地址", "api地址"];
const keyFields = ["key", "apikey", "token", "密钥", "秘钥", "apikeybase64", "keybase64"];
const normalized = (s: string) => s.toLowerCase().replace(/[\s_\-()（）]/g, "");
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const unquote = (value: string) => value.trim().replace(/^([`'"])([\s\S]*)\1$/, "$2").trim();
const urlsIn = (text: string) => [...new Set((text.match(/https?:\/\/[^\s<>"'`，；（）\[\]【】]+/gi) || []).map(u => u.replace(/[.,;，。；]+$/, "")))];
function keyLabel(label: string): { field: string; name?: string } | null {
  if (keyFields.includes(label)) return { field: label };
  const numbered = /^(key|apikey|token|密钥|秘钥)(\d+)(base64)?$/.exec(label);
  return numbered ? { field: numbered[3] ? "keybase64" : numbered[1]!, name: `Key ${numbered[2]}` } : null;
}
const urlLabel = (label: string) => urlFields.includes(label) || /^(?:url|baseurl|apiurl)(?:cdn(?:加速)?|主站|备用|加速)$/.test(label);
function protocol(value: string): Protocol {
  if (!value || /^(?:openai(?:-compatible)?|chat(?:[- ]?completions)?|兼容openai)$/i.test(value)) return "chat-completions";
  if (/responses/i.test(value)) return "responses";
  if (/anthropic|messages|claude/i.test(value)) return "anthropic";
  return "unknown";
}
export function decodeBase64Key(value: string): string {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) throw new ImportError("BASE64", "Base64 Key 无效，请手动补全。");
  const bytes = Buffer.from(value, "base64");
  // Explicitly labelled Base64 may omit padding; still reject noncanonical
  // padding/bits rather than letting Buffer silently accept malformed input.
  const canonical = bytes.toString("base64");
  if ((value.includes("=") ? canonical : canonical.replace(/=+$/, "")) !== value) throw new ImportError("BASE64", "Base64 Key 无效，请手动补全。");
  const result = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (keyIssue(result)) throw new ImportError("BASE64", "Base64 解码后 Key 无效，请手动补全。");
  return result;
}
function bareKey(value: string, allowEncoded: boolean): { field: "key" | "keybase64"; value: string; review: boolean } | null {
  value = unquote(value);
  if (/^sk-[A-Za-z0-9_-]+$/.test(value)) return { field: "key", value, review: false };
  if (!allowEncoded || !value.startsWith("c2st") || value.length > 11_000) return null;
  try {
    const key = decodeBase64Key(value);
    // Unlabelled data is only a candidate when it decodes to a recognizable
    // sk-key. Require review before sending this inferred credential anywhere.
    if (/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) return { field: "keybase64", value, review: true };
  } catch { /* Unlabelled arbitrary/malformed Base64 is never a guessed Key. */ }
  return null;
}
function candidate(record: Record<string, unknown>, inherited: Record<string, unknown> = {}): { value: Candidate; issues: string[] } {
  const map = Object.fromEntries(Object.entries({ ...inherited, ...record }).map(([k, v]) => [normalized(k), v]));
  const get = (fields: string[]) => fields.map(k => map[k]).find(v => v !== undefined);
  const rawUrl = string(get(urlFields));
  let url = rawUrl, key = string(get(keyFields));
  const issues: string[] = [];
  if (rawUrl) {
    try {
      url = normalizeUrl(rawUrl);
      // New API's copied connection object carries a site root, while its
      // OpenAI endpoints live below /v1. Preserve explicit/custom paths and
      // never add this convention to an arbitrary unmarked API URL.
      if ((record._type ?? inherited._type) === "newapi_channel_conn" && new URL(url).pathname === "/") url += "/v1";
    } catch (e) { issues.push((e as Error).message); }
  }
  let encodedKey: string | undefined;
  if (map.keybase64 !== undefined || map.apikeybase64 !== undefined || /base64/i.test(string(map.keyencoding ?? map.encoding))) {
    encodedKey = string(map.keybase64 ?? map.apikeybase64 ?? key);
    try { key = decodeBase64Key(encodedKey); }
    catch { key = ""; issues.push("Base64 Key 无效，请手动补全。"); }
  }
  const rawModels = map.models;
  const models = Array.isArray(rawModels) ? rawModels.map(m => typeof m === "string" ? m.trim() : string((m as Record<string, unknown>)?.id)).filter(Boolean) : string(rawModels).split(/[,，;；|｜]/).map(m => m.trim()).filter(Boolean);
  const model = string(map.model ?? map.模型) || models[0] || "";
  if (model && !models.includes(model)) models.unshift(model);
  return { value: { name: string(map.name ?? map.名称 ?? map.供应商) || "我的 API", url, key, ...(encodedKey !== undefined ? { encodedKey } : {}), protocol: protocol(string(map.protocol ?? map.协议) || (/\/responses\/?$/.test(rawUrl) ? "responses" : /\/messages\/?$/.test(rawUrl) ? "anthropic" : "")), model, models: [...new Set(models)].slice(0, 100), needsKeyReview: false }, issues };
}

export function parseText(text: string, image = false): Recognition {
  if (text.length > 1_048_576) throw new ImportError("SIZE", "剪贴板文本超过 1 MB，请缩小内容后重试。");
  text = text.replace(/^\uFEFF/, "").trim();
  // OCR may insert spaces between scheme punctuation. Only repair that fixed
  // prefix on URL-labelled image lines; never join arbitrary URL/key tokens.
  if (image) text = text.split(/\r?\n/).map(line => /^\s*(?:url|baseurl|https?\s*:)/i.test(line) ? line.replace(/\b(https?)\s*:\s*\/\s*\/\s*/gi, "$1://") : line).join("\n");
  if (!text) return { candidates: [], issues: [] };
  const records: Array<{ record: Record<string, unknown>; inherited?: Record<string, unknown>; review?: boolean; urls?: string[] }> = [];
  const issues: string[] = [];
  if (/^[\[{]/.test(text)) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { candidates: [], issues: ["JSON 格式不完整，请修正后重新检测。"] }; }
    function walk(value: unknown, inherited: Record<string, unknown> = {}, depth = 0): void {
      if (depth > 12 || records.length >= 50) return;
      if (Array.isArray(value)) { for (const v of value) walk(v, inherited, depth + 1); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      const own = Object.fromEntries(Object.entries(record).filter(([, v]) => typeof v === "string"));
      const fields = Object.keys(record).map(normalized);
      if (fields.some(k => keyFields.includes(k)) && !Array.isArray(record.keys)) records.push({ record, inherited });
      else {
        if (Array.isArray(record.keys)) {
          for (const key of record.keys.slice(0, 50)) records.push({ record: typeof key === "string" ? { key } : key as Record<string, unknown>, inherited: { ...inherited, ...own, models: record.models } });
        }
        for (const [k, v] of Object.entries(record)) if (k !== "keys" && v && typeof v === "object") walk(v, { ...inherited, ...own, models: record.models ?? inherited.models }, depth + 1);
        if (!records.length && fields.some(k => urlFields.includes(k))) records.push({ record, inherited });
      }
    }
    walk(parsed);
  } else {
    const lines = text.split(/\r?\n/);
    const urls = urlsIn(text);
    const global: Record<string, unknown> = {};
    if (urls.length === 1) global.url = urls[0];
    let current: Record<string, unknown> = {};
    let pendingName = "";
    let pendingKey = "";
    let sharedUrls: string[] = [];
    let review = false;
    let seenKey = false;
    function flush(): void {
      if (Object.keys(current).length) {
        records.push({ record: current, inherited: { ...global, ...(sharedUrls.length ? { url: sharedUrls.length === 1 ? sharedUrls[0] : "" } : {}) }, review, urls: sharedUrls.length > 1 ? [...sharedUrls] : undefined });
        current = {}; review = false;
      }
    }
    function appendKey(label: string, value: string, inferred = false): void {
      if (seenKey) flush();
      current[label] = value;
      pendingKey = !value || (label.endsWith("base64") && !inferred && !value.endsWith("=")) ? label : "";
      if (pendingName && current.name === undefined) current.name = pendingName;
      pendingName = ""; seenKey = true; review = inferred;
    }
    function urlLine(value: string): void {
      if (seenKey) { flush(); seenKey = false; sharedUrls = []; }
      const foundUrls = urlsIn(value);
      // Separate an inline credential before URL normalization, which would
      // otherwise percent-encode the space and put the credential in the path.
      if (foundUrls.length !== 1) { current.url = foundUrls.length ? "" : value; sharedUrls = []; return; }
      const url = foundUrls[0]!;
      sharedUrls = [...new Set([...sharedUrls, url])].slice(0, 20);
      current.url = sharedUrls.length === 1 ? url : "";
      const rest = value.slice(value.indexOf(url) + url.length).trim().split(/\s+/);
      for (const part of rest) {
        const found = bareKey(part, true);
        if (found) appendKey(found.field, found.value, found.review);
      }
    }
    for (const raw of lines) {
      const line = raw.trim().replace(/^[-*]\s+/, "");
      if (!line || /^```[\w+-]*$/.test(line)) {
        if (pendingKey && current[pendingKey]) pendingKey = "";
        continue;
      }
      if (pendingKey) {
        const value = pendingKey.endsWith("base64") && image ? unquote(line).replace(/\s+/g, "") : unquote(line);
        // Preserve OCR damage in an explicitly labelled block so the user can
        // correct the encoded source. Only the strict decoder may accept it.
        const continuation = /base64/.test(pendingKey) ? /^[A-Za-z0-9+/_=%|\\?\-]+$/ : /^[A-Za-z0-9_+/.=~\-]+$/;
        if (continuation.test(value)) {
          current[pendingKey] = string(current[pendingKey]) + value;
          if (!pendingKey.endsWith("base64") || value.endsWith("=")) pendingKey = "";
          continue;
        }
        // A new field/heading ends the missing value; do not consume it as a Key.
        pendingKey = "";
      }
      if (/^https?:\/\//.test(line) || (image && /^url/i.test(line) && urlsIn(line).length === 1)) { urlLine(line); continue; }
      const found = bareKey(line, !!(sharedUrls.length || global.url));
      if (found) { appendKey(found.field, found.value, found.review); continue; }
      const match = line.match(/^([^:：=]{1,60})\s*[:：=]\s*(.*?)\s*$/);
      if (match) {
        const label = normalized(match[1] || "");
        const value = unquote(match[2] || "");
        const key = keyLabel(label);
        if (key) {
          appendKey(key.field, key.field.endsWith("base64") ? value.replace(/\s+/g, "") : value);
          if (key.name && current.name === undefined) current.name = key.name;
        } else if (urlLabel(label)) {
          urlLine(value);
        } else if (["name", "名称", "供应商"].includes(label)) {
          if (seenKey) { flush(); seenKey = false; }
          current.name = value;
        } else if (["model", "models", "模型", "可用模型", "支持模型", "模型列表", "protocol", "协议", "keyencoding"].includes(label)) {
          const field = ["可用模型", "支持模型", "模型列表"].includes(label) ? "models" : label;
          current[field] = value;
          if (!seenKey) global[field] = value;
        } else if (line.length < 100) pendingName = line;
      } else if (line && !/^https?:/.test(line) && line.length < 100) pendingName = line;
    }
    flush();
    if (!records.length && urls.length) records.push({ record: {}, inherited: global });
    if (urls.length > 1) issues.push("内容包含多个地址，请核对每条 Key 对应的地址。");
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const entry of records.slice(0, 50)) {
    const result = candidate(entry.record, entry.inherited);
    const c = result.value;
    if (entry.urls) {
      c.urlOptions = [...new Set(entry.urls.flatMap(url => { try { return [normalizeUrl(url)]; } catch { return []; } }))];
    }
    // Random text, even JSON, must not turn into a prompt.
    if (!c.url && !c.key && !c.urlOptions?.length) { issues.push(...result.issues); continue; }
    c.needsKeyReview = image || !!entry.review;
    const identity = JSON.stringify([c.url, c.key, c.key ? "" : c.encodedKey ?? "", c.protocol, c.model, c.urlOptions ?? []]);
    if (!seen.has(identity)) { seen.add(identity); candidates.push(c); issues.push(...result.issues); }
  }
  return { candidates, issues: [...new Set(issues)] };
}
