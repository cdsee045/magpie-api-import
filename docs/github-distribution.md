# GitHub 下载与更新

仓库 `cdsee045/magpie-api-import` 已公开，默认分支为 `main`。电脑不需要 GitHub 账号或 Token 即可下载开发版。公开范围包括源码、设计和技术文档、提交历史及 Actions 记录。

## 在其他电脑安装

1. 打开 Magpie，进入“插件 → 发现”。
2. 在底部的“npm 包名、GitHub 仓库或本机文件夹”输入框中粘贴下方内容。
3. 点击“安装”，然后在“已安装”中查看插件。

```text
github:cdsee045/magpie-api-import#main
```

这是仓库默认开发分支的固定地址。也可使用命令行：

```powershell
magpie plugin add github:cdsee045/magpie-api-import#main
```

安装后的当前行为是设置中的兼容性说明面板。完整的自动识别、验证和供应商保存流程仍需要 Magpie 官方宿主接入，详见 [宿主接入说明](host-integration.md)。本次公开仅解决分发权限和更新来源，不改变功能接入状态。

## 开发者提交更新

在开发电脑完成修改并通过相关测试后，创建提交并推送到 `main`。本仓库已经关联 `origin`，后续不需要重新创建仓库。

```powershell
git status
# 按本次修改范围添加文件，再提交：
git add <本次修改的文件>
git commit -m "说明本次改动"
git push origin main
```

GitHub Actions 会验证 Linux、Windows、浏览器和 Go 模块。实际分发安装可额外运行：

```powershell
npm run test:github-install
```

此检查在 `.sandbox` 下新建独立目录，使用本项目的 Bun 从公开 GitHub 安装插件，并清除子进程的 GitHub Token、SSH Agent 和 Git 凭据配置。它会禁止安装脚本，验证模块能加载、面板文件存在、OCR 运行代码和语言数据齐备，并实际调用安装包中的本地 OCR 识别一张合成截图。它不会修改真实 Magpie、读取剪贴板或调用收费 API。推送到 `main` 时，Windows CI 也会自动执行这项检查。

## 使用电脑获取更新

Magpie 会比较 GitHub 分支最新提交和已安装提交，发现更新后显示提示。进入“插件 → 已安装”点击该插件的“更新”。

本项目不是 `@magpie-community/*` 社区自动更新包，提交到 GitHub 后不会立刻让其他电脑自动替换插件。Git 仓库更新检测通常最多每 10 分钟重新请求一次；遇到缓存可稍候再检查。[Magpie 官方说明](https://usemagpie.ai/docs/plugins#how-magpie-runs-plugins)

`#main` 跟踪分支后续提交。如果改成 `#<commit>` 固定某次提交，则不会继续跟随 `main` 更新。

## 404 与下载问题

此前的 404 来自私有仓库未授权访问：GitHub 会对未正确认证的私有资源返回 404。[GitHub 官方说明](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)

仓库现已公开。使用准确的安装地址重新安装；如果仍报错，保留完整错误中的 HTTP 状态码和请求地址，以区分分支拼写、API 限流和网络连接问题。`package.json` 的 `private: true` 只阻止 npm 发布，不会把 GitHub 仓库设为私有，也不阻止 GitHub 来源安装。不要把 Token 写进安装地址、配置示例或提交历史。
