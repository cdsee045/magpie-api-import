# Magpie API 自动配置插件

将复制的 API 文字、JSON 或截图转换成待添加的供应商配置，通过一次最小真实调用验证选定模型，再由用户确认添加。首版仅支持 Windows 和 OpenAI Chat Completions 兼容协议。

**当前为开发预览，尚不能在官方版 Magpie 中安装即用。** 已完成解析、真实 HTTP 验证、本地 OCR、页面状态控制、确认界面、Windows 剪贴板桥接模块和隔离集成环境；官方宿主仍缺少新建供应商页面挂载、剪贴板读取和保存授权接口。仓库中的 `NativeHost` / `magpie.apiImport` 是待接入合同，不是已存在的官方 API。

## 从 GitHub 安装与更新

仓库已公开，其他电脑可以免 GitHub 登录下载。在 Magpie 的“插件 → 发现”页面底部安装框粘贴：

```text
github:cdsee045/magpie-api-import#main
```

点击“安装”。当前开发版安装后只在设置中显示兼容性说明；从 GitHub 下载成功不代表宿主已经支持自动导入功能。

后续修改经过测试并提交、推送到 `main` 后，其他电脑继续使用同一个安装地址。Magpie 会检查所跟踪分支的提交变化，出现更新提示后，到“插件 → 已安装”点击“更新”。此仓库不是社区自动更新包，需要用户点击更新；分支变更检查可能有约 10 分钟缓存。[官方安装与更新说明](https://usemagpie.ai/docs/plugins#how-magpie-runs-plugins)

仓库源码及设计文档：[cdsee045/magpie-api-import](https://github.com/cdsee045/magpie-api-import)。详细流程与故障处理见 [GitHub 分发说明](docs/github-distribution.md)。

## 在本机运行

需要 Node.js 22 或更新版本；Bun 已列入开发依赖，Magpie 自己使用 Bun 运行插件。所有依赖来自 npm，OCR 引擎 WASM 与中英文语言数据由依赖提供，识别时不下载模型、不使用云端 OCR。

```powershell
npm ci
# 如果 npm 的安全策略跳过了安装脚本，初始化 Bun 和 esbuild：
node node_modules/bun/install.js
node node_modules/esbuild/install.js
npm run dev
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:3478`。这是**开发集成环境**：剪贴板和供应商存储均为虚构样例，验证会真实请求本地 HTTP 服务；不会读取系统剪贴板、修改 Magpie 配置或调用收费 API。可切换有效 JSON、失效 Key、多 Key、缺少模型等场景，再进入“自定义供应商”。不要在开发样例中输入真实 Key。

生产 `HttpValidator` 会向识别到并校验过的地址发送真实 API 请求；验证可能产生少量费用。只获取 `/models` 不算验证通过。验证结果有效期 5 分钟，绑定规范化地址、Key、协议和所选模型；任何配置编辑都会撤销确认资格。

## 当前能力

| 能力 | 实现与限制 |
| --- | --- |
| 页面范围 | 只接受宿主派发的 `providers/custom/new` 路由，其他页面不读剪贴板。离开立即中止并丢弃迟到结果。 |
| 文字与 JSON | 支持 URL/Key 常见字段名、中英文标签、嵌套对象、多 Key 和共享地址。最多 1 MB 文本、50 个候选。 |
| Base64 Key | 仅明确标注 Base64 时解码；不推测、不纠正 Key。 |
| 截图 | 本地 Tesseract WASM + 英文/简体中文语言数据，独立子进程处理；截图不写磁盘。最多 20 MB、2500 万像素。所有截图 Key 都必须人工核对。 |
| 地址 | 规范化完整 Chat Completions 路径；拒绝 URL 中的账号、密码、查询参数和片段。远程地址要求 HTTPS，本机允许 HTTP。 |
| 协议 | 首版只验证 Chat Completions。明确识别到其他协议时提示，不发错协议请求。 |
| 验证 | 一次非流式最小生成请求，12 秒超时、响应最多 256 KB、不自动重试、不跟随重定向。要求实际生成响应，拒绝伪造的 200 模型列表。 |
| 模型 | 可获取模型列表后由用户选择，也可手动填模型 ID。其他模型不会被标记为已验证。 |
| 确认与保存 | 确认展示域名、脱敏 Key、协议和模型；一次确认、避免双击重复保存。实际保存由宿主实现原子追加、去重并保留默认选择。 |
| 缓存 | 内容和验证配置只在内存存摘要，10 分钟去重，每类最多 100 项；退出销毁。Key 不进入持久缓存。 |
| 安全展示 | 默认只传递脱敏状态，用户点击“显示”才能临时查看 Key；离开页面清空。错误不回显上游响应或 Key。 |

## Magpie 接入状态

在 2026-11-15 核实的 [官方插件文档](https://usemagpie.ai/docs/plugins) 和上游源码中：

- `provider` 插槽挂在已保存供应商编辑器，不能用于新建表单。
- 页面在独立沙箱内，不能直接联网或调用宿主配置接口。
- 现有桥接读取只包括用量和供应商公开名称等信息；没有受控的剪贴板读取和供应商追加能力。

官方版可从本地目录加载本仓库，**只会在设置面板显示兼容性说明**，不会注册虚假供应商或读取剪贴板。`ui/import.html` 不作为已支持的官方插槽发布。完整产品必须先由官方接纳宿主接口、发布支持版本，再完成真实宿主验收；目前没有最低支持版本，也没有市场发布或收录。

详细证据、拟议接口、宿主接入位置和发布条件见 [宿主接入说明](docs/host-integration.md)。Windows 原生模块见 [integration/windows](integration/windows)，它是供宿主链接的库，不是后台剪贴板监听器。

## 验证

```powershell
npm run typecheck
npm test
npm run test:demo
npm run build
# 安装 Playwright Chromium，或指定已有 Chrome 的完整路径：
npx playwright install chromium
npm run test:browser
# 验证从公开 GitHub 实际下载和加载（需要联网）：
npm run test:github-install
```

使用已有 Chrome 时，设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。Windows 原生桥接使用 Go 1.23 或更新版本：

```powershell
go -C integration/windows test -v ./...
go -C integration/windows vet ./...
go -C integration/windows build ./...
```

所有测试使用虚构 Key、本地 HTTP 服务和合成截图。Go 测试不读取或修改真实系统剪贴板。浏览器截图位于忽略提交的 `artifacts/ui`。验收映射和测试范围见 [验收记录](docs/acceptance.md)。

## 代码分布

- `src/parser.ts`、`security.ts`：识别、补全规则、地址与敏感信息处理。
- `src/controller.ts`：页面生命周期、去重、选择、验证、确认与取消。
- `src/validator.ts`：真实 HTTP 调用与验证凭证。
- `src/ocr.ts`、`ocr-worker.mjs`：离线 OCR、隔离进程、超时和取消。
- `src/host.ts`：待接入的可信宿主会话合同。
- `ui/`：导入界面、兼容性面板和宿主样式适配。
- `integration/windows/`：Go + Windows 原生剪贴板读取、DIB 转 PNG。
- `scripts/dev.mjs`：隔离开发集成服务，不属于正式插件运行路径。
- `demo/`：保留的早期模拟交互 Demo。

本项目不实现余额查询、默认供应商自动切换、批量导入和跨软件配置。GitHub 仓库已公开用于开发版分发；`package.json` 中的 `private: true` 只禁止 npm 发布，不影响从公开 GitHub 安装。正式产品和市场发布仍需完成真实宿主验收。
