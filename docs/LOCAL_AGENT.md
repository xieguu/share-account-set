# Local Agent：共享本机浏览器

[返回 README](../README.md) · [成员权限与操作](MEMBER_SHARING.md)

Local Agent 是独立 Node.js 进程，复用 RelayHub 的 Playwright / CDP、画面流和输入路由。浏览器在设备上运行，Agent 主动通过 WSS 连接 RelayHub；不启动对外 HTTP 服务，不公开 CDP，不需要端口映射。浏览器网络检查使用仅回环可达的临时代理端口。

服务器转发每个成员窗口的 JPEG 画面及输入消息，网站 Cookie、LocalStorage、IndexedDB 和 Profile 留在设备上。画面仍经过 RelayHub 服务器中转，当前不传输音频。

## Windows 安装

先安装 Node.js 24+ 和 Git。在 PowerShell 执行：

```powershell
git clone -b page https://github.com/xieguu/share-account-set.git
cd share-account-set
npm ci
npx playwright install chromium
npm run build
```

设备无需运行 `npm run setup`、RelayHub 服务或 SQLite 数据库。

1. RelayHub 部署者先提供 HTTPS 后端，`RELAY_ORIGIN` 配置为该 HTTPS 来源；现有 Caddy 配置转发 `/ws/agent`。
2. 成员登录门户，选择 **添加环境 → 连接本地 Local Agent**，填写网站来源与并发数量。
3. 在该环境卡片点击 **下载设备配置**。配置包含绑定到该环境的设备凭据，下载新配置会使旧配置失效。
4. 将 JSON 放在当前 Windows 用户自己的目录，例如 `$env:USERPROFILE\Downloads`，在设备上运行：

```powershell
npm run agent -- --config "$env:USERPROFILE\Downloads\relayhub-agent-ENV_ID.json"
```

将 `ENV_ID` 换成实际下载文件名。需要保持 Agent 进程和电脑运行；`Ctrl+C` 停止。环境卡片变为 **本地设备在线** 后，打开自己的远程窗口，在网站界面里登录，再使用 **共享成员** 授权。

默认浏览器有界面，首次打开成员窗口才启动；也可使用 `--headless`。专用 Profile 默认在 `%USERPROFILE%\.relayhub-agent\profiles\<environment-id>`。改变根目录：

```powershell
npm run agent -- --config "C:\Users\YOUR_USER\relayhub-agent.json" --data-dir "D:\RelayHubAgent"
```

`--data-dir` 指定 Agent 自己的数据根目录，环境的 Profile 始终位于其 `profiles/<environment-id>` 下。它不是连接现有系统 Chrome Profile 的参数。不要把设备 JSON 放进共享目录；配置文件不包含网站 Cookie，但持有者可以冒充该环境的设备。门户不提供下载本地 Profile 的功能。

## macOS / Linux

代码使用同一组 Node.js、WebSocket 和 Playwright API，没有 Windows 专属进程接口：

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
npm run agent -- --config "$HOME/relayhub-agent.json" --headless
```

默认目录为 `~/.relayhub-agent`。本轮端到端测试在 Windows 执行；macOS/Linux 启动方式已提供，尚未做对应系统的运行验收。

## 本机开发验证

正式设备连接要求 WSS，并保留正常证书校验。只在数字回环地址上开发时，两端都显式开启例外：

```dotenv
RELAY_ORIGIN=http://127.0.0.1:3410
RELAY_AGENT_INSECURE_LOOPBACK=true
RELAY_LAB=true
```

重启 RelayHub，再创建起始地址为 `http://127.0.0.1:3411/` 的本地环境，下载配置：

```powershell
npm run agent -- --config "PATH_TO_DEVICE_JSON" --allow-insecure-loopback --trusted-origin http://127.0.0.1:3411 --headless
```

`--allow-insecure-loopback` 只允许 `127.0.0.1` 或 `[::1]`，不接受远程主机或 `localhost`。`--trusted-origin` 是设备所有者对一个内网站点的授权，不能从服务端命令或网页上传参数中开启。实际内网站点还需要服务器部署者的 `RELAY_TRUSTED_NETWORK_ORIGINS` 设置。

## 控制与恢复

- **暂停共享**：关闭该设备环境的全部窗口和浏览器，保留本地登录资料；恢复后按需重新创建页面。
- **释放 / 收回控制**：所有者从运行窗口列表关闭某位成员页面，或收回其控制连接。
- **撤销成员**：立即关闭对应成员窗口，阻止创建、连接和旧票据使用。
- **断线 / 休眠**：门户显示离线并关闭窗口连接；Agent 检测连接中断后关闭本地页面，按 1–30 秒退避重连。异常网络最迟由心跳超时检测。不会切换到服务器浏览器，也不会上传 Profile。
- **重连**：网站持久化登录资料仍在原设备；成员重新打开窗口，不恢复原来的内存表单或 Page。会话 Cookie 是否跨浏览器重启保留取决于网站和 Chromium。
- **撤销设备 / 重新配对**：凭据立即失效，连接被断开。被拒绝的凭据不会无限重试；下载新配置后重新启动 Agent。

## 协议与排错

`POST /api/environments/:id/agent-key` 返回一次设备配置；`DELETE` 撤销。只有所有者和管理员能操作。服务端只保存设备令牌的 SHA-256 哈希。

Agent 使用 `Authorization: Bearer` 握手 `/ws/agent`，不把凭据放在 URL 中。协议只允许创建/关闭窗口、停止环境、连接/断开观看者和固定的浏览器输入命令，不提供 `evaluate`、shell、文件读取或任意脚本执行 RPC。双方校验消息格式；每个窗口、观看者和请求都有独立 ID，流量与待处理请求有上限。设备帧采用 Base64 JSON 封装进行中转，浏览器端仍接收原来的 JPEG 二进制帧。

| 现象 | 检查 |
| --- | --- |
| 设备离线 | Agent 是否运行、电脑是否休眠、后端 HTTPS 证书和 WebSocket 代理是否正常 |
| 配对返回 400 | 是否配置 HTTPS；本机开发的两端是否都显式允许回环 HTTP |
| 注册返回 401 / 403 | 凭据是否被撤销、所有者是否被停用；重新下载配置 |
| 注册返回 409 | 同一环境已有设备连接；先停止旧 Agent，或重新配对 |
| 在线但浏览器启动失败 | 是否安装匹配版本的 Playwright Chromium，是否有可用桌面；无桌面使用 `--headless` |
| 页面资源被阻止 | 补齐精确来源；内网目标还需要服务器和设备所有者分别授权 |

验证源码：[tests/local-agent.test.ts](../tests/local-agent.test.ts)。测试生成独立 CA 证书，通过 `NODE_EXTRA_CA_CERTS` 信任测试 CA，启动真实 Agent CLI 子进程和 Chromium；没有关闭 TLS 证书校验。
