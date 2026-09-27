# 排障

## 先确认装上了

```bash
# 组合树里出现这一行才算装上；没有就是没装上
dsh --profile web --dump-config | grep -x -- '- id: dsh-btw-sidebar'
```

- 启动输出里出现 `skipping profile bundle "dsh-btw-sidebar"` 或 `cannot resolve profile bundle`：
  Windows 跨盘符的坏 junction 是头号原因，见 [windows.md](windows.md)。
- 装完**必须重启 `dsh web`**：`dsh.profile.bundles` 只在启动时读取一次。
- `dsh plugin add` 打印 `declares no dsh.bundle` 是**误导性**的：插件声明得好好的，是链接解析不到，
  同一篇 [windows.md](windows.md) 里有完整解释。

## 页面只剩 boot 审计错误

**症状**：页面显示 `Failed to load plugins / dsh-btw-sidebar / web boot: 1 entry did not activate`。
客户端插件 `apply` 抛异常时，DSH 的 boot 审计会拦下整个页面——这是保护机制，不是本插件特有。
定位方法：浏览器控制台里 `web boot:` 那条错误**上方最近的一次异常**。

历史上踩过的几次（都是官方槽/服务的契约问题）：

| 症状 | 原因 | 处置 |
|---|---|---|
| `slot "sidebar.chat.conversation" is already declared` | 在 tab 条目里声明了 ui-subagent 已声明过的子槽；**槽声明全局独占** | 只声明**自有**子槽 `btw.conversation` |
| `cannot get property "sidebarRight" without inject` | 服务没写进 `inject` 时 `ctx.sidebarRight` 会抛（而不是返回 `undefined`） | 统一用 `ctx.get(name)`（`service()` 已封装） |
| 面板里只有开辟前的历史、新问答不出现 | `renderFactorySlot('conversation.content')` 渲染的是**当前作用域**的会话（父会话）；`SessionProvider` 只在条目声明了 session 作用域子槽时才注入 | 声明自有子槽 `btw.conversation`，并用 `<SessionProvider session={reference}>` 把面板绑到子会话 |
| 内容短时输入框不贴底 | 会话体外面少一层撑满高度的容器（官方是 `.olTFqa_root{width:100%;height:100%;min-height:0;display:flex}`） | 用 `PANEL_STYLE` 包一层（已有断言锁住） |

## 通知相关的症状

静音不生效 / 点通知没回右栏 / 重启后旧面板又开始提醒：见 [notifications.md](notifications.md)。

## 日志

- **宿主半部**：在 profile 的 `cordis.patch.yml` 给本插件设 `debug: true`，日志带
  `[dsh-btw-sidebar]` 前缀打到 dsh 进程输出（前台启动就是那个终端）。
- **客户端半部**：浏览器控制台，同样带 `[dsh-btw-sidebar]` 前缀；boot 审计错误在 `web boot:` 附近。
- **away-notify 的抑制状态**：浏览器控制台里 away-notify `op:'state'` 的响应含 `suppressed` 字段。
