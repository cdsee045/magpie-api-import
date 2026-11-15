import { ImportError, abortIfNeeded, candidateIssues, fingerprint, keyIssue, normalizeUrl } from "./security.ts";
import type { Candidate, Receipt } from "./types.ts";

export interface Validator {
  validate(candidate: Candidate, signal: AbortSignal): Promise<Receipt>;
  models(candidate: Candidate, signal: AbortSignal): Promise<string[]>;
}
export class HttpValidator implements Validator {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 12_000, private readonly now = Date.now) {}

  private async request(candidate: Candidate, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    abortIfNeeded(signal);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetcher(`${normalizeUrl(candidate.url)}${path}`, {
        method: body ? "POST" : "GET", signal: combined, redirect: "error", credentials: "omit",
        headers: { Authorization: `Bearer ${candidate.key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new ImportError("AUTH", "Key 无效或没有访问权限，请核对后重试。");
        if (response.status === 429) throw new ImportError("LIMIT", "接口限流或额度不足，请稍后重试。");
        if (response.status === 404) throw new ImportError("NOT_FOUND", path === "/models" ? "未找到模型列表接口，请核对 API 地址（常见 OpenAI 兼容地址以 /v1 结尾）；也可手动填写模型。" : "接口路径或模型不存在，请核对 API 地址（是否缺少 /v1）、协议和模型 ID；可获取模型后重新选择。");
        throw new ImportError("HTTP", `接口返回 HTTP ${response.status}，请核对配置后重试。`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ImportError("RESPONSE", "接口没有返回可验证的结果。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          abortIfNeeded(combined);
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262_144) throw new ImportError("RESPONSE", "接口响应过大，已停止验证。");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      abortIfNeeded(combined);
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new ImportError("RESPONSE", "接口没有返回有效 JSON，请核对协议。"); }
    } catch (error) {
      abortIfNeeded(signal);
      if (timeout.aborted) throw new ImportError("TIMEOUT", "连接超时，请检查网络后重试。");
      if (error instanceof ImportError) throw error;
      throw new ImportError("NETWORK", "无法连接接口；请检查网络、证书和地址。重定向不会携带 Key 跟随。");
    }
  }

  async validate(candidate: Candidate, signal: AbortSignal): Promise<Receipt> {
    const issues = candidateIssues(candidate);
    if (issues.length) throw new ImportError("FIELDS", issues.join(" "));
    const tokenField = /^(?:gpt-5|o[134](?:-|$))/.test(candidate.model) ? "max_completion_tokens" : "max_tokens";
    const data = await this.request(candidate, "/chat/completions", signal, {
      model: candidate.model, messages: [{ role: "user", content: "Reply OK." }], stream: false, [tokenField]: 1,
    }) as { error?: unknown; choices?: Array<{ message?: { role?: unknown; content?: unknown; reasoning_content?: unknown; refusal?: unknown } }>; usage?: { completion_tokens?: number } } | null;
    const message = data?.choices?.[0]?.message;
    if (!data || data.error || !Array.isArray(data.choices) || !message || message.role !== "assistant" ||
      !(typeof message.content === "string" || typeof message.reasoning_content === "string" || typeof message.refusal === "string" || (message.content === null && (data.usage?.completion_tokens ?? 0) > 0)))
      throw new ImportError("RESPONSE", "接口没有返回 Chat Completions 的实际生成结果，验证未通过。");
    abortIfNeeded(signal);
    const checkedAt = this.now();
    return { fingerprint: fingerprint(candidate), protocol: "chat-completions", model: candidate.model, checkedAt, expiresAt: checkedAt + 300_000 };
  }

  async models(candidate: Candidate, signal: AbortSignal): Promise<string[]> {
    const issue = keyIssue(candidate.key);
    if (issue) throw new ImportError("FIELDS", issue);
    const data = await this.request(candidate, "/models", signal) as { data?: Array<{ id?: unknown }> } | null;
    if (!Array.isArray(data?.data)) throw new ImportError("MODELS", "接口未返回模型列表，请手动填写模型。");
    return [...new Set(data.data.filter(m => m && typeof m.id === "string").map(m => m.id as string).filter(m => m.length > 0 && m.length <= 200 && !/[\u0000-\u001f]/.test(m)))].slice(0, 100);
  }
}
