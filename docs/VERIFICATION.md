# 核心链路与优化验证

[返回 README](../README.md) · [English README](../README.en.md)

验证日期：2026-10-17。环境：Windows、Node.js 24.14.0、Playwright 1.61.1、配套 Chromium 149。

## 复现命令与结果

完成 README 中的依赖和 Chromium 安装后，在仓库根目录运行：

```bash
npm run check
npm test
npm run build
node --check public/app.js
node --check public/viewer.js
```

本轮结果：

```text
TypeScript check                         PASS
Browser integration + UI tests           17 passed, 0 failed
Production build                         PASS
Frontend JavaScript syntax checks        PASS
Test runner elapsed                      20.4 s
```

测试数为 Node.js 测试运行器报告值，包含集成测试的父测试、15 个子测试和 1 个界面测试。耗时属于本轮本机运行记录，不是吞吐量或延迟基准。

测试使用真实 Chromium 和独立 HTTP 来源的本地站点，没有使用第三方账号。测试站通过真实 HTTP 响应设置 30 天 Cookie。每次运行创建独立数据库、浏览器 profile 和随机端口，不使用项目日常运行的 `data/`。

## 集成测试范围

源文件：[tests/integration.test.ts](../tests/integration.test.ts)。

| 检查 | 运行时断言 |
| --- | --- |
| HTTP 与授权 | 未登录请求、错误 Origin、成员访问管理员 API、未授权环境均被拒绝 |
| 并行分配 | 管理员和两名成员同时创建三个 Page，引用同一个持久化 BrowserContext；重复分配被拒绝 |
| 共享登录 | 管理员通过远程鼠标登录一次，其他成员页面刷新后看到相同账号 |
| 独立输入 | 点击、计数、中文文本、按键、滚轮和导航只影响所属页面 |
| 弹窗归属 | 新页面出现在发起成员的标签列表，不进入其他成员窗口 |
| 窗口所有权 | HTTP、WebSocket、标签页 ID 与窗口 ID 校验所有权；只读连接不能操控 |
| 控制权 | 同一窗口拒绝第二个控制连接；管理员可以撤销控制并建立新连接 |
| 输入校验 | 非 HTTP 地址、未允许来源、伪造字段与旧页面 targetId 被拒绝 |
| 画面 | 多个远程页面输出 JPEG，测试检查文件头并保存真实画面样本 |
| 静态去重 | 静止画面捕获结果被去重；20 次鼠标移动不触发完整状态广播 |
| 慢观看者 | 不确认首帧时不继续堆积画面；确认后可接收新画面 |
| 画质与可见性 | 切换省流模式后配置为 4 FPS；没有可见观看者时停止捕获，恢复可见后继续 |
| 登录会话 | 退出一个登录只关闭对应连接；另一个有效登录保持连接；连续成功登录不消耗失败限流额度 |
| 慢导航与撤权 | 页面导航被测试闸门阻塞时，心跳在 1 秒断言期限内响应；撤权后旧输入不能在队列中继续执行 |
| 持久化 | 停止环境后重新打开，Cookie 与 LocalStorage 仍保留 |
| 回收与退出 | 无连接的过期窗口被回收；退出后原 Cookie 无效 |
| 环境编辑 | 关闭旧窗口、保持环境 ID 和成员授权、使用新起始地址，并保留原网站登录 |

表格按行为列出断言，一个测试可能覆盖多项行为。

## 界面测试范围

源文件：[tests/ui.test.ts](../tests/ui.test.ts)。

测试通过实际门户表单创建成员、分配权限、编辑环境，并通过两个独立门户 BrowserContext 打开两路远程画布。检查：

- 管理员与成员菜单权限；
- 远程登录、相互独立的输入内容；
- Ctrl+A、中文文本、模拟 composition 事件去重和 Enter 多行输入；
- UI 画质选择、手动重连、异常断线自动重连；
- 重连后仍保留服务端页面中的表单内容；
- 控制权被收回后，迟到的帧解码不能遮住断线提示；
- 390 像素宽度下工作台没有横向溢出；
- 浏览器无未捕获 JavaScript 异常。

中文输入检查包含程序注入的文本与 composition 事件，并不覆盖所有操作系统、输入法和移动端键盘组合。移动布局断言针对门户工作台，不代表完整触屏兼容性验收。

## 修复的连接状态问题

浏览器图片解码是异步操作。旧客户端只在开始接收时校验连接，导致连接断开后，尚未完成的解码仍可能绘制画面并隐藏断线提示。

回归测试在真实界面中延迟 `createImageBitmap`，撤销控制权后释放解码。修复前断线提示被隐藏，断言失败；修复后，断开连接会更新连接代次并丢弃等待中的旧帧，旧解码不能更改当前界面。此用例随完整测试通过。

## 静态画面样本

本轮在稳定页面上观察 1,500 ms，测试写出的样本为：

```json
{
  "sampleMs": 1500,
  "captured": 11,
  "transmitted": 0,
  "suppressed": 11
}
```

这验证了相同画面不重复发送。系统仍会进行捕获，并约每 2 秒提供一次刷新机会；短采样窗口内零发送不等于长期零带宽，也不意味着捕获 CPU 开销已经消除。动态网页、光标闪烁和视频会产生不同结果。

未进行优化前后同负载的 CPU、内存、带宽或并发容量对照，文档不声明相关提速比例。

## 验证产物

| 路径 | 内容 |
| --- | --- |
| `test-results/login.png` | 登录页面 |
| `test-results/dashboard.png` | 管理工作台 |
| `test-results/remote-window.png` | 真实远程画布与输入结果 |
| `test-results/mobile.png` | 移动宽度下的工作台 |
| `test-results/runtime-*/remote-frame.jpg` | WebSocket 收到的 JPEG 样本 |
| `test-results/runtime-*/static-stream-sample.json` | 本轮静态画面计数 |
| `test-results/runtime-*/`、`test-results/ui-*/` | 测试专用数据库和浏览器资料 |
| [docs/images/](images/) | README 使用的已选取界面截图 |

`test-results/` 被 Git 忽略。README 中的截图从成功测试产物复制，未包含实际第三方账号。

## 尚未验证或尚未实现

尚未实测：Ubuntu / Docker 构建、公网 HTTPS、第三方网站兼容性、长期负载、真实网络抖动和所有输入法组合。

尚未实现：音频、WebRTC、文件上传下载、远程剪贴板读取、网页原生对话框交互、页面重启恢复和多节点调度。测试成功仅覆盖上述已实现链路。
