# Magpie API 导入插件

通过**官方 Magpie 插件登录接口**导入 API。主动粘贴文字、JSON 或截图，在本机识别，完成一次真实模型调用后确认，由 Magpie 保存账号。首版支持 Windows、本机浏览器和 OpenAI Chat Completions 兼容接口。

**0.2.4 修复截图中的编号 Key、跨行 Base64、主站/CDN 双地址识别，并增加编码原文核对。** 使用官方接口，无需修改 Magpie 主程序。已在未修改的 Magpie **0.1.4248 / 0.1.4257 / 0.1.4259 / 0.1.4260** 及其实际 Bun 插件宿主中验证加载、登录、账号保存/重载、去重、取消和 HTTP 转发钩子。更早版本未验证；测试未使用真实收费 Key，也未覆盖所有供应商的工具调用能力。

## 安装与使用

在 Magpie“插件 → 发现”底部安装框粘贴：

```text
github:cdsee045/magpie-api-import#main
```

1. 安装并启用“API 导入”。已安装旧版的电脑，到“插件 → 已安装”更新此插件。
2. 在插件的已安装条目点击“登录”。也可运行 `magpie plugin login api-import`。
3. Magpie 打开本机导入页；粘贴 API 文字、JSON 或截图，也可选择 PNG/JPEG/WebP 图片。
4. 点击“识别并验证”。未提供模型时自动获取列表，选择模型再验证；列表不可用时手动填写模型 ID。截图或未标注 Base64 推断出的 Key 必须先逐字核对，再获取模型和验证。
5. 真实调用通过后，核对域名、脱敏 Key、协议和模型，点击一次“确认添加”。
6. 返回 Magpie 查看登录结果。配置保存为**“API 导入”供应商的账号**；在模型选择器中选用显示名称、原模型和域名的条目。

再次登录可添加其他 API 或模型。每次只提供**本次验证通过的一个模型**；重新导入相同地址、Key、协议和模型，由官方账号存储更新同一账号。原有自定义供应商、其他插件账号和默认模型不会由本插件修改。

例如粘贴以下格式，替换为你的真实信息：

```json
{"name":"我的 API","url":"https://api.example.com/v1","key":"完整 API Key","model":"接口支持的模型 ID"}
```

New API 的复制连接信息也可直接粘贴：

```json
{"_type":"newapi_channel_conn","url":"https://api.example.com","key":"YOUR_API_KEY"}
```

仅对明确标注该格式的根地址补充 `/v1`，不改写已有 `/v1` 或其他显式路径，也不改写普通 JSON 的根地址。此格式通常没有模型信息：插件获取列表供你选择，不猜测模型，也不会把“获取列表成功”当成验证通过。

分享帖中的多 Key 也可整段粘贴：上方写一个 `baseurl`，下方连续列出 `Key:`、`Key(base64):` 或完整的 `sk-...`。Base64 编码可以放在标签同行或下一非空行，支持反引号包裹和省略尾部 `=`；各条前面的标题保留为名称。识别后先选择一条，再获取模型、验证和确认；其他 Key 不会自动请求或保存。要添加另一条，可重新登录并粘贴同一段。

也支持 `key1(BASE64)`、`key2(BASE64)` 等编号标签及多行编码；`可用模型：a | b` 按 Key 分别保留。Key 前同时列出主站和 CDN 时，先选 Key，再从“API 地址”下拉框选择一个地址，不自动尝试或轮询所有地址。

小字号截图可能把字母、数字或标点读错。即使 Base64 解码失败，也保留该条候选；点击“核对 Base64 原文”，对照截图修正，再点“在本机重新解码”。需要重新核对并勾选确认后才可验证。编码原文同样视为凭证，不出现在常规状态、日志或账号元数据中；仅主动点击时在当前会话显示，切换条目、关闭/隐藏页面或确认时清空。

识别使用本机规则解析，不调用大模型。`Key:`/JSON 的 `key` 字段按原样读取，`Key(base64):` 明确解码。没有标签时，也支持 `url:https://api.example.com/v1 编码内容` 或 URL 下方直接放编码：仅当严格 Base64 解码得到完整 `sk-...` 格式，才作为待核对候选；核对前不请求上游。其他未标注的编码不会猜测，请加 `Key(base64):` 标签。URL 与后面的 Key 分开提取，不会把 Key 拼进请求路径；普通根地址仍不自动补 `/v1`。

验证可能产生少量费用。导入页地址只包含随机会话令牌，不包含 Key；请勿分享该页面地址。原始输入和截图仅在内存中处理，Key 由 Magpie 的原有账号存储保管。

## 与原设计的调整

官方接口没有新建自定义供应商表单挂载和剪贴板读取能力，因此改为**用户主动登录 → 本机粘贴/选图 → 识别和验证 → 确认 → 官方插件账号保存**。不会在原生“供应商 → 自定义供应商”页面自动运行，也不直接写原生供应商配置文件。使用官方 `config`、`auth.methods.authorize/callback`、`auth.loader` 和 `provider.models` 钩子。[官方文档](https://usemagpie.ai/docs/plugins)

不同地址或 Key 的同名模型使用不同的内部模型 ID，避免自动路由到另一个服务商；发往上游的仍是原模型 ID。只保存必要的地址、名称、已验证模型和验证时间等元数据，Key 不重复写入元数据。

仅支持桌面 Magpie 与浏览器在同一台电脑的使用方式，不支持远程 `magpie web` 的浏览器连接服务器回环页。说明页位于侧栏“API 导入说明”和设置中的插件面板，它本身不读取剪贴板。

## GitHub 更新

修改、测试后提交并推送 `main`，其他电脑在 Magpie 中更新同一个插件。仓库公开，无需 GitHub 登录。非社区收录包需要手动点击更新，检查分支提交可能有约 10 分钟缓存。详见 [分发说明](docs/github-distribution.md)。

## 开发与测试

需要 Node.js 22+。Bun、TypeScript 和测试工具已列入开发依赖。OCR 使用本地 Tesseract WASM 和中英语言包，识别时不访问云端 OCR 或 CDN。

```powershell
npm ci
# 如果安装策略跳过了脚本，初始化开发工具：
node node_modules/bun/install.js
node node_modules/esbuild/install.js
npx playwright install chromium
npm run check
# 使用已安装、未修改的 Magpie 做隔离验收：
npm run test:magpie
# 验证公开 GitHub 匿名下载及安装包 OCR：
npm run test:github-install
```

本机已有 Chrome 时可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。`test:magpie` 默认在 Windows 查找用户安装目录，也可设置 `MAGPIE_EXECUTABLE`。它先核实隔离路径，所有测试账号/缓存放在 `.sandbox`；通过官方二进制提取的原始宿主完成登录和保存，不改正式配置，不打开登录浏览器，不操作系统剪贴板。测试使用虚构 Key 和本机 HTTP 服务。

`npm run dev` 保留早期创建表单的隔离演示，默认 `http://127.0.0.1:3478`，仅用于控制器回归，**不是正式插件入口**。正式导入页由 Magpie 插件登录按需启动，随机端口，不需要手工启动开发服务。

## 代码和验收

- `index.ts`：官方插件入口；加载时不启动导入页、不读剪贴板。
- `src/browser-flow.ts`：短期回环会话、主动输入、取消和账号返回。
- `src/official-auth.ts`：官方账号格式、单模型隔离和上游加载器。
- `src/parser.ts`、`security.ts`、`validator.ts`：识别、严格地址/Key 处理、真实调用验证。
- `src/controller.ts`、`host.ts`：内部状态机、私有验证凭证和一次确认。
- `src/ocr.ts`、`ocr-worker.mjs`：隔离子进程中的本地 OCR，截图不写磁盘。
- `ui/official.html`、`local-bridge.js`、`import.js`：正式导入页；`compatibility.html` 为官方说明页。
- `scripts/test-magpie.mjs`：官方 Magpie 运行时验收。
- `integration/windows`：历史 Go 剪贴板库，**正式插件不加载、不需要编译**。

证据和限制见 [官方接入说明](docs/host-integration.md)，覆盖见 [验收记录](docs/acceptance.md)。原设计保留在 `docx`，当前流程以官方接入说明为准。不实现余额查询、默认模型自动切换或批量导入；`private: true` 只禁止 npm 发布，不影响公开 GitHub 安装。
