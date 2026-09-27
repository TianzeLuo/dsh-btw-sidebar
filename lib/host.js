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
 * @property {boolean} [debug] 打印诊断日志。
 */
export const DEFAULTS = Object.freeze({
  titlePrefix: TITLE_PREFIX,
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
