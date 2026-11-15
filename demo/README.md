# Magpie API 自动配置交互 Demo

纯前端交互预览，所有识别结果、接口验证和配置保存均为模拟；不读取真实剪贴板、不发出 API 请求，也不会修改 Magpie。

## 体验流程

1. 在演示顶部选择模拟剪贴板场景。
2. 进入“供应商 → 自定义供应商”，观察识别和验证过程。
3. 验证通过后，点击“确认添加”，在供应商列表查看新增结果。
4. 切换失效 Key、网络超时、不完整信息、多 Key 截图、重复配置等场景。
5. 验证进行中切换到其他页面，检查是否停止提示；可在设置里关闭自动识别。

源码为 `magpie-import-demo.html`。在 Codex 对话中以内嵌预览体验；也可直接用浏览器打开该文件，基础交互仍可使用。

截图场景使用预置的虚构截图和 OCR 结果。可展开“查看内容”并替换文本，模拟解析自己的格式；不要使用真实密钥。真实协议识别、OCR、网络验证和 Magpie 插件挂载均留待后续实现。

## 验证

使用 Node.js 内置测试运行器执行逻辑测试：

```powershell
node --test tests/demo.test.cjs
```

`tests/demo.browser.cjs` 用 Playwright 验证界面流程和宽窄屏布局，需要设置 `DEMO_NODE_MODULES`、`DEMO_BROWSER_PATH`、`DEMO_PREVIEW_PATH`、`DEMO_ARTIFACT_DIR`，分别指向 Playwright 包目录、浏览器程序、预览包装页和截图输出目录。

本次按用户要求不创建 Git commit。
