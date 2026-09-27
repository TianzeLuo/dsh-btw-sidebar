/**
 * client.js — dsh-btw-sidebar 的浏览器半部（方案 A：普通 fork 会话，右栏显示）。
 *
 * 三件事：
 *   1. 往 `/` 触发管道注册一个 `btw` 源，认领 `/btw <问题>`；提交时请宿主 fork 一条会话，
 *      在当前右栏格里打开它（**不带 `preferNewPane`**，见下），然后把问题作为首条消息发出去。
 *   2. 注册 `btw` 资源协议：地址就是那条会话。资源打开时先让宿主**取消归档**（归档中的会话
 *      跑不动模型步骤），并保留它的 `SessionReference`；资源中止（面板关闭）时释放引用并让宿主
 *      重新归档。
 *   3. 注册自己的右栏 tab 类型，body 直接渲染**官方的会话内容槽**
 *      `sidebar.chat.conversation`（由 `@deepseek-ai/dsh-client-ui-subagent` 提供），
 *      所以样式、输入框、模型选择、审批、工具调用全部与主对话一致——本插件一行 UI 都不画。
 *
 * 两个关键写法（都踩过）：
 *   - **必须用 `ctx.inject([...])` 等服务就绪**，不能用 `ctx.get()` 判一次就放弃。
 *     资源 provider 与 tab 类型分别由 `dsh-client-resources` 与 `ui-sidebar-right` 用
 *     `ctx.reflect.provide()` 提供，时机可能晚于本插件的 `apply`；一次性判断会导致
 *     「tab 能打开、面板永远空白」这种静默失败（官方 ui-subagent 也是用 `ctx.inject`）。
 *   - **面板任何异常都要渲染成可见文案**，不能 `return null`：右栏对 body 的内部错误是
 *     静默处理的，空白面板无法与"还没加载"区分。
 *
 * 为什么不用 `preferNewPane`：它在「当前格已有 tab、可拆分、且不足两格」时会真的分裂出新格
 * （`dsh-client-ui-sidebar-right/lib/client.js:4926` 的 `planSplitPane`、`:6074` 的判定），
 * 结果就是默认的 guide 页留在左格、我们的 tab 掉进新开的右格。
 *
 * 约束（dsh 0.1.7，见 dsh-client-modules 的加载契约）：
 *   - 客户端 bundle 必须以 `window.__ModuleLoader__.load({ id, factory })` 形式导出。
 *   - 只能 require seed 静态模块与 `dsh.client.external` 里声明过的包；本模块只 require `react`。
 *   - factory 必须 `return module.exports`，否则插件会**完全静默**地不加载。
 */

window.__ModuleLoader__.load({
  id: 'dsh-btw-sidebar',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** 本插件独占的 locale 命名空间。 */
    const NS = 'btw-sidebar'
    /** 命令名（不带斜杠）。 */
    const COMMAND = 'btw'
    /** 宿主半部注册的精确路径，两侧必须逐字一致。 */
    const ROUTE_PATH = '/api/dsh-btw-sidebar'
    /** 资源协议名、地址前缀、tab 类型 id，必须与 lib/protocol.js 逐字一致。 */
    const PROTOCOL = 'btw'
    const SESSION_PREFIX = 'dsh-resource://btw/session/'
    const TAB_ID = 'dsh-btw-sidebar'
    /**
     * 官方会话工厂槽（由 `@deepseek-ai/dsh-client-ui-conversation` 注册）。
     *
     * 走工厂槽而不是 `sidebar.chat.conversation`：后者被 ui-subagent 的 tab 条目
     * 独占声明，见 `BtwChatTab` 的说明。
     */
    const CONTENT_FACTORY = 'conversation.content'
    /**
     * 本插件自己的会话子槽名。
     *
     * 它只需要存在，作用是让框架按 `PropsRenderSlots` 把 `SessionProvider` 注入给 tab body；
     * 用一个自有名字是为了避开官方 `sidebar.chat.conversation` 的独占声明。
     */
    const BTW_CONVERSATION_SLOT = 'btw.conversation'
    /** 等会话就绪（可以发首条消息）的上限。 */
    const READY_TIMEOUT_MS = 5_000
    /** 就绪轮询间隔。 */
    const READY_POLL_MS = 60
    /** 面板状态文案的样式（只在出问题时才画东西）。 */
    const NOTE_STYLE = { padding: '12px', fontSize: '12px', opacity: 0.72, lineHeight: 1.6 }
    /**
     * 面板根容器样式：照抄官方 `ui-subagent` 侧栏聊天 tab 的根类
     * （`.olTFqa_root{width:100%;min-width:0;height:100%;min-height:0;display:flex}`）。
     *
     * 少了它，官方会话体会按内容高度排布：内容短的时候输入框紧跟在最后一条消息下面，
     * 而不是贴在面板底部（这正是第四轮实测的显示问题）。官方 tab 能贴底就是靠这一层。
     */
    const PANEL_STYLE = { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex' }

    // ───────────────────────────────────────────────────────────────────────
    // 文案
    // ───────────────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        'cmd.label': '侧边聊天',
        'cmd.description': '在当前会话旁开一条分支，在右侧栏里对话（完整工具能力）',
        'cmd.hint': '<问题>',
        'tab.title': '侧边聊天',
        'panel.loading': '正在载入侧边聊天…',
        'panel.noProvider': '侧边聊天面板不可用：resources 服务缺失（需要 @deepseek-ai/dsh-client-resources）。',
        'panel.noSlot': '侧边聊天面板不可用：会话内容工厂槽缺失（需要 @deepseek-ai/dsh-client-ui-conversation）。',
        'panel.noSessionProvider': '侧边聊天面板不可用：会话作用域绑定缺失（无法把面板切到侧边会话）。',
        'panel.noSession': '侧边聊天面板不可用：会话服务缺失。',
        'panel.retainFailed': '无法保留侧边聊天会话',
        'panel.badAddress': '侧边聊天地址无效。',
        'panel.failed': '侧边聊天面板加载失败。',
        'error.noQuestion': '用法：/btw <问题>',
        'error.attachments': '/btw 不支持附件，请先移除附件再发送',
        'error.unreachable': '侧边聊天服务不可用：宿主半部没有注册 /api/dsh-btw-sidebar',
        'error.sidebar': '右侧栏不可用：需要 @deepseek-ai/dsh-client-ui-sidebar-right',
        'error.notSent': '侧边聊天已打开，但首条消息没能发出：{reason}',
      },
      en: {
        'cmd.label': 'Side chat',
        'cmd.description': 'Fork this conversation and keep talking in the right Sidebar (full tools)',
        'cmd.hint': '<question>',
        'tab.title': 'Side chat',
        'panel.loading': 'Loading side chat…',
        'panel.noProvider': 'Side chat panel unavailable: the resources service is missing (@deepseek-ai/dsh-client-resources).',
        'panel.noSlot': 'Side chat panel unavailable: the conversation content factory is missing (@deepseek-ai/dsh-client-ui-conversation).',
        'panel.noSessionProvider': 'Side chat panel unavailable: the session-scope binding is missing.',
        'panel.noSession': 'Side chat panel unavailable: the sessions service is missing.',
        'panel.retainFailed': 'Could not retain the side-chat session',
        'panel.badAddress': 'Invalid side-chat address.',
        'panel.failed': 'Side chat panel failed to load.',
        'error.noQuestion': 'Usage: /btw <question>',
        'error.attachments': '/btw accepts no attachments — remove them before sending',
        'error.unreachable': 'Side-chat service unavailable: the host half did not register /api/dsh-btw-sidebar',
        'error.sidebar': 'Right Sidebar unavailable: @deepseek-ai/dsh-client-ui-sidebar-right is required',
        'error.notSent': 'Side chat opened, but the first message could not be sent: {reason}',
      },
    }

    // ───────────────────────────────────────────────────────────────────────
    // 纯逻辑（与 lib/protocol.js 逐字对应，两侧不可漂移）
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 解析一行输入，判断是不是我们的 `/btw <问题>`。
     *
     * @param {unknown} line - 输入框整行文本。
     * @returns {{ mine: boolean, question: string }} 解析结果。
     */
    function parseBtwLine(line) {
      const text = typeof line === 'string' ? line.trim() : ''
      const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text)
      if (match === null) return { mine: false, question: '' }
      return { mine: true, question: (match[1] ?? '').trim() }
    }

    /**
     * 拼一条右栏会话资源地址。
     *
     * @param {string} sessionId - 会话 id。
     * @returns {string} 规范资源地址。
     */
    function btwSessionAddress(sessionId) {
      return `${SESSION_PREFIX}${encodeURIComponent(sessionId)}`
    }

    /**
     * 从资源地址里取回会话 id。
     *
     * @param {unknown} address - 资源地址。
     * @returns {string | undefined} 会话 id。
     */
    function parseBtwSessionAddress(address) {
      if (typeof address !== 'string') return undefined
      let url
      try {
        url = new URL(address)
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      try {
        const id = decodeURIComponent(parts[1])
        return id === '' ? undefined : id
      } catch {
        return undefined
      }
    }

    /**
     * 安全读取一个客户端服务。
     *
     * 客户端 context 是 cordis 的属性代理：读**没写进 `exports.inject` 的服务**会直接抛
     * `cannot get property "x" without inject`（不是返回 undefined）。而 `ctx.get(name)`
     * 是官方的**可选查找**（服务缺失返回 undefined、已声明与否都不抛），所以这里统一走它，
     * 让"缺服务"降级成少一条通路，而不是让 apply 抛错、整个 web boot 被拦下。
     *
     * 实测（0.1.7-rc.1 / client-ui-sidebar-right 在位）：
     *   `ctx.get('sidebarRight')` → object，而 `ctx.sidebarRight` → 抛错。
     *
     * @param {object} ctx - 客户端插件上下文。
     * @param {string} key - 服务名。
     * @returns {any} 服务实例，缺失时为 undefined。
     */
    function service(ctx, key) {
      try {
        if (typeof ctx.get === 'function') return ctx.get(key)
        return ctx[key]
      } catch {
        return undefined
      }
    }

    /**
     * 调宿主半部。
     *
     * @param {object} payload - `{ action, ... }`。
     * @returns {Promise<object>} 宿主返回的 JSON。
     */
    async function callHost(payload) {
      const response = await fetch(ROUTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return await response.json()
    }

    /**
     * 已经上报过的面板可见性：`sessionId -> visible`。
     *
     * 右栏切 tab / 折叠、主视图换会话都会让它变化，但同一个值会被反复求值（React 重渲染），
     * 所以只有**变化**才发请求。
     */
    const reportedVisibility = new Map()

    /**
     * 上报「这条侧边聊天的面板此刻是否真的显示在右栏」。
     *
     * 宿主据此决定要不要静音：**面板真的显示着、且你正看着 dsh 时才不打扰**；面板在后台
     * （右栏切到了别的 tab、右栏折叠、主视图换成了别的会话）时照常提醒——那才是通知有用的
     * 时候。
     *
     * 判据用官方给的 `useTabInfo().tab.visible`（`dsh-client-ui-sidebar-right` 的
     * `tabInfoFactory` 算的是「前景会话 && (浮动面板 || 右栏展开且是本格的活动 tab)」），
     * 所以分屏、浮动、折叠都不用本插件自己猜。
     *
     * @param {string} sessionId - 侧边聊天会话 id。
     * @param {boolean} visible - 面板此刻是否可见。
     */
    function reportPanelVisibility(sessionId, visible) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const next = visible === true
      if (reportedVisibility.get(sessionId) === next) return
      reportedVisibility.set(sessionId, next)
      callHost({ action: 'visible', sessionId, visible: next }).catch((error) => {
        // 上报失败就退回「没上报过」，下次渲染重试；上报本身绝不影响面板
        reportedVisibility.delete(sessionId)
        console.warn(`[btw-sidebar] 面板可见性上报失败: ${String(error?.message ?? error)}`)
      })
    }

    /**
     * 可被 abort 打断的睡眠。
     *
     * @param {number} ms - 毫秒。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<void>} 到点或被取消时 resolve。
     */
    function sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted === true) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    }

    /** 等一个信号被中止。 */
    function waitForAbort(signal) {
      return new Promise((resolve) => {
        if (signal.aborted === true) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // 发首条消息
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 把问题作为新会话的首条消息发出去。
     *
     * 走官方客户端会话面（`beginSubmission` → `prompt`）：本地回声、失败提示都与官方输入框一致，
     * `requestId` 也由它铸造。会话要等 retain 之后才出现在 `sessions.binding()` 里，所以轮询到就绪。
     *
     * @param {object} ctx - 客户端插件上下文。
     * @param {string} sessionId - 目标会话。
     * @param {string} question - 首条消息。
     * @param {number} [timeoutMs] - 等会话就绪的上限。
     * @returns {Promise<{ ok: true } | { ok: false, reason: string }>} 发送结果。
     */
    async function sendFirstPrompt(ctx, sessionId, question, timeoutMs = READY_TIMEOUT_MS) {
      const sessions = service(ctx, 'sessions')
      if (sessions === undefined) return { ok: false, reason: '会话服务不可用' }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const session = sessions.binding(sessionId)?.session
        if (session !== undefined) {
          const submission = session.beginSubmission({ mode: 'queue', text: question, attachments: [] })
          try {
            const result = await session.prompt(
              [{ type: 'text', text: question }],
              'queue',
              undefined,
              submission.requestId,
            )
            if (result?.ok === true) return { ok: true }
            submission.abandon()
            return { ok: false, reason: String(result?.error?.message ?? '未被接受') }
          } catch (error) {
            submission.abandon()
            return { ok: false, reason: String(error?.message ?? error) }
          }
        }
        await sleep(READY_POLL_MS)
      }
      return { ok: false, reason: `会话未能在 ${Math.round(timeoutMs / 1000)} 秒内就绪，请在面板里直接输入问题` }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 面板
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 我们自己的会话子槽组件：在 `SessionProvider` 建立的会话作用域里渲染官方会话工厂。
     *
     * `renderFactorySlot` 由渲染器无条件提供给每个组件（`PropsRenderFactories`），
     * 它渲染出来的整棵子树（消息流 + 输入框 + 模型选择 + 审批入口）都跟着**当前作用域里的会话**走。
     *
     * @param {{ renderFactorySlot: Function }} props - 渲染器注入的工厂渲染能力。
     * @returns {import('react').ReactNode} 官方会话内容。
     */
    function BtwConversation({ renderFactorySlot }) {
      return renderFactorySlot(
        CONTENT_FACTORY,
        // 三个字段都是必填（ConversationContentInputProps）。
        { variant: 'embedded', phase: 'active', hero: false },
        { slots: { views: BtwConversationViews } },
      )
    }

    /**
     * 会话视图位置：固定选 chat，不显示官方的视图切换器（侧栏里没有它的位置）。
     *
     * @param {{ renderSlot: Function }} props - 工厂局部组件的注册 props。
     * @returns {import('react').ReactNode} 会话体。
     */
    function BtwConversationViews(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    /**
     * 右栏 tab 的 body：把资源里的子会话 `SessionReference` 绑进作用域，再渲染我们自己的子槽。
     *
     * 为什么要自己声明一个子槽（`BTW_CONVERSATION_SLOT`）：
     *
     *   - 面板要显示的是 **fork 出来的子会话**，而 `renderFactorySlot('conversation.content')`
     *     渲染的是**当前会话作用域**里的会话——不重新绑定的话就是面板所属的父会话。
     *     症状：面板里只有开辟前的历史，新问题与新回答（都在子会话里）完全不出现。
     *   - 重新绑定只能用框架注入的 `SessionProvider`，而按 `PropsRenderSlots` 的规则，
     *     它**只注入给声明了 session / session-maybe 子槽的条目**（没有 children 就没有它）。
     *   - 又不能用官方的 `sidebar.chat.conversation` 当那个子槽：它是 `single` 槽，
     *     已被 `@deepseek-ai/dsh-client-ui-subagent` 声明，而槽声明是**全局独占**的，
     *     重复声明会抛 `slot "…" is already declared`，把整个 web boot 打挂。
     *
     * 所以：声明一个**我们自己的**同作用域子槽（`btw.conversation`），拿到 `SessionProvider`，
     * 把子会话绑进去，再由那个子槽的组件渲染官方工厂。
     *
     * 所有异常分支都渲染成可见文案：右栏会静默吞掉 body 的渲染错误，空白面板没法排查。
     *
     * @param {object} props - 插槽运行时 props（含闭包注入的 `t` 与 `onPanelVisibility`）。
     * @returns {import('react').ReactNode} 面板内容。
     */
    function BtwChatTab({ useResource, useTabInfo, SessionProvider, renderSlot, t, onPanelVisibility }) {
      const { tab } = useTabInfo()
      const resource = useResource(tab.contentId)
      // 面板可见性：`tab.visible` 是官方给的「这条 tab 此刻是否显示在右栏」（含折叠/分屏/浮动）。
      // 值变化时上报一次；组件卸载（切走 tab / 关面板）时补一次「不可见」——这样宿主那边
      // 不会残留「它正被看着」而把通知误静音。
      const sessionId = parseBtwSessionAddress(tab.contentId)
      const visible = tab.visible === true
      React.useEffect(() => {
        if (typeof onPanelVisibility === 'function') onPanelVisibility(sessionId, visible)
      }, [onPanelVisibility, sessionId, visible])
      React.useEffect(
        () => () => {
          if (typeof onPanelVisibility === 'function') onPanelVisibility(sessionId, false)
        },
        [onPanelVisibility, sessionId],
      )
      const note = (text) => h('div', { style: NOTE_STYLE }, String(text))

      if (resource === undefined || resource.status === 'none') return note(t('panel.noProvider'))
      if (resource.status === 'failed') return note(resource.failure?.message ?? t('panel.failed'))
      const value = resource.value
      if (value === undefined) return note(t('panel.loading'))
      if (value.error !== undefined) return note(value.error)
      if (typeof SessionProvider !== 'function') return note(t('panel.noSessionProvider'))
      if (typeof renderSlot !== 'function') return note(t('panel.noSlot'))
      // 关键一步：把子会话绑进作用域，官方会话体才会跟着子会话走。
      // 外面那层撑满高度的容器不可省：官方会话体靠它把输入框压到面板底部。
      return h(
        'div',
        { style: PANEL_STYLE, 'data-btw-panel': '' },
        h(SessionProvider, {
          session: value.reference,
          children: renderSlot(BTW_CONVERSATION_SLOT, {}),
        }),
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    // 插件入口
    // ───────────────────────────────────────────────────────────────────────

    /**
     * @param {import('cordis').Context} ctx 客户端插件上下文。
     * @param {{ readyTimeoutMs?: number }} [config] 可选覆盖（等会话就绪的上限）。
     */
    function apply(ctx, config = {}) {
      const readyTimeoutMs =
        typeof config?.readyTimeoutMs === 'number' && config.readyTimeoutMs > 0 ? config.readyTimeoutMs : READY_TIMEOUT_MS
      ctx.effect(() => ctx.locale.register(NS, DICT), 'btw-sidebar: dictionaries')
      const t = ctx.locale.bind(NS)

      /** `address -> { sessionId, phase }`；tab 关闭探测的兜底。 */
      const tracked = new Map()

      /**
       * 资源 provider：一个资源就是一条会话。
       *
       * 顺序很关键：先让宿主取消归档（否则后续 prompt 会被归档闸门挡掉），再 retain 出
       * `SessionReference`。中止时反过来——先释放引用，再归档。
       *
       * 这个生成器**不允许抛**（资源模型把流内抛错当成编程错误、不捕获），所以每一步失败都
       * 变成一帧带 `error` 的值，让面板显示出来。
       *
       * @param {string} address - 资源地址。
       * @param {{ signal: AbortSignal }} openCtx - 取消信号。
       * @returns {AsyncIterable<object>} 帧流。
       */
      async function* openSession(address, openCtx) {
        const sessionId = parseBtwSessionAddress(address)
        if (sessionId === undefined) {
          yield { ok: true, value: { error: t('panel.badAddress') } }
          return
        }
        const sessions = service(ctx, 'sessions')
        if (sessions === undefined) {
          yield { ok: true, value: { error: t('panel.noSession') } }
          return
        }

        let reference
        try {
          await callHost({ action: 'open', sessionId })
        } catch (error) {
          // 取消归档失败不算致命：会话可能本来就没归档。
          console.warn(`[dsh-btw-sidebar] 取消归档失败: ${String(error?.message ?? error)}`)
        }
        try {
          reference = sessions.retain(sessionId, { source: 'sidebarChat', signal: openCtx.signal })
        } catch (error) {
          // 把真实原因一起显示：只写"无法打开"会让线上排查无从下手。
          console.warn(`[dsh-btw-sidebar] retain 失败: ${String(error?.message ?? error)}`)
          yield { ok: true, value: { error: `${t('panel.retainFailed')}（${String(error?.message ?? error)}）` } }
          return
        }

        try {
          yield { ok: true, value: { sessionId, reference } }
          await waitForAbort(openCtx.signal)
        } finally {
          reference.release()
          try {
            await callHost({ action: 'close', sessionId })
          } catch {
            /* 面板已关；归档失败不该打扰用户 */
          }
        }
      }

      // ── 右栏那一半：等 resources 与 sidebarRightTabs 就绪再注册 ───────────
      //
      // 这里**不能**用 `ctx.get()` 判一次：这两个服务由别的客户端插件 provide，
      // 时机可能晚于本插件的 apply，判一次就会永久跳过注册，表现为"tab 能开、面板全空"。
      ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
        scope.effect(
          () => scope.resources.register({ protocol: PROTOCOL, open: openSession }),
          'btw-sidebar: session resource',
        )
        scope.effect(
          () =>
            scope.sidebarRightTabs.register({
              id: TAB_ID,
              kind: PROTOCOL,
              patterns: [`${SESSION_PREFIX}**`],
              canOpen: (address) => parseBtwSessionAddress(address) !== undefined,
              // 标题用会话自己的标题（宿主已把会话重命名成「侧边聊天 · …」）。
              title: (address) => {
                const sessionId = parseBtwSessionAddress(address)
                const summary = sessionId === undefined ? undefined : service(ctx, 'sessions')?.list.getSnapshot().byId[sessionId]
                return summary?.title ?? t('tab.title')
              },
            }),
          'btw-sidebar: sidebar tab type',
        )
        scope.slots.inject('sidebar.right.pane.tab', () =>
          scope.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              // 声明**我们自己的** session 作用域子槽：框架据此把 `SessionProvider` 注入给
              // body（`PropsRenderSlots` 的规则），body 才能把面板重新绑到子会话上。
              // 用自有名字是因为官方 `sidebar.chat.conversation` 已被 ui-subagent 独占声明，
              // 重复声明会抛 `slot … is already declared` 并打挂整个 web boot。
              children: { [BTW_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
            },
            // `t` 与可见性上报都走闭包带上，避免与这个槽自己声明的 inject face（hooks.tabInfo）冲突。
            (props) => h(BtwChatTab, { ...props, t, onPanelVisibility: reportPanelVisibility }),
          ),
        )
        // 子槽的组件：等上面的 children 把它声明出来之后再注册。
        scope.slots.inject(BTW_CONVERSATION_SLOT, () =>
          scope.slots.register({ name: BTW_CONVERSATION_SLOT }, BtwConversation),
        )
      })

      // ── 关闭兜底：资源中止之外再看一眼 tab 清单 ───────────────────────────
      //
      // 正常路径是资源流被中止 → `finally` 里归档。若某些布局操作没有触发中止
      // （例如 tab 被移除时仍被 pin 住），这条观察保证会话最终被归档回列表之外。
      const inventory = service(ctx, 'sidebarRight')?.openTabs
      if (inventory === undefined || typeof inventory.subscribe !== 'function') {
        console.warn('[dsh-btw-sidebar] ctx.sidebarRight.openTabs 不可用：关闭面板的归档兜底不生效')
      } else {
        const unsubscribe = inventory.subscribe(() => {
          let open
          try {
            open = new Set(inventory.getSnapshot().map((tab) => tab.contentId))
          } catch {
            return
          }
          for (const [address, entry] of tracked) {
            if (open.has(address)) {
              entry.phase = 'open'
              continue
            }
            if (entry.phase !== 'open') continue
            tracked.delete(address)
            callHost({ action: 'close', sessionId: entry.sessionId }).catch(() => {})
          }
        })
        ctx.effect(() => () => unsubscribe(), 'btw-sidebar: sidebar inventory watcher')
        ctx.effect(() => () => tracked.clear(), 'btw-sidebar: watcher state')
      }

      // ── `/btw` 触发源 ─────────────────────────────────────────────────────
      ctx.effect(
        () =>
          ctx.inputTriggers.registerSource({
            trigger: '/',
            name: COMMAND,
            showGroupTitle: false,
            /**
             * `/` 菜单候选。
             *
             * @param {object} _session - 会话投影（本插件不需要）。
             * @param {{ query: string, position: string }} req - 实时查询与位置。
             * @returns {Promise<readonly object[]>} 候选行。
             */
            async candidates(_session, req) {
              if (req.position !== 'leading') return []
              const query = String(req.query ?? '').toLowerCase()
              if (query !== '' && !COMMAND.startsWith(query)) return []
              return [
                {
                  name: COMMAND,
                  label: t('cmd.label'),
                  description: t('cmd.description'),
                  hint: t('cmd.hint'),
                },
              ]
            },
            /**
             * 菜单选中：进入命令模式，把 `/btw ` 留在输入框里等补问题。
             *
             * @param {{ session: object }} pick - 选中项与会话投影。
             * @returns {{ claim: object }} 认领结果。
             */
            onPick(pick) {
              return { claim: claimFor(ctx, t, pick.session, tracked, readyTimeoutMs) }
            },
            /**
             * 回车裁决：整行是 `/btw …` 时认领它。
             *
             * @param {{ sessionId: string }} session - 会话投影。
             * @param {string} line - 整行草稿。
             * @param {AbortSignal} _signal - 提交取消信号。
             * @param {{ attachments: number }} envelope - 提交信封。
             * @returns {Promise<{ claim: object } | undefined>} 认领或放行。
             */
            async matchEnter(session, line, _signal, envelope) {
              const parsed = parseBtwLine(line)
              if (!parsed.mine) return undefined
              if (envelope !== undefined && envelope.attachments > 0) throw new Error(t('error.attachments'))
              return { claim: claimFor(ctx, t, session, tracked, readyTimeoutMs) }
            },
          }),
        'btw-sidebar: /btw slash source',
      )

      return undefined
    }

    /**
     * 构造 `/btw` 的 claim（每次调用都要新建：它闭包捕获当前会话）。
     *
     * @param {object} ctx - 客户端插件上下文。
     * @param {Function} t - 文案函数。
     * @param {{ sessionId: string }} session - 触发时的会话投影。
     * @param {Map<string, object>} tracked - 关闭兜底用的地址表。
     * @param {number} readyTimeoutMs - 等会话就绪的上限。
     * @returns {object} `CommandClaim`。
     */
    function claimFor(ctx, t, session, tracked, readyTimeoutMs) {
      return {
        name: COMMAND,
        token: `/${COMMAND} `,
        hint: t('cmd.hint'),
        /**
         * @param {string} args - 管道切出来的命令参数（即问题）。
         * @param {unknown} _actx - 会话 scope（本插件不用）。
         * @param {readonly unknown[]} attachments - 随行附件。
         * @returns {Promise<{ kind: 'success' | 'error', text?: string }>} 提交结果。
         */
        submit: async (args, _actx, attachments) => {
          let question = typeof args === 'string' ? args.trim() : ''
          // 防御：管道按 `claim.token` 切参数；万一某版本把整行递进来，这里再解析一次。
          if (question.startsWith('/')) {
            const reparsed = parseBtwLine(question)
            if (reparsed.mine) question = reparsed.question
          }
          if (question === '') return { kind: 'error', text: t('error.noQuestion') }
          if (Array.isArray(attachments) && attachments.length > 0) {
            return { kind: 'error', text: t('error.attachments') }
          }

          let body
          try {
            body = await callHost({ action: 'fork', parentSessionId: session.sessionId, question })
          } catch (error) {
            const status = error?.status
            return {
              kind: 'error',
              text:
                status === 404
                  ? t('error.unreachable')
                  : `${t('error.unreachable')}（${String(error?.message ?? error)}）`,
            }
          }
          if (body?.ok !== true) {
            return { kind: 'error', text: String(body?.error?.message ?? t('error.unreachable')) }
          }

          const sidebarRight = service(ctx, 'sidebarRight')
          if (sidebarRight === undefined) return { kind: 'error', text: t('error.sidebar') }
          try {
            // 刻意不给 preferNewPane：那会分裂出新格，把默认页留在旁边（见文件头说明）。
            sidebarRight.openResource(body.address)
          } catch (error) {
            return { kind: 'error', text: `${t('error.sidebar')}（${String(error?.message ?? error)}）` }
          }
          tracked.set(body.address, { sessionId: body.sessionId, phase: 'pending' })

          // 会话已经建好并显示出来了，即使首条消息发失败也不该把命令判成失败——
          // 用户可以在面板里直接补输入，所以这里只把原因如实回显。
          const sent = await sendFirstPrompt(ctx, body.sessionId, question, readyTimeoutMs)
          if (sent.ok !== true) {
            return { kind: 'error', text: t('error.notSent', { reason: sent.reason }) }
          }
          return { kind: 'success' }
        },
      }
    }

    exports.apply = apply
    // 这四项是本插件跑不起来就无事可做的核心：入口、面板位、文案、会话面。
    // resources 与 sidebarRightTabs 走 apply 内的 ctx.inject，因为它们可能晚于 apply 就绪。
    exports.inject = ['sessions', 'slots', 'locale', 'inputTriggers']

    // 必须显式返回：dsh-client-modules 取 factory 的**返回值**当作 exports。
    return module.exports
  },
})
