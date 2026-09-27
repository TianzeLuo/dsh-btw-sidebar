# 开发与设计记录

[← 返回 README](../README.md)

## 三版实现与两次否决（现在跑的是第三版）

需求里有一条是"侧边聊天不进左侧会话列表"，另一条是"要有完整工具能力 / 官方界面"。这两条在 DSH
`0.1.7-rc.1` 上**不能同时满足**，前两版分别撞在两边的墙上。

| 版本 | 做法 | 结果 |
|---|---|---|
| R1 子代理 | `ctx.subagents.startContinuable({ provider: 'fork' })` + 复用官方 `subagentchat` tab | 列表里绝对没有，但带来三个改不掉的委派副作用（下表） |
| R2 纯旁问 | 不建会话：自绘右栏面板 + 一次 `ctx.llm.stream()` | 列表与主日志都干净，但**没有工具、界面也不是官方的** → 被实测否决 |
| **A 普通 fork 会话（当前）** | `ctx.sessionController.fork()` + 官方面板 + 面板打开时取消归档 / 关闭时归档 | 官方界面 + 完整工具 + 零主对话污染；代价是**面板打开期间**会出现在左侧列表里 |

### R1 为什么被否掉

| 现象 | 机制 | 位置 |
|---|---|---|
| 用户消息被追加「Your parent agent id is … send your result …」 | continuable child 的首条任务被拼接返回指引（条件性：仅当 child 工具表里有相邻 `send_message`） | `dsh-subagent/lib/index.js:1738`，构造函数在 `:599` |
| 停止/结束子代理会唤醒主对话 | 结算时把 `createSettlementMessage()` 作为 user message 投递进**父 agent 的 inbox** | `dsh-subagent/lib/index.js:634` |
| 子代理目录里能点进 child，一点就变成全屏主视图 | 目录行点击的官方行为就是在主对话打开 | `dsh-client-ui-subagent` |

即使给 child 加 `toolFilter` 去掉 `send_message`（后缀会消失），**`establishCatalogChild()` 仍然无条件执行**
（`dsh-subagent/lib/index.js:1743`）：每次 `/btw` 都会往**主会话日志**写一条 `subagent/catalog` 事件，
还会让主会话 header 长出子代理计数触发器。加上结算通知无法静音，R1 与"完全隔离"直接冲突。

### R2 为什么被否掉

它用"根本不建会话"换来了列表与主日志的绝对干净，但因此：

- 没有 agent、没有工具循环 → 只能纯问答；
- 没有会话就没有 `conversation.content` 可渲染 → 面板只能自绘，样式与主对话对不上。

使用者实测后明确要求"完整工具能力 + 与主对话一致的样式"，这两条都要求**真会话**。

### 为什么 R1 的"隐藏"在 A 里退化成"用时可见"

`ArchivedSessionGate` 在 session controller 里**无条件装载**（`dsh-api-session-controller/lib/index.js:2821`）：

```js
const ArchivedSessionGate = {
  name: "archived-session-gate",
  inject: ["agents", "sessions", "workspaceRegistry"],
  apply(ctx) {
    ctx.on("agent/pre-step", (payload, next) =>
      underArchivedSession(ctx, payload.agent) ? Promise.resolve({ kind: "reject" }) : next());
  }
};
```

它对 `agent/pre-step` 直接 reject（同文件 `2384-2392`），所以**归档中的会话跑不动模型步骤**。
"建好就归档、然后在里面干活"这条捷径是死的。又因为：

- 客户端会话列表的分组函数只排除 `origin === 'subagent'`、非当前的 blank 会话、以及归档集合
  （`dsh-client-ui-workspace/lib/client.js:397` 的 `sessionVisible`）；
- `stray`（未归属任何 workspace 的会话）也会被塞进 "Ungrouped" 分组
  （同文件 `:478`），所以"不挂 workspace"也藏不住；
- 宿主 `session/list` 是**全语料**的（`dsh-api-session-controller/lib/index.js:1793`，活着的会话无条件入列）；

结论：一个普通会话只要还能干活，就必然在左侧列表里。唯一能绕开的是 `origin:'subagent'`，
而那正是 R1 三个副作用（外加审批被钉死为 `never`）的来源。使用者选择了"用时可见"。

## 架构

```text
浏览器                                            宿主进程
──────────────────────────────────────────────  ──────────────────────────────────────
/ 触发管道
 └─ 源 name='btw'
      candidates() → / 菜单一行「侧边聊天」
      matchEnter() → 认领 `/btw <问题>`
           │
           │ claim.submit(args)
           ▼
      POST /api/dsh-btw-sidebar ───────────────► connection.fetch 路由
      { action:'fork', parentSessionId,           ├─ ctx.sessionController.fork({ sessionId })
        question }                                │    （省略 atSeq = 最后一个完成轮次）
           │◄── { sessionId, address, title }     └─ rename → 「侧边聊天 · <摘要>」
           ▼
 ctx.sidebarRight.openResource(address)      ← 不带 preferNewPane：开在当前格
           │ 地址 = dsh-resource://btw/session/<childSessionId>
           ▼
 自定义 btw 资源 provider
      ├─ POST { action:'open', sessionId } ────► ctx.workspaceController.unarchiveSession()
      ├─ ctx.sessions.retain(sessionId, …)   ← 拿到 SessionReference
      └─ yield { sessionId, reference } → 流保持打开
           ▼
 自定义 tab 类型 'btw' → body：
      <SessionProvider session={reference}> renderSlot('btw.conversation') </SessionProvider>
           │    └─ 自有子槽组件 → renderFactorySlot('conversation.content')
           │   （官方会话 UI：输入框 / 工具 / 审批 / 模型选择，全部现成）
           ▼
 首条消息：ctx.sessions.binding(id).session.beginSubmission() → prompt(question)
           │
           │ 面板关闭 → 资源流 abort
           ▼
 finally: reference.release() → POST { action:'close' } ──► archiveSession({ stopActivity: true })
```

`openTabs` 清单观察是兜底：万一某个布局操作没有触发资源中止，地址从清单里消失时也会补一次归档。

## 与 dsh-away-notify 的接线

侧边聊天是**普通会话**，跑完一轮也会触发 away-notify 的 `turn-complete`。问题在于 away-notify 的
浏览器半部只上报**主视图**的会话（`byId[].retainedBy.mainView`），侧栏面板里的子会话不在其中——
宿主的在场判定认不出「用户正看着这条」，于是照弹（点通知还会跳到那条会话）。

三条被否掉的路：

| 做法 | 为什么不选 |
|---|---|
| away-notify 配标题前缀忽略（`侧边聊天 ·`） | 消费者替生产者猜语义：改个标题就失效，还会误伤别的插件 |
| 让 away-notify 按 `parentSession && isSeeded` 派生 | 用户原生的 `/fork` 会话同样满足，会把正常会话一起静音 |
| 把会话伪造成 `origin:'subagent'` | R1 已实测否决：子代理目录、结算唤醒主对话、审批被钉死 |

最终做法是**双向显式接口**，两侧都不需要知道对方的业务语义：本插件声明「什么条件下不打扰」和
「点通知去哪个界面」，away-notify 只负责记账、转发与执行。

```text
dsh-away-notify 宿主                            dsh-btw-sidebar 宿主 / 浏览器半部
ctx.provide('awayNotify', {                     ctx.inject(['awayNotify'], (c) => {
  suppressSession(sessionId, reason),             c.awayNotify.addRule({
  revealSession(sessionId, { resource }),           id: 'dsh-btw-sidebar', reason: 'dsh-btw-sidebar',
  addRule({ id, reason, match }),                   match: (sid, ev, ctx) => sideChats.has(sid) &&
  isSuppressed / revealFor / snapshot,                     (ev?.kind === 'turn-aborted' ||
})                                                          (displayed.has(sid) && ctx.pageAttended)),
                                                  })
                                              ──► fork/open: revealSession(sid, { resource: btwSessionAddress(sid) })
                                              ──► 浏览器半部：官方 useTabInfo().tab.visible 变化
                                                  → POST {action:'visible', sessionId, visible}
```

生命周期与语义：

| 时机 | 谁做 | 结果 |
|---|---|---|
| `fork` 成功 | 宿主：记入 `sideChatSessions`，声明揭示目标 `dsh-resource://btw/session/<id>` | 点通知时能回到右栏那个 tab |
| 面板显示在右栏 | 浏览器：`tab.visible` 变 true → 上报 `visible:true` | 面板显示中且页面被看着 → 不打扰 |
| 面板在后台（右栏切到别的 tab / 折叠 / 主视图换会话） | 浏览器：`tab.visible` 变 false → 上报 `visible:false` | 照常提醒（这时通知才有用）；点 → 右栏 tab |
| 你切到别的应用（页面失焦） | 无需动作：规则里的 `pageAttended` 变 false | 照常提醒 |
| 任意轮次 `turn-aborted` | 宿主：规则直接命中 | 永不提醒（只可能来自你点停止 / 关面板） |
| `close`（面板关闭） | 宿主：从 `openSideChats` / `visibleSideChats` 移除 | 不再抑制（会话已归档，本来也跑不了轮次） |

要点：

- **「面板可见」用官方信号，不自己猜**：`useTabInfo().tab.visible` 由
  `dsh-client-ui-sidebar-right` 的 `tabInfoFactory` 计算——
  `active && (pane.host === 'float' || layout.expanded && (title || pane.activeTabId === tabId))`，
  即「前景会话 && (浮动面板 || 右栏展开且是本格的活动 tab)」。折叠、分屏、浮动三种布局它都算对了，
  本插件不需要读布局、也不需要轮询。上报只在**值变化**时发（React 会反复求值同一个值），组件卸载
  时补一次 `visible:false`（切走 tab / 关面板），免得宿主那边残留「它正被看着」。
- **顺序**：`fork()` 返回后**同一 tick** 内登记揭示目标，早于面板发首条消息；抑制要等浏览器把
  `visible:true` 报上来——而面板可见一定早于首条 prompt（客户端 `openSession` 里先
  `await callHost({action:'open'})`，之后才 `retain` 出可供提交的 binding）。
- **旧 bundle 兜底**：宿主重启但页面没刷新时，页面上跑的浏览器半部不会上报可见性。此时退回
  「面板开着（`open`）且你在看 dsh 就静音」——即上一版语义，避免退化成最初那个误弹。收到任何一次
  可见性上报后，兜底立即失效、以真实可见性为准。
- **aborted 永久豁免**：面板关闭走 `archiveSession({ stopActivity: true })`，它会真的停掉会话里
  正在跑的工作并产出一轮 `turn/end: aborted`。若让那一轮按常规规则走，每次关面板都会弹一条
  「任务已停止」——而它只可能来自你自己的操作，纯噪声。
- **点击落点由本插件给地址、away-notify 转发**：浏览器半部拿到 reveal 后先
  `ctx.sidebarRight.openResource(地址)`；右栏按 `contentId` 查重，**已开着的 tab 会被聚焦而不是
  新开一个**。地址对 away-notify 是不透明字符串，它不认识 `btw` 协议。
- **降级**：`awayNotify` 服务缺失（away-notify 没装 / 版本旧）时只跳过声明，`/btw` 全流程不受
  影响，点击退回「切主视图那条会话」；`suppressNotifications: false` 只关抑制，揭示目标照常登记。
- **回归锁**：`test/wiring.test.mjs` 有一条用例专门断言「标题同样以『侧边聊天 ·』开头、但不是本
  插件 fork 出来的会话**不会**被抑制」，防止将来有人把接口退化成关键词匹配；另有两条锁住
  「可见性变化才上报」（含卸载补报）与「从没上报过时的兜底」。
- **可重跑的集成检查**：`node .probe/verify-away-notify-suppression.mjs`（工作区根目录下）把两个
  插件的宿主半部装进同一个最小 cordis 语境，真跑一遍「fork → 揭示目标 → 面板显示中被看着就静音 →
  面板在后台恢复提醒 → 切走恢复提醒 → `pending-focus` 带回 reveal → 关面板后恢复 → aborted 永不
  提醒 → 主会话不受影响」。两个包各自的 `node --test` 覆盖不到**跨包的服务注册与消费**这一环，
  这条脚本补的就是它。
- **已知缺口**：策略集合是宿主进程内的内存态。dsh 重启后，早期 fork 出来的侧边聊天若被从
  「已归档」手动恢复，会失去「被看着不打扰」与「点击回右栏」这两项待遇——没有再打开一次右栏面板
  （`open` 会补登记）就一直如此。DSH 没有可写的会话标记位（`SessionForkRequest` 只有
  `sessionId`/`atSeq`；session header 无扩展字段，`origin` 只允许 `'subagent'`），所以这个缺口堵不上。

## DSH 契约上的坑（本插件踩到/绕开的）

- **`preferNewPane: true` 会真的裂格。** 当"当前格已有 tab、可拆分、且不足两格"成立时走
  `planSplitPane`（`dsh-client-ui-sidebar-right/lib/client.js:4926`、判定在 `:6074`），
  于是默认 guide 页留在左格、新 tab 掉进右格——这正是第一轮实测里"空侧栏 + 最右侧 1/4"的原因。
  开在当前格就**不要传这个参数**。
- **必须用 `ctx.inject([...])` 等 `resources` / `sidebarRightTabs` 就绪，不能用 `ctx.get()` 判一次。**
  这两个服务分别由 `dsh-client-resources`（`ctx.reflect.provide("resources", …)`）与
  `ui-sidebar-right` 提供，时机可能晚于本插件的 `apply`。判一次就放弃的后果是**永久不注册**：
  tab 类型在、资源 provider 不在，于是 tab 能打开、面板永远空白——第二轮实测就是这个症状。
  官方 `ui-subagent` 同样把这两个放进 `ctx.inject(["resources","sidebarRightTabs"], scope => …)`。
- **绝不声明 `sidebar.chat.conversation` 这个 children。** 槽声明是**全局独占**的：
  `slots.register()` 会对 `options.children` 的每个 key 查 `records.get(key).spec !== undefined`
  并抛 `slot "…" is already declared (by …)`（`dsh-web-frontend` 的槽注册表；`registerFactory`
  里有同一条规则）。而 `sidebar.chat.conversation` 已被 **ui-subagent 的 tab 条目**声明
  （槽目录：`declaredBy: "an entry in 'sidebar.right.pane.tab' (client-ui-subagent)"`），
  于是我们这一声明必然抛错 → `apply` 抛 → fiber 变 `failed` → 客户端 boot 审计失败
  （`web boot: 1 entry did not activate` / 页面只剩失败遮罩）。**这就是重启后打不开 dsh 的原因。**
- **要显示"别的会话"，必须自己声明一个 session 作用域子槽来换 `SessionProvider`。**
  `renderFactorySlot('conversation.content')` 渲染的是**当前会话作用域**里的会话；不重新绑定就是
  面板所属的**父会话**——第三轮实测的症状正是"面板里只有开辟前的历史，新问题与新回答（都在子会话里）
  完全不出现"。重新绑定只能用框架注入的 `SessionProvider`，而按 `PropsRenderSlots` 的规则，
  它**只注入给声明了 `session` / `session-maybe` 子槽的条目**
  （`[Extract<ScopeOf<S>,'session'|'session-maybe'>] extends [never] ? {} : { SessionProvider }`）；
  又不能拿官方 `sidebar.chat.conversation` 当那个子槽（全局独占，见上一条）。所以本插件声明了
  **自己的**子槽 `btw.conversation`（`{ kind:'single', scope:'session' }`），用
  `slots.inject('btw.conversation', …)` 给它注册组件，body 里
  `<SessionProvider session={reference}>{renderSlot('btw.conversation')}</SessionProvider>`，
  子槽组件再渲染 `renderFactorySlot('conversation.content', …)`。工厂的三个输入属性都是必填
  （`ConversationContentInputProps`：`variant` / `phase` / `hero`）；`views` 固定
  `renderSlot('conversation.session', { view:'chat' })`，侧栏里不放视图切换器。
- **`ctx.get(name)` 才是客户端的可选查找，`ctx.name` 不是。** cordis 的 ctx 属性代理对
  **没写进 `exports.inject` 的服务**直接抛 `cannot get property "x" without inject`；
  而 `ctx.get` 服务缺失时返回 `undefined`、已声明与否都不抛。实测（0.1.7-rc.1）：
  `ctx.get('sidebarRight')` 有值、`ctx.sidebarRight` 抛错。插件里的 `service(ctx, key)` 统一走
  `ctx.get`，缺服务只降级成少一条通路，不再把 apply 拖崩。
- **面板 body 任何异常都要渲染成可见文案，绝不 `return null`。** 右栏对 body 的内部错误是静默的，
  空白面板无法与"还没加载"区分；资源 provider 里也不允许抛（流内抛错是编程错误、不会被捕获），
  失败要变成一帧带 `error` 的值——**并且要把真实原因带进文案**（只写"无法打开"会让排查无从下手）。
- **`retain()` 会顺带打开会话**（`reference.attachOpening(manager.get(id).open(), signal)`），
  但 `sessions.binding(id)` 要等 retain 之后才出现，所以发首条消息前需要就绪轮询。
- **面板根容器必须撑满高度。** 官方 `ui-subagent` 侧栏聊天 tab 的根类是
  `.olTFqa_root{width:100%;min-width:0;height:100%;min-height:0;display:flex}`
  （`dsh-client-ui-subagent/lib/client.js:686` 的 CSS-module 映射），作用就是把官方会话体
  撑满面板。没有它，会话体按内容高度排布：内容短的时候输入框紧跟在最后一条消息下面，
  而不是贴在面板底部（第四轮实测）。本插件用等价的 `PANEL_STYLE` 内联样式包一层，
  并有断言锁住 `height:100%` + `display:flex`。
- **官方 `sidebar.chat.conversation` 既不能声明也不能注册。** 它是 `single` 槽，已被 ui-subagent
  声明并注册；我们只用**自有**的 `btw.conversation` 子槽 + 官方工厂槽 `conversation.content`。
- **`registerCloseHandler(kind, …)` 是按 kind 的**，抢 `subagentchat` 会影响所有子代理聊天；
  我们用自己的 kind `btw`，并且关闭收尾放在资源流的 `finally` 里。
- **`beginSubmission` 需要 `attachments` 数组**，`prompt(content, mode, signal, requestId)` 的
  `requestId` 必须来自它；`SessionRequestId` 没有导出铸造函数，所以首条消息只能走客户端会话面，
  不能由宿主自己造 identity。
- **`archiveSession` 需要 `stopActivity: true`**：否则归档进行中的会话会被拒为 `workspace/session-active`。
- **客户端 factory 必须 `return module.exports`**；bundle 是经典脚本单文件，只能 require seed
  模块与 `dsh.client.external` 里点名的包。本插件只 require `react`。
- **`/` 触发源的裁决顺序是按注册顺序取第一个非 undefined 的答案。** `ui-commands` 先加载，
  但它的 `matchEnter` 对 `btw` 这个名字 `resolve()` 失败后会 `return void 0`，于是轮到我们认领。

## 测试

```bash
node --test      # 47 项，全部离线
```

| 文件 | 覆盖 |
|---|---|
| `test/protocol.test.mjs` | 行解析（含 `/btwx`/`/compact`/非字符串等不该吞的输入）、会话地址往返回环与拒绝、标题摘要与前缀 |
| `test/wiring.test.mjs` | 宿主：路由契约、fork + rename、rename 失败不影响可用性、fork 失败可读化、参数校验、open 取消归档（失败不阻断）、close 带 `stopActivity`、归档失败上报、注册抛错不冒泡、**与 `awayNotify` 的接线（apply 时注册规则、fork 后登记揭示目标、`open`/`close` + 浏览器上报的官方 `tab.visible` 驱动「显示在右栏且被看着才静音」、aborted 永久豁免、只按会话 id 匹配不做标题匹配、服务缺失/开关关闭不影响 `/btw`）**；浏览器：bundle 契约、资源协议/tab 类型/**body 不声明 children**、`/` 源认领与附件拒绝、submit 端到端（**不得带 `preferNewPane`**、发首条消息的 content/mode/requestId）、整行 args 防御、404/宿主失败/右栏缺失的可读错误、首条消息失败如实回显、就绪超时提示、资源 open/abort 的取消归档→retain→release→归档、资源流内失败变成 error 帧（**含真实原因**）、地址无效的可见帧、取消归档失败只告警、关闭兜底；**面板在 status=none/failed/error/缺工厂槽/就绪时的可见文案与就绪时渲染官方 `conversation.content` 工厂槽** |
| `test/manifest.test.mjs` | `package.json` / `cordis.patch.yml` / 客户端 bundle 的安装契约 |

测试替身按真机契约提供 `ctx.get(name)`（而不是把服务挂成 `ctx.sidebarRight` 这类属性）：
真机上读未声明服务会抛，替身若用属性模拟就会把这条失败路径**静默放过**。

## 验收状态

- [x] 离线测试 47/47 通过。
- [x] 本机 `0.1.7-rc.1` 的 API 面逐条核对过（见上文各文件行号）。
- [x] 已装进 `web` profile（link + `dsh.profile.bundles`）。
- [x] 在 `0.1.7-rc.2` 上复验（2026-09-27）：Linux/WSL 日常使用正常；Windows 用
      `scripts/install-windows.ps1` 装入 `web` profile 后 `dsh --profile web --dump-config`
      组合出 `- id: dsh-btw-sidebar`，宿主模块可 `import`，离线测试 47/47 全绿（Windows node v24.11.0）。
      Windows 上面板交互的实机验收仍建议自行跑一次 `/btw`。
- [x] **已在重启后的真机上验收**（0.1.7-rc.1 / WSL）：boot 无 `web boot: … did not activate`，
      浏览器控制台无异常；`/btw <问题>` 走通 fork（宿主返回地址）→ 右栏开出 tab
      「侧边聊天 · <摘要>」→ 面板内渲染官方会话内容（真实消息、时间戳、工具行、输入区）。
      这一步是用无头 Chrome + CDP 实测的（见 `.probe/`）。
- [x] 真机验收已覆盖：`sessionController.fork` 需要主会话**存在已完成轮次**（没有时报
      `FORK_FAILED: … has no completed turn to fork from`，属预期）；tab 标题跟随会话标题；
      面板关闭时的归档兜底。
- [ ] 未在真机验证：资源流中止（面板关闭）与归档的实际触发点、`/btw` 首条消息发出的完整时序
      （无头环境无法让模型真正跑一轮）。
- [x] 已知副作用「侧边聊天会触发 away-notify 弹通知」已修：本插件通过 `awayNotify` 服务声明
      「面板开着且你在看时不打扰」「点通知回到右栏那个 tab」「aborted 永不提醒」，只按自己 fork
      出来的会话 id 匹配、不做标题/关键词匹配；接口缺失时退回旧行为。详见
      [与 dsh-away-notify 的接线](#与-dsh-away-notify-的接线)。
- [ ] 未在真机验证：通知接线端到端（`/btw` 跑完一轮确实不弹、切走后确实弹、点通知确实回到右栏
      那个 tab 且多 tab 时不串）。离线用例覆盖到「策略声明 → 决策链路 → 揭示目标透传 → 浏览器半部
      的路由选择」，跨插件服务可见性也按真机先例（`workspaceChanges`）核对过，但仍需一次实机确认；
      真机验证时记得到页面控制台查 `op:'state'` 的 `suppressed`。

## 后续可做

1. 面板关闭时是否要"保留为普通会话"（现在一律归档，可在「已归档」视图恢复）。
2. 选中文本 → 侧边聊天（把选区作为首条消息的引用注入）。
3. 如果 DSH 将来提供"不进列表的普通会话"原语，可以把注释里的 `origin:'subagent'` 路线接回来，
   彻底去掉"用时可见"这条代价。
