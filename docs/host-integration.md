# Magpie 宿主接入说明

## 结论

当前实现可以在隔离环境完成“识别 → 实际 HTTP 生成验证 → 一次确认 → 追加存储”，但原版 Magpie 没有开放目标流程需要的宿主能力。本仓库没有修改用户安装的 Magpie，也没有绕过页面沙箱；此版本不能宣称官方版安装即用。

这是外部发布依赖：只有官方接纳并发布宿主支持，才可能满足产品文档的最终安装要求。下面给出已经实现的业务接入模块和宿主必须实现的边界；它们不是已应用的 Magpie 补丁。

## 核实证据

核实时间：2026-11-15。上游分支会变化，以下链接固定到本次读取的提交，避免误当作稳定承诺。

| 证据 | 当前限制 |
| --- | --- |
| [公开插件说明](https://usemagpie.ai/docs/plugins#pages-in-the-window) | 页面受沙箱和网络策略限制；不能直接调用 Magpie API。 |
| [internal/plugin/page.go](https://github.com/yetone/magpie/blob/2649d5d72718bf799e9fba322898b1c3bcf8bcc8/internal/plugin/page.go) | `PanelSlots` 只含 `agents`、`usage`、`settings`、`provider`；没有新建供应商插槽。`PageReads` 不含剪贴板或配置写入。 |
| [internal/gui/pluginpage.go](https://github.com/yetone/magpie/blob/2649d5d72718bf799e9fba322898b1c3bcf8bcc8/internal/gui/pluginpage.go) | 插件文件通过独立令牌路径服务，读权限由宿主复核。 |
| [internal/gui/pagebridge.js](https://github.com/yetone/magpie/blob/2649d5d72718bf799e9fba322898b1c3bcf8bcc8/internal/gui/pagebridge.js) | 桥接提供主题、options、有限读取等能力；没有本文拟议的 `apiImport`。已有可见性事件仍不能替代新建表单挂载。 |

## 可信宿主合同

`src/host.ts` 的 `createSession(native)` 在可信 Bun 进程运行，`native` 对应 Go/Wails 宿主。入口 `index.ts` 仅把构造器放在 `_internal` 对象上，避免 Magpie 将辅助函数当成供应商插件执行。

```ts
const session = _internal.createSession(nativeHost)
// 宿主负责将会话的以下能力通过受限消息桥接给指定的导入面板：
session.subscribe(sendMaskedState)
await session.command({ type: "detect" })
// 只有用户在当前页面主动点击“显示 Key”时才调用：
session.revealKey()
// 插件关闭、面板卸载、窗口关闭时：
session.dispose()
```

宿主需要实现 `NativeHost` 的六类能力：

1. `currentPage` / `onPage`：路由来自宿主自己的导航状态。只有新建自定义供应商页映射到 `providers/custom/new`，已保存供应商编辑器不映射到它。离开页面先同步发送失活事件、取消上下文，再绘制其他页面。
2. `readClipboard(signal)`：按需读取一次，不注册全局监听。Windows 可链接本仓库 Go 模块 `clipboard.Read(ctx, hostPage)`。返回文本、PNG 字节或 empty；不能把原始数据传给日志、统计或插件 options。
3. `hasProvider(identity, signal)`：宿主从已有供应商计算配置指纹后比较，只回布尔值。指纹为 SHA-256(JSON.stringify([规范化地址, Key, 协议]))。页面拿不到其他供应商的 Key。
4. `appendProvider(input, signal)`：在原有配置锁或事务内再次检查取消、页面作用域、已有指纹和唯一性，追加新供应商并保存。不得重写默认供应商、默认模型、已有账号或供应商排序。事务提交前离开页面必须取消；提交已完成则视为已添加，不能伪称取消回滚。
5. `options.get/set`：只读写本插件 `auto` 开关，不持久化凭证、截图、识别文本和 Key。
6. 生命周期销毁：禁用、卸载、切换窗口、关闭新建页等场景撤销权限；禁止浏览器框架通过传入路由字符串重新激活自己。

`appendProvider` 收到 `candidate.models` 和单独的 `verifiedModel`。必须只给当前模型写入“已验证”状态，其他模型仍未验证。供应商名称不参与去重；同地址、Key、协议即为同一配置，不因为名称或模型变化重复新增。

会话自己还保留仅由本会话验证器签发的短期验证记录；UI 不接收验证凭证，也没有可以提交任意凭证的保存接口。确认后验证凭证一次性消费。保存失败后必须重试验证。

## 面板桥接合同

`ui/import.html` 只消费下列**拟议**对象；当前官方桥接没有这个字段。

```ts
magpie.apiImport = {
  version: 1,
  command(command): Promise<void>,
  subscribe(listener): () => void,
  revealKey(): Promise<string>,
}
```

可用命令由 `Command` 联合类型限定：重新检测、选择单个候选、修改指定字段、获取模型、验证、确认、取消、修改自动识别开关。不得开放任意 fetch、文件读取、shell、配置路径写入等通用能力。

宿主消息分发必须复用原有插件面板的 `event.source` 校验和插件授权检查，并在 Go 端再次验证作用域。不要把原始 Key 广播给所有面板。仅在来自当前导入面板的用户显示动作中返回当前候选 Key；无论页面可见性通知是否迟到，后端离开页面后都应拒绝请求。失活状态仍需推送给 UI，用于立即关闭确认框和清空显示的 Key。

## 宿主改动位置

官方接入至少需要在 `internal/plugin/page.go` 增加独立的新建供应商插槽，在宿主新建表单挂载该插槽；在 `internal/gui/assets/pluginpages.js` / `internal/gui/pagebridge.js` 增加上述受控消息合同，并在 Go 后端实现页面会话、剪贴板调用、插件启用和授权检查、保存事务。Bun 插件宿主需要一种由 Go 分发的会话消息通道来调用 `createSession`。现有公开 provider hooks 不会触发该会话，这部分不能仅靠 package.json 完成。

宿主已有的保存流程和模型验证逻辑应尽量复用。当前 `HttpValidator` 是独立可测试的备用实现；任何复用方案都必须保留实际生成、单模型绑定、取消、超时、禁止 Key 随重定向泄漏和脱敏错误约束。

## Windows 模块

`integration/windows` 使用 Win32 标准剪贴板 API，读取 `CF_UNICODETEXT`、注册的 PNG 或常见 24/32 位 `CF_DIB` / `CF_DIBV5`。原生句柄在打开和锁定期间复制，始终关闭/解锁；不释放系统持有的句柄。Go 模块对进入页、取消、文本和图片大小进行检查，不记录内容。

相关原始文档：[GetClipboardData](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata)、[剪贴板格式](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)、[BITMAPINFOHEADER](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader)。不支持的位图压缩或掩码会返回错误，由用户改为复制文字或 PNG。

## 发布条件

- [ ] 宿主接口改动被官方接纳并随正式版发布。
- [ ] 记录实际验证过的最低 Magpie 版本，不编造版本号。
- [ ] 在真实 Windows Magpie 中完成 JSON、文字、多 Key、截图及错误/取消场景验收。
- [ ] 使用隔离配置验证原有供应商、默认模型和默认供应商不变。
- [ ] 验证市场安装包含 OCR 运行代码、WASM 与中英语言包，无安装脚本依赖。
- [ ] 检查实际 Key/剪贴板不会进入宿主日志、请求历史、统计或 Git。
- [ ] 验收后确定许可证、npm 发布和市场收录方式；如需发布 npm，再移除 `private: true`。

GitHub 仓库已按用户要求公开，支持开发版的跨电脑下载与更新；这不代表上面的正式产品发布条件已满足。在这些条件满足前，包保持开发版本，官方版只提供兼容性面板；本仓库未向上游提交 PR、未发布 npm 包、未修改用户当前 Magpie。
