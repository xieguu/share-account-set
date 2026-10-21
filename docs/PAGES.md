# Pages 工作台与独立后端

[返回 README](../README.md) · [需求 Issue #1](https://github.com/xieguu/share-account-set/issues/1)

- 项目介绍：<https://xieguu.github.io/share-account-set/>
- 工作台：<https://xieguu.github.io/share-account-set/app/>
- 前端源码：`public/`；介绍页源码：`docs/`；发布产物：`.pages/`。

Pages 托管 HTML、CSS 和 JavaScript。用户设置自己的后端地址后，前端直接访问该服务的 API 与 WebSocket。Node.js、Chromium、SQLite 和浏览器 profile 均运行或保存在独立后端。没有默认公共后端，也没有内置账号或模拟在线状态。

## 配置后端

后端需要使用 `page` 分支的新接口，旧 `main` 版本不包含跨域登录和窗口票据。

1. 按 [README](../README.md#deployment) 部署 Node.js 服务或 HTTPS Compose。
2. 设置后端 `.env`：

   ```dotenv
   RELAY_ORIGIN=https://relay.example.com
   RELAY_FRONTEND_ORIGINS=https://xieguu.github.io
   RELAY_LAB=false
   ```

3. 重启后端；Compose 可重新运行 `docker compose -f compose.yaml -f compose.https.yaml up -d --build`。
4. 打开 Pages 工作台，点击“设置服务”，填写 `https://relay.example.com`，检查并保存。
5. 使用此后端已有的 RelayHub 账号登录，创建环境、登录目标网站并分配成员。

`RELAY_ORIGIN` 是后端入口。`RELAY_FRONTEND_ORIGINS` 是允许调用后端的前端来源，按逗号分隔，最多 20 个。填写完整 `协议://主机[:端口]`，不含路径、尾斜杠、通配符、账号或查询参数。例如 GitHub 项目路径是 `/share-account-set/app/`，来源仍是 `https://xieguu.github.io`。

同一来源下的其他 Pages 项目也处于同一来源边界内。需要独立边界时，为前端设置专用域名并修改允许来源。该配置决定哪些前端可使用接口；用户登录和环境授权仍逐请求检查。

数据库继续写入 `data/relayhub.sqlite`，无需额外“后端文件”。网站 Cookie、LocalStorage 等留在 `data/profiles/<environment-id>/`。前端不会读取或下载整个数据库和 profile。

## 两种部署方式

| 项目 | 同域工作台 | Pages 工作台 |
| --- | --- | --- |
| 入口 | 后端的 `/` | 静态站的 `/app/` |
| 后端选择 | 固定使用当前来源 | 用户填写独立服务地址 |
| 登录 | HttpOnly、SameSite=Strict Cookie | Bearer Token，跨域请求不带 Cookie |
| WebSocket | 同域 Cookie | 30 秒、单次使用的连接票据 |
| 数据持久化 | 后端 SQLite 和 profile | 同一个后端存储机制 |

同域入口继续使用原有 CSP 与 Cookie 认证，不需要设置 `RELAY_FRONTEND_ORIGINS`。切换至其他后端时使用 Pages 工作台。

Pages 中，服务地址与登录信息仅存于当前标签页的 `sessionStorage`，不写入静态文件、`localStorage` 或 URL。通过工作台按钮打开的远程窗口继承这一会话，并立即清除 `opener`。刷新当前页可继续登录；直接在一个新标签页粘贴窗口链接，需要先在该标签页的工作台登录。关闭页面后的浏览器会话恢复行为由浏览器决定；明确退出会在服务端撤销登录。

切换到另一个有效后端会先退出当前登录，关闭该登录的控制连接，再保存新地址。检查失败不会覆盖现有设置。已损坏的本页配置可在“连接设置”中点击“重置本页连接设置”；操作会清除本页保存的服务地址与登录信息。

检查连接期间可以关闭设置窗口，未完成的请求会被取消，迟到的结果不会切换服务。进入退出旧登录和保存阶段后，界面暂时禁用关闭与重复提交，完成或报错后恢复。服务明确返回登录失效时，退出会清除本地登录；网络错误仍会显示失败并保留原设置，不会被当成退出成功。

## 连接协议

跨域前端按以下顺序连接，后端须允许请求的 `Origin`：

1. `GET /api/health`：检查状态，返回 `{"status":"ok","version":"0.1.0"}`。
2. `POST /api/login`：JSON 为 `{"username":"MEMBER","password":"PASSWORD","authMode":"token"}`；成功返回 `{user, token}`，不设置 Cookie。
3. 后续 API 使用 `Authorization: Bearer TOKEN`。例如 `POST /api/sessions` 的请求体为 `{"environmentId":"ENVIRONMENT_ID"}`。
4. `POST /api/sessions/SESSION_ID/ticket`：请求体为 `{"mode":"control"}` 或 `{"mode":"view"}`；返回 `{ticket, expiresAt}`。已有操控连接时，申请新的控制票据返回 `409`。
5. 连接 `wss://relay.example.com/ws/sessions/SESSION_ID?mode=control&ticket=TICKET`。票据绑定当前登录、前端 Origin、窗口 ID 和连接模式。
6. 重连时申请新票据。票据使用或错误绑定尝试后失效；30 秒到期后也失效。有效期由服务端按自己的时钟校验，客户端不使用本机时间提前拒绝票据。每个登录的每个窗口最多 4 张待用票据，全服务最多 2,048 张。
7. `POST /api/logout`：撤销该登录及未使用票据，关闭该登录的 WebSocket；其他成员的连接继续运行。

握手时再次验证登录、环境权限和操控权。错误 Bearer 或票据不会退回 Cookie 认证。跨站 Cookie 登录及无票据的跨站 WebSocket 均拒绝。API 禁止缓存；WebSocket URL 不含长期登录 Token。

## 构建与发布

仓库 **Settings → Pages → Build and deployment → Source** 使用 **GitHub Actions**。此前的 `page /docs` 分支发布方式只含介绍页，不能发布新工作台。

推送 `page` 会运行 [pages.yml](../.github/workflows/pages.yml)：

```bash
npm run build:pages
```

构建只复制明确列出的公开前端文件和截图。`.pages/app/connection-config.json` 固定为 `{"requireBackend":true}`；同域源码中的配置为 `false`。整个 `.pages/` 上传为 Pages artifact，部署由官方 Pages Actions 完成。静态构建只需要 Node.js，不安装 Chromium，也不读取 `.env`。

`.pages/` 是可重新生成的目录，构建时会清空，已被 Git 和 Docker 忽略。不要把服务端配置、数据库或 profile 放入任何公开静态目录。`main` 分支不会触发此工作流。

## 本地验证

先按 README 安装依赖和 Chromium，然后运行：

```bash
npm run check
npm test
npm run build
npm run build:pages
python -m http.server 4173 --bind 127.0.0.1 --directory .pages
```

手动检查时打开 `http://127.0.0.1:4173/app/`，后端 `.env` 添加 `RELAY_FRONTEND_ORIGINS=http://127.0.0.1:4173` 并重启。在设置中填写本地后端地址。`localhost` 与 `127.0.0.1` 不同，填写的来源需要与浏览器地址栏一致。HTTP 后端只允许回环地址，HTTPS 前端要求 HTTPS 后端。

自动测试 [cross-origin.test.ts](../tests/cross-origin.test.ts) 验证认证、CORS 与票据；[pages-ui.test.ts](../tests/pages-ui.test.ts) 在 `localhost` 静态站与 `127.0.0.1` 后端间实际登录，覆盖项目子路径、两个成员的画面输入、Cookie 缺席、刷新、退出、移动布局及未配置/连接失败状态。源码工作台另由原有 [ui.test.ts](../tests/ui.test.ts) 验证。

[connection-ui.test.ts](../tests/connection-ui.test.ts) 使用两个真实后端验证取消检查、正常切换、退出失败及登录失效；还将浏览器本机时间调快 5 分钟，检查真实画面连接和断线重连。

## 排错

| 现象 | 检查 |
| --- | --- |
| 未设置服务，登录按钮不可用 | 在“设置服务”中填写实际后端地址 |
| 无法连接 / CORS 错误 | 后端可达、HTTPS 证书、前端完整 Origin 已配置且已重启 |
| 非 JSON 响应 | 地址是否误填前端、反向代理默认页或错误路径 |
| Pages 中填写 HTTP 被拒绝 | 公开 Pages 使用 HTTPS，后端也需要 HTTPS |
| 窗口没有登录信息 | 从已登录工作台打开窗口，或在该标签页返回工作台登录 |
| 窗口已有操控连接 | 关闭旧操控页，或由管理员收回控制权后连接 |
| 修改环境或撤销权限后连接关闭 | 属于已实现行为，按最新授权重新分配窗口 |
| 发布后缺少 `/app/` | 确认 Pages Source 为 GitHub Actions，检查新工作流是否成功 |

静态 Pages 发布与独立后端部署是两次部署。本地端到端验证证明接入链路可运行；公网后端、Ubuntu/Docker、实际网站兼容性和容量仍需在目标环境验收。
