# 官方 Magpie 接入（0.2.4）

根据用户于 2026-11-15 的要求，改用官方插件登录方案，不修改 Magpie，不依赖拟议的 `magpie.apiImport`，不使用原生新建供应商插槽。

## 真实流程

安装/启用 → 登录 → 官方调用 `auth.methods[0].authorize` → 浏览器打开短期本机页 → 主动粘贴/选图 → 解析/本地 OCR → 补全核对 → 真实调用验证 → 用户确认 → `callback` 返回 `{type:"success", key, metadata}` → **官方宿主保存账号**。

这是官方浏览器登录钩子，没有第三方 OAuth 授权服务，不申请 OAuth 令牌，回调返回官方支持的 API Key 类型。页面确认表示提交登录结果；保存是否成功以 Magpie 登录结果为准，页面不会提前声称已经保存。

官方存储使用 `plugin-auth.json`。插件不自行读写该文件，不调用 `client.auth.set` 绕过确认，也不读写 `providers.json`、默认模型或原始 Magpie UI 私有接口。`config` 使用 `??=` 保留用户配置。

## 接口证据

2026-11-15 核实：[插件登录文档](https://usemagpie.ai/docs/plugins#signing-in)、[每账号模型](https://usemagpie.ai/docs/plugins#each-accounts-models)。对照官方二进制 0.1.4248 实际提取的 `host-77be460f4d08.js` 及 [host.js 固定快照](https://github.com/yetone/magpie/blob/2bc25a2d6ea684caa83dda074f031bceaf0417c1/internal/plugin/host.js)：

- `authorize` 接受浏览器 URL 和自动回调，`callback` 允许返回 API Key，由 `save` 保存。
- `metadata.email` 作为账号名称和匹配标识；同配置/模型得到稳定标识，再次导入更新同一账号。
- `auth.loader` 得到当前账号 `getAuth()`；`provider.models` 得到该账号 `auth`。
- 取消登录撤销信号并丢弃迟到结果。

`src/host.ts` 是内部控制器适配器，不是公开的 Magpie API。历史 `providers/custom/new` 默认作用域只服务早期隔离演示；正式会话使用插件自己的 `api-import` 作用域。`ui/local-bridge.js` 连接插件短期 HTTP 服务，不往官方 `magpie` 对象上添加字段。

## 模型与账号

文字中 `Key(base64):` 的编码支持同行或下一非空行；一个 URL 下的多条 Key 共用该地址，不同明确 URL 的分组各自保留地址。显式 `key` 字段保留原样；明确标注 Base64 时解码，失败留空待补全。未标注的编码可位于 URL 后同一行或单独一行，仅当文中有共享地址且严格解码得到完整 `sk-...` 格式才列为待核对候选；核对前连模型列表也不请求。其他编码不推断。出现多个候选时，选择前不请求上游；选择后只使用该条 Key，不批量调用或保存。URL 后的 Key 在规范化地址前拆分；结构化地址或手动地址含内部空白时拒绝，避免将 Key 编码进路径。

New API 的 `_type: "newapi_channel_conn"` 连接 JSON 使用根地址时，解析器补上 `/v1`；已有路径保持不变。格式依据 [New API 连接对象](https://github.com/QuantumNous/new-api/blob/main/web/src/lib/channel-connection-info.ts) 和 [官方 API 路径说明](https://docs.newapi.ai/en/docs/guide/feature-guide/user/api)。仅凭普通 URL 不自动添加路径。模型缺失时，在地址、Key、协议等检查通过后自动请求列表；用户选择模型后才进行生成验证。OCR Key 未核对前连模型列表也不请求。列表失败可手动填写模型。

每次只保存已验证的一个模型。内部模型 ID 带配置/模型指纹后缀，`api.id` 保留上游原模型名。不同地址、Key 或模型对应不同账号/模型 ID，避免同名模型混用。相同配置/模型由 Magpie 合并；无法在登录前枚举其他账号提前去重，因此再次登录同一配置仍可能发生一次收费验证。

名称、地址、已验证模型、时间、摘要随账号保存；原始输入、图片、候选和验证凭证不保存。Key 只存官方账号 `key`，不复制到 metadata。加载器仅向当前账号 Chat Completions 地址转发 POST，设置当前 Key，拒绝重定向，移除 Cookie 和其他认证头，隐藏上游错误正文。工具调用按常见 Chat Completions 能力声明；最小验证仅证明文本生成，工具/长上下文仍取决于上游。

## 页面与取消

编号 Base64 标签和多行编码可按 Key 分组；主站/CDN 多地址保留为候选地址，由用户选择一个，再核对 Key 和模型。OCR 失败的编码原文保留在当前控制器私有状态中；常规会话状态只包含 `hasEncodedKey`。需主动点击才通过同源受限接口读取原文，修正后严格本地解码；不会猜测相似字符。重新解码撤销验证凭证并重新要求核对。原文不进入账号元数据，切换候选、隐藏/关闭、确认或替换输入时清空页面上的原文。

主动登录才启动 `127.0.0.1` 随机端口服务。令牌路径不含 Key；来源、Host、请求头、JSON、长度和动作受限，页面不可嵌入其他网站。取消登录、关页、页面隐藏或心跳失联取消尚未完成的验证，清空确认和 Key。已提交结果由 Magpie 接管，关页不能回滚已完成保存。

浏览器仅处理主动粘贴事件和选图，不调用自动剪贴板读取，不运行全局监听。PNG 本机识别，JPEG/WebP 浏览器转 PNG。不使用云端 OCR/CDN，截图不写临时文件；只复制公共语言数据到临时目录。

## 实测范围

`test:magpie` 在全新 XDG 配置/缓存中调用安装的官方程序，再使用其未经修改的 Bun 宿主，验证账号保存/重载、合并、取消、其他账号保留、模型和转发钩子。未替换正式安装，未用真实 Key，未操作桌面窗口。

实测 Windows 官方 Magpie 0.1.4248、0.1.4257、0.1.4259、0.1.4260（0.2.4 的编号/跨行 Base64、双地址及此前功能回归在 0.1.4260 完成）。不支持浏览器在另一台电脑的远程导入，不声明更早最低版本，没有 npm 发布/社区收录。真实收费服务、不同来源截图、工具调用需按实际接口继续验收。
