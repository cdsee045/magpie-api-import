import { candidateIssues, fingerprint, ImportError, normalizeUrl } from "./security.ts";
import type { Candidate, Receipt } from "./types.ts";

export const PROVIDER_ID = "api-import";
export interface ImportedMetadata {
  version: 1;
  url: string;
  name: string;
  model: string;
  identity: string;
  checkedAt: number;
  // Magpie officially uses metadata.email as the account's stable label/id.
  email: string;
}
export interface ImportedAuth { type: "api"; key: string; metadata: ImportedMetadata }
export type AuthResult = { type: "success"; key: string; metadata: ImportedMetadata } | { type: "failed"; error: string };

export function makeAuth(candidate: Candidate, receipt: Receipt, now = Date.now()): Extract<AuthResult, { type: "success" }> {
  if (candidateIssues(candidate).length || receipt.fingerprint !== fingerprint(candidate) || receipt.model !== candidate.model || receipt.expiresAt <= now)
    throw new ImportError("RECEIPT", "配置需要重新验证。");
  const url = normalizeUrl(candidate.url), identity = fingerprint(candidate);
  return {
    type: "success", key: candidate.key,
    metadata: { version: 1, url, name: candidate.name.replace(/\s+/g, " ").trim(), model: candidate.model, identity, checkedAt: receipt.checkedAt,
      email: `${new URL(url).host} · ${candidate.model} · ${identity.slice(0, 16)}` },
  };
}

export function readAuth(value: unknown): ImportedAuth {
  const auth = value as Partial<ImportedAuth> | null;
  const metadata = auth?.metadata;
  if (auth?.type !== "api" || typeof auth.key !== "string" || metadata?.version !== 1 || typeof metadata.url !== "string" || typeof metadata.name !== "string" || typeof metadata.model !== "string")
    throw new ImportError("AUTH", "请重新登录 API 导入插件。");
  const candidate: Candidate = { name: metadata.name, url: metadata.url, key: auth.key, model: metadata.model, models: [metadata.model], protocol: "chat-completions", needsKeyReview: false };
  if (candidateIssues(candidate).length || metadata.identity !== fingerprint(candidate)) throw new ImportError("AUTH", "已保存的 API 信息不完整，请重新导入。");
  return auth as ImportedAuth;
}

export function modelsFor(value: unknown): Record<string, unknown> {
  if (!value) return {};
  const { metadata: m } = readAuth(value);
  // Each upstream/key/model gets its own model id. Two accounts with the same
  // upstream model name cannot silently fail over into a different vendor.
  const id = `${m.model.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)}--${m.identity.slice(0, 24)}`;
  return { [id]: {
    id, name: `${m.name} / ${m.model} (${new URL(m.url).host})`,
    api: { id: m.model, url: m.url, npm: "@ai-sdk/openai-compatible" },
    limit: { context: 0, output: 0 },
    capabilities: { temperature: true, toolcall: true, input: { text: true }, output: { text: true } },
  } };
}

export function loaderFor(value: unknown, request: typeof fetch = fetch) {
  const auth = readAuth(value), baseURL = normalizeUrl(auth.metadata.url);
  return {
    baseURL, apiKey: auth.key,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const upstream = new Request(input, init), target = new URL(upstream.url);
        if (target.href !== `${baseURL}/chat/completions` || upstream.method !== "POST")
          return Response.json({ error: { message: "插件拒绝了非当前 API 的请求。" } }, { status: 400 });
        const headers = new Headers(upstream.headers);
        for (const name of ["cookie", "proxy-authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name);
        headers.set("authorization", `Bearer ${auth.key}`);
        const response = await request(upstream, { headers, redirect: "error" });
        if (response.ok) return response;
        await response.body?.cancel();
        return Response.json({ error: { message: `API 请求失败（HTTP ${response.status}）。`, type: "upstream_error" } }, { status: response.status });
      } catch {
        // Neither thrown errors nor upstream error bodies enter Magpie's log.
        return Response.json({ error: { message: "API 连接失败，请检查地址、网络或 Key。", type: "connection_error" } }, { status: 502 });
      }
    },
  };
}
