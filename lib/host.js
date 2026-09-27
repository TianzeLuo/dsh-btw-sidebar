/**
 * host.js — dsh-btw-sidebar 的宿主半部（方案 A：普通 fork 会话 + 按需取消归档）。
 *
 * 职责三条，都挂在 `/api` 前缀下的一个精确 POST 路由上：
 *   1. `fork`  —— 用 `ctx.sessionController.fork()` 在主会话最后一个完成轮次处分叉出一条普通会话，
 *                 并把它重命名成「侧边聊天 · <问题摘要>」。
 *   2. `open`  —— 面板打开时**取消归档**。这一步不是可有可无的：`ArchivedSessionGate`
 *                 在 session controller 里无条件装载（`dsh-api-session-controller/lib/index.js:2821`），
 *                 它对 `agent/pre-step` 直接 reject（同文件 `2384-2392`），所以归档中的会话
 *                 根本跑不动模型步骤。
 *   3. `close` —— 面板关闭时**重新归档**，于是它从默认会话列表里消失；磁盘历史保留。
 *
 * 为什么是普通会话而不是子代理（这是第三版实现，前两版都被实测否掉）：
 *   - 子代理版（`startContinuable({provider:'fork'})`）：面板确实不进左侧列表，但管理器会
 *     给首条任务追加「Your parent agent id is … send your result …」（`dsh-subagent/lib/index.js:1738`）、
 *     在结算时把通知投递进父 agent 的 inbox 从而**唤醒主对话**（同文件 `createSettlementMessage`）、
 *     并往**主会话日志**写 `subagent/catalog`（同文件 `establishCatalogChild`，`:1743` 无条件调用）。
 *     这三条插件都改不了。
 *   - 纯旁问版（自管线程 + 自绘面板 + 一次 `ctx.llm.stream()`）：左侧列表和主对话都干净，
 *     但拿不到官方会话 UI，也**没有工具能力**——被使用者实测否决。
 *   - 普通会话拿到官方 UI + 完整工具 + 零主对话污染，代价只有一条：面板打开期间它出现在
 *     左侧列表里（要能跑就不能归档）。这是刻意的取舍，已与使用者确认。
 *
 * @module dsh-btw-sidebar/host
 */

import { PLUGIN_ID, ROUTE_PATH, TITLE_PREFIX, btwSessionAddress, btwTitle } from './protocol.js'

/** 插件名（也是 loader 行 id 与客户端 bundle id 的建议值）。 */
export const name = PLUGIN_ID

/**
 * 延迟注入：服务晚就绪或被裁剪时 apply 仍会被调用，插件只是少一条通路。
 *
 * 把必需服务写进这个数组会让 apply 永不被调用，插件**完全静默**——排查成本最高的一种失败。
 * 这里全部走 `ctx.get()`，每次用到时取，缺了就给一条可读错误。
 */
export const inject = []

/**
 * 默认配置。
 *
 * @typedef {object} BtwSidebarConfig
 * @property {string} [titlePrefix] 会话标题前缀，默认「侧边聊天」。
 * @property {boolean} [suppressNotifications] 面板开着且你正在看 dsh 时，是否让侧边聊天静音。
 * @property {boolean} [debug] 打印诊断日志。
 */
export const DEFAULTS = Object.freeze({
  titlePrefix: TITLE_PREFIX,
  // 侧边聊天是主会话 fork 出来的**普通会话**，而 away-notify 的浏览器半部上报的
  // 「当前会话」永远是主视图那条（`retainedBy.mainView`），所以它认不出用户其实正
  // 看着侧栏面板里的这条 —— 主线跑完一轮就会误弹提示。修法不是让 away-notify 去猜
  // 标题，而是由本插件通过它提供的 `awayNotify` 服务**显式声明**通知策略：
  //   - 面板开着 **且** 页面可见有焦点（你正看着 dsh）→ 不弹；
  //   - 你切到别的应用/标签页 → 照常弹，点通知回到右栏那个 tab；
  //   - `turn-aborted` 永不弹（只可能来自你点停止 / 关面板）。
  // 接口契约见 dsh-away-notify 的 README「给其他插件的接口」。
  suppressNotifications: true,
  debug: false,
})

/** 把任意值变成 JSON 响应。业务失败也走 200 + `ok:false`，客户端只需一条分支。 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 业务失败。
 *
 * @param {string} code - 稳定错误码。
 * @param {string} message - 给用户看的中文说明。
 * @returns {{ ok: false, error: { code: string, message: string } }} 响应体。
 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 插件入口。
 *
 * @param {import('cordis').Context} ctx 宿主插件上下文。
 * @param {BtwSidebarConfig} [config] profile 里覆盖的配置。
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const log = (...args) => {
    if (options.debug) console.log(`[${PLUGIN_ID}]`, ...args)
  }

  /**
   * 本插件建出来的侧边聊天会话 id 集合。
   *
   * 只增不减：它有两个用途——① `turn-aborted` 豁免（见 registerAwayNotifyIntegration），
   * ② 点击通知时的「揭示目标」。dsh 重启后集合是空的（内存态），旧的侧边聊天若被从
   * 「已归档」手动恢复，会失去这两项待遇；再用右栏面板打开它一次（`open`）就补登记。
   * 这条缺口没有官方原语可堵：会话 header 没有可扩展字段，`fork()` 也不收任何标记位。
   */
  const sideChatSessions = new Set()

  /**
   * 当前**开着面板**的侧边聊天：`open` 加入、`close` 移除。
   *
   * 它只在上报可见性的客户端缺席时兜底（见 `sawVisibilityReport`）；正常路径用的是
   * 下面那个「真的显示在右栏」的集合。
   */
  const openSideChats = new Set()

  /**
   * 当前**真的显示在右栏**的侧边聊天：浏览器半部按官方 `useTabInfo().tab.visible`
   * （前景会话 && (浮动面板 || 右栏展开且是本格的活动 tab)）在变化时上报。
   *
   * 有了它，「面板开着但你看的是右栏别的 tab」不再被误当成「你正看着这条会话」，
   * 那种情况会照常提醒——这正是通知有用的时候。
   */
  const visibleSideChats = new Set()

  /**
   * 是否收到过任何一次可见性上报。
   *
   * 页面上跑的还是**旧 bundle**（宿主重启了但没刷新页面）时永远收不到，此时退回旧的
   * 「面板开着且你在看 dsh 就静音」，避免退化成最初那个误弹。
   */
  let sawVisibilityReport = false

  /** `awayNotify` 服务句柄；由下面的 inject 回调赋值（服务可能晚于本插件就绪）。 */
  let awayNotify

  /**
   * 把一条侧边聊天登记进通知策略，并声明它的「点击揭示」目标。
   *
   * 揭示目标 = 描述这条会话的那个右栏资源地址。away-notify 只负责转发这个不透明
   * 地址；点击通知时浏览器半部会先试 `sidebarRight.openResource(地址)`——目标 tab
   * 已经开着就聚焦它，没开就新开并展开右栏——失败才退回主视图。
   */
  function bindSideChat(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    sideChatSessions.add(sessionId)
    if (awayNotify === undefined || typeof awayNotify.revealSession !== 'function') return
    try {
      awayNotify.revealSession(sessionId, { resource: btwSessionAddress(sessionId), reason: PLUGIN_ID })
    } catch (error) {
      log('声明点击揭示目标失败（点通知将退回主视图）:', String(error?.message ?? error))
    }
  }

  /**
   * 向 `dsh-away-notify` 声明通知策略。
   *
   * - **抑制**：侧边聊天是主会话 fork 出来的普通会话，而 away-notify 的浏览器半部上报的
   *   「当前会话」永远是主视图那条（`retainedBy.mainView`），所以它认不出用户其实正看着
   *   侧栏面板里的这条。这里用规则把「正被你看着的侧栏会话」压掉；不看页面时照常提醒。
   * - **揭示**：点通知回到右栏那个 tab，而不是在主视图里新开一条会话。
   *
   * 用 `ctx.inject` 而不是 `ctx.get`：away-notify 可能晚于本插件 apply，还没 provide 出
   * 服务；inject 会在服务就绪时再回调，且服务始终缺失也不会阻塞本插件（那时什么都不做，
   * `/btw` 与现在完全一致）。接口缺失 / 抛错都只降级，绝不影响 `/btw` 本身。
   */
  function registerAwayNotifyIntegration() {
    try {
      ctx.inject(['awayNotify'], (c) => {
        const away = c?.awayNotify ?? c?.get?.('awayNotify')
        if (away === undefined) {
          log('awayNotify 服务不可用，跳过通知策略声明')
          return
        }
        awayNotify = away

        if (options.suppressNotifications === false) {
          log('已按配置关闭通知抑制：侧边聊天会照常弹提示（点击仍会回到右栏 tab）')
        } else if (typeof away.addRule !== 'function') {
          log('awayNotify 服务缺 addRule，跳过抑制声明')
        } else {
          away.addRule({
            id: PLUGIN_ID,
            reason: PLUGIN_ID,
            // 只匹配本插件建出来的会话，不做任何标题/关键词匹配。
            // - aborted 永远压掉：它只可能来自你自己（点停止、或关掉面板时的 stopActivity），
            //   那一下提醒是纯噪声；
            // - 其余类型只在「这条侧边聊天的面板**真的显示在右栏** + 你正看着 dsh」时压掉。
            //   面板在后台（切到了别的 tab / 右栏折叠 / 主视图换了会话）时照常提醒。
            match: (sessionId, event, context) => {
              if (!sideChatSessions.has(sessionId)) return false
              if (event?.kind === 'turn-aborted') return true
              const displayed =
                visibleSideChats.has(sessionId) || (!sawVisibilityReport && openSideChats.has(sessionId))
              return displayed && context?.pageAttended === true
            },
          })
          log('已向 dsh-away-notify 声明抑制规则：面板显示在右栏且你在看时不打扰')
        }

        // away-notify 晚于本插件就绪时，补登记之前已经建好的会话的揭示目标
        for (const sessionId of sideChatSessions) bindSideChat(sessionId)
      })
    } catch (error) {
      log('声明 away-notify 通知策略失败（不影响侧边聊天本身）:', String(error?.message ?? error))
    }
  }

  registerAwayNotifyIntegration()

  /**
   * 分叉出一条侧边聊天会话并命名。
   *
   * @param {{ parentSessionId?: string, question?: string }} payload - 请求体。
   * @returns {Promise<object>} 成功时带 sessionId / address / title。
   */
  async function forkSideChat(payload) {
    const parentSessionId = typeof payload?.parentSessionId === 'string' ? payload.parentSessionId : ''
    const question = typeof payload?.question === 'string' ? payload.question.trim() : ''
    if (parentSessionId === '') return fail('BAD_REQUEST', '/btw 请求缺少 parentSessionId')
    if (question === '') return fail('EMPTY_QUESTION', '用法：/btw <问题>')

    const controller = ctx.get('sessionController')
    if (controller === undefined) return fail('NO_SESSION_CONTROLLER', '会话服务不可用，无法建立侧边聊天。')

    let child
    try {
      // 省略 atSeq = 继承到主会话最后一个完成轮次（open 的 tail 会被补上合成 closer）。
      child = await controller.fork({ sessionId: parentSessionId })
    } catch (error) {
      const message = String(error?.message ?? error)
      log('fork 失败:', message)
      return fail('FORK_FAILED', `无法建立侧边聊天：${message}`)
    }

    // 登记进通知策略：赶在面板发首条消息之前（同一 tick 内完成）。揭示目标现在就绑上，
    // 抑制要等 `open` 把面板标记为开着（首条消息一定晚于 `open`，不会漏抑制）。
    bindSideChat(child.sessionId)

    const title = btwTitle(question, options.titlePrefix)
    try {
      // 重命名会钉住标题，避免自动标题把「侧边聊天 · …」覆盖掉。
      await controller.rename({ sessionId: child.sessionId, title })
    } catch (error) {
      // 命名失败不影响功能：会话照样能聊，只是标题不好认。
      log('rename 失败:', String(error?.message ?? error))
    }

    const address = btwSessionAddress(child.sessionId)
    log('侧边聊天已建立:', child.sessionId, '->', parentSessionId)
    return { ok: true, sessionId: child.sessionId, address, title }
  }

  /**
   * 面板打开：取消归档，让这条会话能跑模型步骤。
   *
   * @param {{ sessionId?: string }} payload - 请求体。
   * @returns {Promise<object>} `ok:true`。
   */
  async function openSideChat(payload) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return fail('BAD_REQUEST', 'open 请求缺少 sessionId')
    // 面板开着 = 这条会话进入「被看着就不打扰」的集合。dsh 重启后集合是空的（内存态），
    // 重新打开面板顺带补登记揭示目标与 aborted 豁免，见 bindSideChat。
    bindSideChat(sessionId)
    openSideChats.add(sessionId)
    const workspaces = ctx.get('workspaceController')
    if (workspaces === undefined) return fail('NO_WORKSPACE_CONTROLLER', '工作区服务不可用。')
    try {
      await workspaces.unarchiveSession({ sessionId })
    } catch (error) {
      // 本来就没归档时会失败（或本来就是幂等），不影响使用。
      log('unarchive 失败（可忽略）:', String(error?.message ?? error))
    }
    return { ok: true }
  }

  /**
   * 面板可见性上报：由浏览器半部按官方 `tab.visible` 在变化时调用。
   *
   * @param {{ sessionId?: string, visible?: boolean }} payload - 请求体。
   * @returns {object} `ok:true`。
   */
  function setPanelVisible(payload) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return fail('BAD_REQUEST', 'visible 请求缺少 sessionId')
    sawVisibilityReport = true
    if (payload?.visible === true) visibleSideChats.add(sessionId)
    else visibleSideChats.delete(sessionId)
    log('面板可见性:', sessionId, payload?.visible === true ? '显示中' : '不在前台')
    return { ok: true }
  }

  /**
   * 面板关闭：停止仍在跑的工作并重新归档。
   *
   * `stopActivity` 是必需的：否则归档进行中的会话会被拒绝为 `workspace/session-active`。
   *
   * @param {{ sessionId?: string }} payload - 请求体。
   * @returns {Promise<object>} `ok:true`。
   */
  async function closeSideChat(payload) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return fail('BAD_REQUEST', 'close 请求缺少 sessionId')
    // 面板关掉 → 不再属于「被看着就不打扰」；会话本身仍留在策略里（aborted 豁免与
    // 点击揭示目标都还要用，且 dsh 没有可写的会话标记位，重启后无从恢复）。
    openSideChats.delete(sessionId)
    visibleSideChats.delete(sessionId)
    const workspaces = ctx.get('workspaceController')
    if (workspaces === undefined) return fail('NO_WORKSPACE_CONTROLLER', '工作区服务不可用。')
    try {
      await workspaces.archiveSession({ sessionId, stopActivity: true })
    } catch (error) {
      const message = String(error?.message ?? error)
      log('archive 失败:', message)
      return fail('ARCHIVE_FAILED', `关闭侧边聊天时归档失败：${message}`)
    }
    return { ok: true }
  }

  /**
   * 路由处理器。
   *
   * @param {Request} request - 已通过物理载体信任与鉴权策略的请求。
   * @returns {Promise<Response>} JSON 响应。
   */
  async function handle(request) {
    let payload
    try {
      payload = await request.json()
    } catch {
      return jsonResponse(fail('BAD_REQUEST', '请求体不是合法 JSON'), 400)
    }
    switch (payload?.action) {
      case 'fork':
        return jsonResponse(await forkSideChat(payload))
      case 'open':
        return jsonResponse(await openSideChat(payload))
      case 'close':
        return jsonResponse(await closeSideChat(payload))
      case 'visible':
        return jsonResponse(setPanelVisible(payload))
      default:
        return jsonResponse(fail('BAD_REQUEST', `未知 action：${String(payload?.action)}`), 400)
    }
  }

  ctx.inject(['connection'], (c) => {
    try {
      c.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['POST'],
        // 请求体只有短字符串，buffered 足够；它同时受共享通道的 JSON 上限保护。
        requestBody: 'buffered',
        fetch: handle,
      })
      log('路由已注册:', ROUTE_PATH)
    } catch (error) {
      // 注册失败不能把整个插件拖垮：其余逻辑（以及 DSH 本身）继续跑。
      console.warn(`[${PLUGIN_ID}] 路由注册失败: ${String(error?.message ?? error)}`)
    }
  })
}
