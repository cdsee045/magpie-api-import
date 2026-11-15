import { ImportError, keyIssue, normalizeUrl } from "./security.ts";
import type { Candidate, Protocol, Recognition } from "./types.ts";

const urlFields = ["url", "baseurl", "apiurl", "apiaddress", "endpoint", "api", "地址", "接口地址", "api地址"];
const keyFields = ["key", "apikey", "token", "密钥", "秘钥", "apikeybase64", "keybase64"];
const normalized = (s: string) => s.toLowerCase().replace(/[\s_\-()（）]/g, "");
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const unquote = (value: string) => value.trim().replace(/^([`'"])([\s\S]*)\1$/, "$2").trim();
function protocol(value: string): Protocol {
  if (!value || /^(?:openai(?:-compatible)?|chat(?:[- ]?completions)?|兼容openai)$/i.test(value)) return "chat-completions";
  if (/responses/i.test(value)) return "responses";
  if (/anthropic|messages|claude/i.test(value)) return "anthropic";
  return "unknown";
}
function decode(value: string): string {
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
  if (map.keybase64 !== undefined || map.apikeybase64 !== undefined || /base64/i.test(string(map.keyencoding ?? map.encoding))) {
    try { key = decode(string(map.keybase64 ?? map.apikeybase64 ?? key)); }
    catch { key = ""; issues.push("Base64 Key 无效，请手动补全。"); }
  }
  const rawModels = map.models;
  const models = Array.isArray(rawModels) ? rawModels.map(m => typeof m === "string" ? m.trim() : string((m as Record<string, unknown>)?.id)).filter(Boolean) : string(rawModels).split(/[,，;；]/).map(m => m.trim()).filter(Boolean);
  const model = string(map.model ?? map.模型) || models[0] || "";
  if (model && !models.includes(model)) models.unshift(model);
  return { value: { name: string(map.name ?? map.名称 ?? map.供应商) || "我的 API", url, key, protocol: protocol(string(map.protocol ?? map.协议) || (/\/responses\/?$/.test(rawUrl) ? "responses" : /\/messages\/?$/.test(rawUrl) ? "anthropic" : "")), model, models: [...new Set(models)].slice(0, 100), needsKeyReview: false }, issues };
}

export function parseText(text: string, image = false): Recognition {
  if (text.length > 1_048_576) throw new ImportError("SIZE", "剪贴板文本超过 1 MB，请缩小内容后重试。");
  text = text.replace(/^\uFEFF/, "").trim();
  if (!text) return { candidates: [], issues: [] };
  const records: Array<{ record: Record<string, unknown>; inherited?: Record<string, unknown> }> = [];
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
    const urls = [...new Set((text.match(/https?:\/\/[^\s<>"'`，；）)]+/g) || []).map(u => u.replace(/[.,;]+$/, "")))];
    const global: Record<string, unknown> = {};
    if (urls.length === 1) global.url = urls[0];
    let current: Record<string, unknown> = {};
    let pendingName = "";
    let pendingKey = "";
    let sharedUrl = "";
    let seenKey = false;
    function flush(): void {
      if (Object.keys(current).length) {
        records.push({ record: current, inherited: { ...global, ...(sharedUrl ? { url: sharedUrl } : {}) } });
        current = {};
      }
    }
    for (const raw of lines) {
      const line = raw.trim().replace(/^[-*]\s+/, "");
      if (!line || /^```[\w+-]*$/.test(line)) continue;
      if (pendingKey) {
        const value = unquote(line);
        const continuation = /base64/.test(pendingKey) ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_+/.=~\-]+$/;
        if (continuation.test(value)) {
          current[pendingKey] = value;
          pendingKey = "";
          continue;
        }
        // A new field/heading ends the missing value; do not consume it as a Key.
        pendingKey = "";
      }
      const match = line.match(/^([^:：=]{1,60})\s*[:：=]\s*(.*?)\s*$/);
      if (match) {
        const label = normalized(match[1] || "");
        const value = unquote(match[2] || "");
        if (keyFields.includes(label)) {
          if (seenKey) flush();
          current[label] = value;
          pendingKey = value ? "" : label;
          if (pendingName && current.name === undefined) current.name = pendingName;
          pendingName = ""; seenKey = true;
        } else if (urlFields.includes(label)) {
          if (seenKey) { flush(); seenKey = false; }
          sharedUrl = value;
          current.url = value;
        } else if (["name", "名称", "供应商"].includes(label)) {
          if (seenKey) { flush(); seenKey = false; }
          current.name = value;
        } else if (["model", "models", "模型", "protocol", "协议", "keyencoding"].includes(label)) {
          current[label] = value;
          if (!seenKey) global[label] = value;
        } else if (line.length < 100) pendingName = line;
      } else if (/^sk-[A-Za-z0-9_-]+$/.test(line)) {
        if (seenKey) flush();
        current.key = line; if (pendingName) current.name = pendingName;
        pendingName = ""; seenKey = true;
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
    // Random text, even JSON, must not turn into a prompt.
    if (!c.url && !c.key) { issues.push(...result.issues); continue; }
    c.needsKeyReview = image;
    const identity = JSON.stringify([c.url, c.key, c.protocol, c.model]);
    if (!seen.has(identity)) { seen.add(identity); candidates.push(c); issues.push(...result.issues); }
  }
  return { candidates, issues: [...new Set(issues)] };
}
