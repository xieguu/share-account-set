# 成员创建与共享环境

[返回 README](../README.md) · [Local Agent 安装](LOCAL_AGENT.md) · [会话导入](STORAGE_IMPORT.md)

普通成员和管理员都能创建环境。新环境属于当前登录者，默认没有共享成员；管理员保留全站管理能力。旧数据库自动将原有环境归属到最早创建的管理员，环境 ID、授权记录与浏览器 Profile 路径保持不变。

## 创建服务器环境

1. 登录工作台，选择 **添加环境 → 服务器浏览器**。
2. 填写名称、起始网址、允许来源和并发上限。来源使用完整 `https://example.com`，每行一个；按实际需要加入登录跳转、接口和 CDN 来源。
3. 创建后打开独立窗口，在网站原始页面内自行登录。RelayHub 创建表单不接收网站账号密码。
4. 回到环境卡片，点击 **共享成员**，勾选允许使用的 RelayHub 成员。
5. 被授权成员登录自己的 RelayHub 账号并打开窗口。每名成员每环境最多一个窗口，每个窗口最多五个关联标签页。

一个环境共用一个持久化 Chromium 上下文。共享成员使用相同的网站身份、权限与账号内数据；分开的页面只隔离画面、输入和导航。所有者可以观察、接管和释放自己环境里的窗口。

## 停止、暂停与撤销

| 操作 | 行为 |
| --- | --- |
| 停止 | 关闭全部窗口及浏览器；保留登录资料，之后允许重新打开 |
| 暂停共享 | 先持久化暂停状态，再关闭全部窗口；恢复前任何人都不能创建窗口 |
| 取消成员勾选 | 立即撤销访问并关闭该成员窗口；旧窗口票据不能重新连接 |
| 释放窗口 | 关闭指定成员的页面，其他成员窗口继续运行 |
| 收回控制 / 接管 | 释放旧连接的按键和鼠标状态，再允许新控制连接 |
| 编辑 | 关闭旧窗口后应用新 URL、来源和并发配置；所有者、环境类型、授权和 Profile 不变 |
| 撤销设备 | 本地环境的设备凭据失效，连接和窗口关闭；本地 Profile 保留 |
| 删除 | 关闭窗口、删除元数据及授权；既有 Profile 保留在原设备或服务器，不提供下载接口 |

停用环境所有者会关闭该所有者创建的所有环境，也关闭其中其他成员的窗口。本地设备的凭据同时失去连接资格。管理员仍可以查看与管理元数据。

## URL 与网络范围

允许来源不是内网授权。创建时校验 DNS，浏览器连接时再由 `proxy-chain` 校验目标并使用同一个已校验的 DNS 地址建立连接。`ipaddr.js` 拒绝回环、私网、链路本地、共享地址、保留地址及映射到这些地址的 IPv6。一次解析中混有私网答案也会拒绝。

HTTP 请求和 HTTPS / WebSocket CONNECT 经过环境专用代理，代理仅监听随机的 `127.0.0.1` 端口；Chromium 的默认回环代理绕过被关闭，同时关闭 QUIC、限制非代理 WebRTC UDP。Playwright 另外校验 HTTP 和 WebSocket 的完整来源，包含页面导航、弹窗和子资源。

确实需要使用内部站点时，由服务器部署者设置精确来源，不能由成员请求体覆盖：

```dotenv
RELAY_TRUSTED_NETWORK_ORIGINS=https://knowledge.internal.example:8443
```

本地 Agent 还需要设备所有者显式提供相同来源的 `--trusted-origin`。`RELAY_LAB=true` 只自动授权项目内置验证站对应的一个来源，不开放其他回环端口。Linux 容器部署可另外使用操作系统网络策略约束浏览器进程出站范围。

## API

认证、Origin 校验、Pages Bearer Token 和单次 WebSocket 票据沿用原实现。管理员 `/api/admin/environments` 接口仍可用。

| 方法与路径 | 权限 / 用途 |
| --- | --- |
| `GET /api/environments` | 当前可访问环境，含 `ownerId`、`kind`、`paused`、`status`、`canManage` |
| `POST /api/environments` | 当前成员创建环境，`kind` 为 `server` 或 `local`，默认 `server` |
| `PUT /api/environments/:id` | 所有者 / 管理员更新配置 |
| `DELETE /api/environments/:id` | 所有者 / 管理员删除 |
| `POST /api/environments/:id/stop` | 所有者 / 管理员停止 |
| `POST /api/environments/:id/pause` | 所有者 / 管理员，JSON：`{"paused":true}` |
| `GET /api/members` | 登录成员获取可授权成员的 ID 和用户名 |
| `GET /api/environments/:id/grants` | 所有者 / 管理员列出授权 |
| `PUT /api/environments/:id/grants/:userId` | 所有者 / 管理员授予访问 |
| `DELETE /api/environments/:id/grants/:userId` | 所有者 / 管理员撤销访问 |
| `GET /api/environments/:id/audit` | 所有者 / 管理员查看最近 100 条该环境记录 |
| `POST /api/sessions/:id/revoke-control` | 所有者 / 管理员收回操控权 |

创建请求示例：

```json
{
  "name": "我的知识库",
  "kind": "server",
  "startUrl": "https://example.com/",
  "allowedOrigins": ["https://example.com"],
  "maxSessions": 4
}
```

所有者取自服务端认证结果，提交 `ownerId` 不会改变归属。其他成员不能枚举私有环境、修改其配置、获取授权名单或审计。没有 Cookie / Profile 导出 API；静态服务器只提供 `public/`。系统管理员对宿主机文件的访问不由门户权限控制。

审计记录登录、环境与授权变化、设备上线/离线、窗口创建/释放、观察/操控连接及导航/标签操作类型。不会写入 Cookie、设备令牌、键盘文本、截图、导入 JSON 或导航 URL 查询参数。
