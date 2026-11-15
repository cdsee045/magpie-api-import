import { createHash } from "node:crypto";
import type { Candidate } from "./types.ts";

export class ImportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ImportError"; }
}
export function abortIfNeeded(signal: AbortSignal): void { signal.throwIfAborted(); }
export function normalizeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ImportError("URL", "请填写完整的 API 地址。"); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ImportError("URL", "API 地址只支持 HTTP(S)，不能包含用户名、密码、查询参数或片段。");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new ImportError("URL", "非本机 API 必须使用 HTTPS，避免传输明文 Key。");
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
export function fingerprint(candidate: Candidate): string {
  return createHash("sha256").update(JSON.stringify([normalizeUrl(candidate.url), candidate.key, candidate.protocol, candidate.model])).digest("hex");
}
export function configFingerprint(candidate: Candidate): string {
  return createHash("sha256").update(JSON.stringify([normalizeUrl(candidate.url), candidate.key, candidate.protocol])).digest("hex");
}
export function digest(data: string | Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
export function maskKey(key: string): string { return key ? key.length < 12 ? "••••••••" : `${key.slice(0, 3)}••••••••${key.slice(-4)}` : "未提供"; }
export function keyIssue(key: string): string | null {
  if (!key) return "缺少 API Key。";
  if (key.length > 8192 || /\s|[\u0000-\u001f\u007f]/u.test(key)) return "Key 含空白或非法字符，请核对。";
  if (/\*|…|•|<[^>]+>|your[_-]?(?:api[_-]?)?key|xxxxx/i.test(key)) return "Key 被遮挡或是占位内容，请填写完整 Key。";
  return null;
}
export function candidateIssues(candidate: Candidate, requireModel = true): string[] {
  const issues: string[] = [];
  if (!candidate.name.trim() || candidate.name.length > 100) issues.push("请填写 1–100 个字符的供应商名称。");
  try { normalizeUrl(candidate.url); } catch (e) { issues.push((e as Error).message); }
  const key = keyIssue(candidate.key); if (key) issues.push(key);
  if (requireModel && (!candidate.model.trim() || candidate.model.length > 200 || /[\u0000-\u001f]/.test(candidate.model))) issues.push("请选择或填写要验证的模型。");
  if (candidate.protocol !== "chat-completions") issues.push("首版仅支持 Chat Completions，请核对接口协议。");
  if (candidate.needsKeyReview) issues.push("截图识别的 Key 需要核对后确认，插件不会猜测字符。");
  return issues;
}
export function publicError(error: unknown): string {
  return error instanceof ImportError ? error.message : "处理失败，请重试。原始错误已隐藏以保护 Key。";
}
