# GitHub Pages 运维说明

`page` 分支从 `main` 的首次提交 `49b882e` 创建，用于发布 RelayHub 的静态项目介绍。完整后端的安装、配置和运行方式以 [main 分支 README](https://github.com/xieguu/share-account-set/blob/main/README.md) 为准。

## 发布来源

在仓库 **Settings → Pages → Build and deployment** 中选择：

- Source：`Deploy from a branch`
- Branch：`page`
- Folder：`/docs`

入口是 `docs/index.html`。保留 `docs/.nojekyll`，让 GitHub Pages 直接发布静态文件。

预期访问地址：<https://xieguu.github.io/share-account-set/>。本文件记录发布配置；是否已发布，应以仓库 Pages 构建结果和该地址的实际响应为准。

## 页面范围

站点展示项目介绍、使用方式和 `docs/images/` 中的真实自动化测试截图。截图中的账号和地址属于本地测试站，不表示有公网浏览器会话可连接。

GitHub Pages 不运行 Node.js、Chromium、SQLite、HTTP API 或 WebSocket 服务。此页面不提供登录、远程操控或第三方账号访问；完整应用仍需单独部署。

静态资源使用相对路径，例如 `./images/dashboard.png`，以适配 `/share-account-set/` 项目路径。不要引入运行时前端 `public/app.js`、`public/viewer.js`，也不要向 Pages 请求 `/api` 或 `/ws`。

## 本地验证

在仓库根目录运行：

```bash
git switch page
python -m http.server 4173 --bind 127.0.0.1 --directory docs
```

打开 <http://127.0.0.1:4173/>，检查桌面与窄屏布局、图片、锚点和仓库链接；浏览器控制台不应出现资源错误，网络面板不应请求 `/api` 或 `/ws`。检查完后按 `Ctrl+C` 停止服务。

发布后还需在预期公网地址核对同样内容，尤其是项目子路径下的资源加载。HTTP 200 只说明页面可访问，不代表远程浏览器后端已经运行。

## 后续更新

1. 在 `page` 分支修改 `docs/index.html` 及其静态资源；截图位于 `docs/images/`。
2. 需要更新功能截图时，先在完整应用中运行 `npm test`，检查 `test-results/` 的截图，再复制需要公开展示的图片到 `docs/images/`。
3. 完成本地检查，提交并推送 `page` 分支；推送会触发已配置的 Pages 发布。
4. 检查仓库 Actions / Pages 部署结果，再验证公网地址。更新失败时保留并排查构建日志，不将静态页面可用当作后端验收结果。

`main` 更新不会自动同步到 `page`；需要新的功能说明或测试截图时，在 `page` 分支有选择地更新对应文档与资源。
