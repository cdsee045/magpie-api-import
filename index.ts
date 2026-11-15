import { createSession } from "./src/host.ts";
import { startBrowserFlow } from "./src/browser-flow.ts";
import { loaderFor, modelsFor, PROVIDER_ID } from "./src/official-auth.ts";

// Official OpenCode-shaped hooks. Magpie owns sign-in, account storage and
// routing; the plugin's loopback page exists only during an explicit login.
export default async function ApiImportPlugin() {
  return {
    async config(cfg: { provider?: Record<string, unknown> }) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= { name: "API 导入", npm: "@ai-sdk/openai-compatible", models: {} };
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: "oauth", label: "导入 API（文字 / JSON / 截图）",
        async authorize(_inputs?: unknown, context?: { signal?: AbortSignal }) {
          const flow = await startBrowserFlow({ signal: context?.signal });
          return {
            url: flow.url, method: "auto",
            instructions: "在本机导入页粘贴 API 信息或上传截图。验证并确认后，返回此处查看登录结果。请勿分享导入页地址。",
            callback: (_code?: unknown, context?: { signal?: AbortSignal }) => flow.wait(context?.signal),
          };
        },
      }],
      async loader(getAuth: () => Promise<unknown>) { return loaderFor(await getAuth()); },
    },
    provider: { id: PROVIDER_ID, async models(_provider: unknown, context?: { auth?: unknown }) { return modelsFor(context?.auth); } },
  };
}

// Magpie calls every exported function as a plugin. Internal/test helpers stay
// on an object; none of these names is an additional official Magpie hook.
export const _internal = { createSession, startBrowserFlow, loaderFor, modelsFor };
