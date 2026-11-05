# 最短路径：在自己的电脑运行完整 RelayHub

GitHub Pages 提供工作台前端。要创建浏览器和保存登录状态，先启动后端。最容易尝试的方法是在自己的电脑同时运行前端与后端。

## 本机启动

安装 Node.js 24+ 与 Git，打开 PowerShell 或终端：

```bash
git clone -b page https://github.com/xieguu/share-account-set.git
cd share-account-set
npm run local -- --with-agent
```

脚本依次执行：保留或生成 `.env` → `npm ci` → 安装 Chromium → 编译 → 启动完整工作台。某一步失败就停止并显示错误；不自动更换端口或浏览器。首次运行需要联网下载依赖。Linux 首次使用可能还需要先执行 `npm ci` 和 `npx playwright install --with-deps chromium` 安装系统库。

打开 **http://127.0.0.1:3410**。用户名和密码位于本机 `.env` 的 `RELAY_ADMIN_USER`、`RELAY_ADMIN_PASSWORD`，不会发布到 Pages。已有数据库的密码保持原值。保持终端运行，`Ctrl+C` 停止服务；环境资料保存在 `data/`，重新启动可继续使用。

`--with-agent` 显式允许本机数字回环 HTTP 的 Agent 连接，只对本次进程生效，不改写 `.env`。要求 `RELAY_HOST=127.0.0.1` 或 `::1`；默认配置适用。直接运行 `npm run local` 不开启该选项。其他地址和端口以 `.env` 配置为准。

这个命令每次按 lockfile 安装并构建；准备完成后，日常启动可用 `npm start`。日常需要回环 Agent 时，在 `.env` 显式设置 `RELAY_AGENT_INSECURE_LOOPBACK=true`，或者继续使用上述命令。

## 尝试三种接入

| 方式 | 下一步 |
| --- | --- |
| 服务器浏览器 | 添加环境 → 服务器浏览器 → 打开独立窗口 → 在网站内登录 → 共享成员 |
| 本地 Agent | 添加环境 → 本地 Local Agent → 下载设备配置 → 在第二个终端启动 Agent |
| 会话导入 | 添加环境 → 导入 Playwright 会话 → 选择 storageState JSON → 确认范围 → 创建私有环境 |

本机验证站默认来源为 `http://127.0.0.1:3411`。用它创建本地 Agent 环境，在第二个终端执行：

```powershell
npm run agent -- --config "PATH_TO_DOWNLOADED_JSON" --allow-insecure-loopback --trusted-origin http://127.0.0.1:3411
```

将 `PATH_TO_DOWNLOADED_JSON` 替换为真实下载路径。打开该环境的窗口后才会启动设备上的 Chromium。其他电脑连接服务器时，使用 HTTPS/WSS 和正常的设备配置，不使用回环开发选项。

详细步骤：[成员授权](MEMBER_SHARING.md) · [Agent 安装](LOCAL_AGENT.md) · [导入格式](STORAGE_IMPORT.md)。

## 让其他人访问

准备一台有持久磁盘的 Linux 服务器和指向它的域名，安装 Docker Compose。在服务器克隆本仓库后创建 `.env`，设置强随机管理员密码以及：

```dotenv
RELAY_ORIGIN=https://relay.example.com
RELAY_DOMAIN=relay.example.com
RELAY_FRONTEND_ORIGINS=https://xieguu.github.io
RELAY_LAB=false
RELAY_AGENT_INSECURE_LOOPBACK=false
```

使用现有 HTTPS 部署配置：

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
docker compose -f compose.yaml -f compose.https.yaml ps
```

域名需要正确解析，服务器的 80/443 端口可达，Caddy 才能获取证书。打开 `https://relay.example.com` 可直接使用同域工作台；也可以在 Pages 的“设置服务”中填写这个地址。完整配置见 [README 的部署章节](../README.md#deployment)。

已发布的 Pages 页面本身不提供公共后端。HTTPS Pages 不能连接本机 HTTP 后端，因此本机使用上面的 `http://127.0.0.1:3410` 入口；公网部署后再使用 Pages。

## 验证状态

[跨平台运行检查](https://github.com/xieguu/share-account-set/actions/workflows/runtime.yml) 会在 Windows、Ubuntu 和 macOS 上安装真实 Chromium，运行类型检查、测试和构建，包含独立 Agent 进程与证书校验的 WSS 测试。以每次 Actions 的实际结论为准；配置了工作流不代表它已经通过。
