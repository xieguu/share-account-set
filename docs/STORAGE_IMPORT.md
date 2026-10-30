# 导入 Playwright 会话状态

[返回 README](../README.md) · [成员权限](MEMBER_SHARING.md)

入口：**添加环境 → 导入 Playwright 会话到服务器**。填写新环境配置，选择 `.json` 文件，核对来源和共享说明，勾选确认后提交。成功后创建属于当前成员的私有服务器环境；随后在 **共享成员** 中单独授权，不继承其他环境的授权。

确认说明明确告知：登录信息会保存在服务器，站点管理员可以管理环境，未来授权的成员会使用同一网站身份和账号内的数据。预览只显示 Cookie 数量和存储来源，不展示 Cookie 值。

## 明确的输入格式

优先使用与仓库版本相同的 Playwright 1.61.1。在自己已登录的专用 Playwright 上下文中导出：

```ts
await context.storageState({ path: 'state.json', indexedDB: true });
```

这是所有者在自己设备上执行的 Playwright 调用，RelayHub 不接收或运行这段代码。上传文件的最小形式：

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "EXAMPLE_SESSION_VALUE",
      "domain": "example.com",
      "path": "/",
      "expires": 1900000000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [{ "name": "account", "value": "example" }]
    }
  ]
}
```

IndexedDB 支持 Playwright 导出的数据库 `name/version/stores`、索引、普通 JSON 记录以及 `keyEncoded/valueEncoded` 序列化值。本轮测试包含 IndexedDB 对象和 `Date` 的恢复。实际恢复复用 Playwright 的 [`BrowserContext.setStorageState`](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-storage-state)，不拼接上传内容为 JavaScript。

## 校验与落盘

- 请求体最大 **2 MiB**，最多 1000 个 Cookie、50 个存储来源，限制数组数量、JSON 深度和节点数量。
- 只接受 JSON 对象；脚本、路径、整个浏览器目录和未知顶层字段会被拒绝。
- Cookie 基础域名必须对应允许来源中的主机；`.example.com` 需显式加入 `https://example.com`，不能仅加入某个子域。存储来源必须精确匹配且不能重复。
- 所有来源还需通过门户来源排除及服务器网络策略；导入文件不能额外开放网络权限。
- 只导入到新的 UUID Profile，导入过程中环境暂停，不能同时编辑或创建成员窗口。
- 失败会关闭浏览器、删除新环境元数据和新 Profile。不会把不完整的导入结果暴露成可用环境。
- 成功后保持上下文运行，便于立即使用 session Cookie；持久 Cookie、LocalStorage 和 IndexedDB 随专用 Profile 保留。浏览器关闭后无到期时间的 session Cookie 可能失效。
- 原始上传 JSON 不单独保存，不写入审计或日志，也不提供下载或导出接口。

不支持迁移 SessionStorage、缓存目录、扩展、系统钥匙串、设备绑定凭据、WebAuthn/Passkey 或整个 Chrome 用户目录。来源格式通过校验也不代表网站一定接受迁移后的登录；网站可能要求重新验证或重新登录。

## API

`POST /api/environments/import`，沿用当前登录与 Origin 校验：

```json
{
  "environment": {
    "name": "导入的环境",
    "startUrl": "https://example.com/",
    "allowedOrigins": ["https://example.com"],
    "maxSessions": 4
  },
  "storageState": { "cookies": [], "origins": [] },
  "confirmSharedIdentity": true
}
```

返回 `201 {"environment": ...}`。未确认、格式或范围不符、恢复失败返回 400；超过请求大小上限返回 413。完整自动化验证见 [member-environments.test.ts](../tests/member-environments.test.ts) 和 [member-ui.test.ts](../tests/member-ui.test.ts)。
