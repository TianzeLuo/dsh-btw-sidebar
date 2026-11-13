# 与 dsh-away-notify 的集成（可选）

[dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify) **不是必需依赖**：没装（或版本旧到没有 `awayNotify` 接口）时本插件静默跳过声明，
`/btw` 照常可用，只是通知退回默认行为。

## 为什么需要这层接线

侧边聊天是主会话 fork 出来的**普通会话**，跑完一轮本来会触发 away-notify 的 `turn-complete` 提醒；
而 away-notify 的浏览器半部只上报**主视图**的会话（`byId[].retainedBy.mainView`），面板里的子会话不在
其中——宿主的在场判定认不出「用户正看着这条」，于是照弹，点通知还会在主视图里把这条会话开出来。

本插件在加载时通过 `awayNotify` 服务声明两件事：

- **抑制**：`addRule({ id, reason, match })`，只按**自己 fork 出来的会话 id** 匹配，
  **不做任何标题/关键词匹配**（改标题不影响，也不会误伤别的插件）；
- **揭示**：`revealSession(sessionId, { resource, mainSessionId })`，声明「这条会话属于右栏某个 tab」——
  点它的通知应该回到那个 tab，而不是在主视图里新开一条。`mainSessionId` 是它的**归属主会话**（发起
  `/btw` 的那条，也是第一次显示这个 tab 的会话）：右栏的状态按主视图会话分域，不带归属就会把 tab
  开进你**当时正看着**的那条会话的右栏。

## 行为矩阵

| 情形 | 通知 | 点通知 |
|---|---|---|
| 面板**真的显示在右栏**且你正看着 dsh（页面可见 + 有焦点） | 静音 | — |
| 面板在后台（右栏切到别的 tab / 右栏折叠 / 主视图换了会话） | 照常提醒 | **先切回侧边聊天的归属主会话**，再在它的右栏打开那个 tab：已开着就聚焦，没开就新开并展开右栏 |
| 你切到别的应用 / 标签页 | 照常提醒 | 同上 |
| `turn-aborted`（你点停止，或关面板时的 `stopActivity`） | **永不提醒** | — |
| 面板已关闭（会话重新归档） | 其余类型无从触发 | — |

「面板是否真的显示在右栏」用的是官方给每个 tab 的 `useTabInfo().tab.visible`
（前景会话 && (浮动面板 || 右栏展开且是本格的活动 tab)），折叠、分屏、浮动都不用猜。

## 开关与降级

| 情况 | 行为 |
|---|---|
| `suppressNotifications: false` | 只关闭**抑制**（通知照弹）；**揭示保留**，点通知仍回右栏 tab |
| away-notify 未安装 / 无 `awayNotify` 服务 | 跳过声明，退回「会弹通知 + 点击切主视图」，`/btw` 不受影响 |
| 服务存在但缺 `addRule` | 跳过抑制声明并记一条日志；揭示仍生效 |
| `revealSession` 的地址没有 tab 类型认领 / 右栏不可用 | 点击退回主视图（见 [limitations.md](limitations.md) 第 7 条） |
| 归属主会话的右栏没能在 3 秒内挂载（`REVEAL_TIMEOUT_MS`） | 同样退回主视图；任何情况下都不会开进你当时正看着的那条会话的右栏 |

排障：把 away-notify 的 `op:'state'` 打到浏览器控制台，响应里的 `suppressed` 字段会列出被抑制的会话
与生效的规则。

## 本插件用到的接口

| 方法 | 用途 |
|---|---|
| `addRule({ id, reason, match(sessionId, event, context) })` | 按类声明抑制；`context` 含 `{ attended, pageAttended }` |
| `revealSession(sessionId, { resource, mainSessionId, reason })` | 声明点击揭示目标（`dsh-resource://…` 地址 + 归属主视图会话，由 away-notify 不透明转发） |

完整接口（还有 `suppressSession` / `releaseSession` / `isSuppressed` / `revealFor` / `snapshot`）见
[dsh-away-notify 的 README](https://github.com/TianzeLuo/dsh-away-notify)；
接口流程图与三条被否掉的替代方案见 [development.md](development.md)。
