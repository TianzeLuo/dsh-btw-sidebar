# dsh-btw-sidebar

**像 Codex 的 `/btw`：把当前会话在最后一个完成轮次处**分叉**出一条会话，开在 DSH 原生右侧栏里继续聊。官方的会话界面、完整工具能力、真实的文件副作用，主会话不被打断也不被污染。**

```text
/btw 这里为什么用 fork 而不是 spawn？
        ↓
主会话在最后一个完成轮次处分叉 → 右侧栏当前格里出现一个标签页
标题「侧边聊天 · 这里为什么用 fork…」，里面就是普通的会话界面（输入框/工具/审批都在）
        ↓
主会话继续跑。关掉面板 → 这条会话重新归档，从左侧列表消失
```

## 它做什么

- **`/btw <问题>` 一步直发**：主输入框敲完整一行回车即可。也可以敲 `/` 在菜单里选「侧边聊天」。
- **真分支**：宿主走 `ctx.sessionController.fork()`，种子是主会话**最后一个 `turn/end` 之前的完整事件前缀**，
  同时继承主会话的 agent preset 组合与工作目录。
- **官方会话界面**：右栏标签页的 body 直接渲染官方会话工厂槽 `conversation.content`，
  所以样式、输入框、模型选择、审批提示、工具调用展示与主对话**完全一致**——本插件一行 UI 都不画。
- **完整工具能力**：它就是一条普通会话里的普通 agent，能读写文件、跑命令、联网（受同一套沙箱与审批策略约束）。
  面板里的官方输入框还能传附件/图片。
- **开在当前格**：`/btw` 打开标签页时不带 `preferNewPane`，所以它落在右栏当前格，
  不会把默认页留在旁边、自己另开一格。
- **用完即归档**：面板打开时取消归档（归档中的会话跑不动模型步骤），关闭面板时重新归档，
  于是它平时不出现在左侧会话列表里。
- **零主对话污染**：不是子代理——不写主会话日志、不产生子代理目录条目、不会在结束/停止时唤醒主对话。

## 它不做什么 / 已知限制

1. **面板打开期间，这条会话会出现在左侧列表里**（标题是「侧边聊天 · …」）。
   这是平台硬约束，不是实现选择：`ArchivedSessionGate` 在 session controller 里无条件装载
   （`dsh-api-session-controller/lib/index.js:2821`），已归档的会话在 `agent/pre-step` 直接被 reject
   （同文件 `2384-2392`）。**要能干活就不能归档，不归档就会出现在列表里。** 关闭面板即归档，它随即消失。
2. **需要主会话至少有一个已完成的轮次**：没有完成轮次时 fork 没有切点，会返回一条可读错误。
3. **`/btw` 命令行本身不接受附件**（命令式输入不承载附件）；需要附件时在打开的面板里用官方输入框发。
4. **归档后的会话仍在磁盘上**：可以在左侧列表切到「已归档」视图找到并恢复它——这也是"回收站"式的安全网。
5. **模型路由**：fork 时用的是部署默认模型（`agentDefaultModel`），之后可在面板里用官方的模型选择器切换。
6. **`dsh-away-notify` 也会为侧边聊天弹通知**（因为它是普通会话，跑完一轮就触发 turn-complete），
   点通知会跳到那条会话。away-notify 目前只有按 kind 的开关，没有按会话标题前缀的忽略项；
   若需要，可以给它加一条「标题以『侧边聊天 ·』开头则跳过」的规则。

## 安装

```bash
dsh plugin --profile web add /mnt/f/project/tools/plugin/dsh-btw-sidebar
# 改的是客户端半部时：刷新页面即可（宿主每次请求都从磁盘读，revision 会重算）
# 改了 cordis.patch.yml / package.json 的 bundle 列表时：需要重启 dsh web
```

`cordis.patch.yml` 里的 `insert:` 行会由 `dsh plugin add` 自动追加进该 profile 的
`dsh.profile.bundles`；**不要**再手写同 id 的条目，否则启动会报 `duplicate loader entry id`。

卸载：

```bash
dsh plugin --profile web remove dsh-btw-sidebar
```

## 用法

```text
/btw 刚才那个 config 文件叫什么名字？
```

- 输入框立刻清空，右侧栏当前格出现「侧边聊天 · …」标签页，问题作为首条消息发出。
- 之后就在面板里正常聊天：工具调用、审批、附件、模型切换、停止，全部是官方行为。
- 关掉标签页 → 会话归档、从左侧列表消失；再打开它可在「已归档」视图里恢复。

## 依赖

| 依赖 | 为什么 |
|---|---|
| `@deepseek-ai/dsh-api-session-controller` | `ctx.sessionController.fork()` / `rename()`，以及客户端 `ctx.sessions.retain/binding` |
| `@deepseek-ai/dsh-api-workspace-controller` | `unarchiveSession()` / `archiveSession({ stopActivity: true })` |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | 原生右侧栏、tab 类型注册，以及 `ctx.sidebarRight.openResource()` |
| `@deepseek-ai/dsh-client-ui-conversation` | 提供官方会话工厂槽 `conversation.content`（面板渲染的就是它） |
| `@deepseek-ai/dsh-client-resources` | 自定义 `btw` 资源协议（一个资源 = 一条会话） |
| `@deepseek-ai/dsh-client-ui-input-trigger` | `/` 触发管道 |
| `@deepseek-ai/dsh-client-connection` | `/api` 精确路由通道（`POST /api/dsh-btw-sidebar`） |

以上在 DSH `0.1.7-rc.1` 的 `web` profile 里都是启用状态。**本插件只针对 `0.1.7-rc.1` 验证**，
不做跨版本兼容。

## 排障

**页面只剩「Failed to load plugins / dsh-btw-sidebar / web boot: 1 entry did not activate」**
—— 客户端插件 `apply` 抛了异常，DSH 的 boot 审计就拦下整个页面。看浏览器控制台里
`web boot:` 那条错误上方最近的一次异常即可定位。本插件历史上踩过三次：

| 症状 | 原因 | 处置 |
|---|---|---|
| `slot "sidebar.chat.conversation" is already declared` | 在 tab 条目里声明了 ui-subagent 已声明过的子槽；**槽声明全局独占** | 只声明**自有**子槽 `btw.conversation`（见下一行） |
| `cannot get property "sidebarRight" without inject` | 服务没写进 `inject` 时，`ctx.sidebarRight` 会抛（不是返回 `undefined`） | 用 `ctx.get(name)`（`service()` 已封装） |
| 面板里只有开辟前的历史、新问答不出现 | `renderFactorySlot('conversation.content')` 渲染的是**当前作用域**的会话（即父会话）；`SessionProvider` 只在条目声明了 session 作用域子槽时才注入 | 声明自有子槽 `btw.conversation`，用 `<SessionProvider session={reference}>` 把面板绑到子会话 |
| 内容短时输入框跟在最后一条消息下面，不贴底 | 会话体外面少了一层撑满高度的容器（官方用的是 `.olTFqa_root{width:100%;height:100%;min-height:0;display:flex}`） | 用 `PANEL_STYLE` 包一层（已有断言锁住） |

## 开发

```bash
cd /mnt/f/project/tools/plugin/dsh-btw-sidebar
node --test          # 33 项，全部离线，不碰网络、不读真实 home 目录、不调真实模型
```

三版实现的取舍与被否掉的两版原因，见 [docs/development.md](docs/development.md)。
