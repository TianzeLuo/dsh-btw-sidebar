/**
 * 接线测试：不跑浏览器，但把宿主半部的 fork/open/close 路由、浏览器半部的资源 provider、
 * tab 类型与 body 声明、`/btw` 认领与提交（含发首条消息）都真跑一遍。
 *
 * 这类错误（路由路径两侧不一致、claim 的 args 取错、资源地址拼错、忘记带 children 导致
 * 面板渲染不出官方会话、多传了 preferNewPane 导致右栏裂成两格）离线静态检查发现不了，
 * 在真机上的表现是「命令敲下去没反应」或「右栏空白且无报错」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE_PATH, btwSessionAddress, btwTitle } from '../lib/protocol.js'
import { apply as hostApply, inject as hostInject, name as hostName } from '../lib/host.js'

// ─────────────────────────────────────────────────────────────────────────────
// 宿主半部
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 造一个只实现本插件用到的表面面的宿主上下文。
 *
 * @param {object} [options] - 覆盖点（fork / rename / unarchive / archive 的行为）。
 * @returns {object} 上下文与捕获记录。
 */
function fakeHost(options = {}) {
  const routes = []
  const calls = { fork: [], rename: [], unarchive: [], archive: [], awayRules: [], reveals: [] }
  /** dsh-away-notify 的 awayNotify 服务替身：记录规则与揭示目标，并能按规则查询是否被抑制。 */
  const awayRules = new Map()
  const reveals = new Map()
  const awayNotify = {
    version: 1,
    addRule(rule) {
      calls.awayRules.push(rule)
      awayRules.set(rule.id, rule)
      return () => awayRules.delete(rule.id)
    },
    revealSession(sessionId, target) {
      calls.reveals.push({ sessionId, ...target })
      reveals.set(sessionId, { sessionId, ...target })
      return () => reveals.delete(sessionId)
    },
    revealFor(sessionId) {
      return reveals.get(sessionId)
    },
    isSuppressed(sessionId, event, context) {
      for (const rule of awayRules.values()) {
        if (rule.match(sessionId, event, context) === true) return rule.reason
      }
      return undefined
    },
  }
  const ctx = {
    inject(deps, callback) {
      for (const dep of deps) {
        if (dep === 'connection') {
          callback({
            connection: {
              fetch: {
                register(route) {
                  routes.push(route)
                  return async () => {}
                },
              },
            },
          })
        } else if (dep === 'awayNotify') {
          if (options.withoutAwayNotify !== true) callback({ awayNotify })
        } else {
          throw new Error(`宿主半部注入了未预期的依赖：${dep}`)
        }
      }
    },
    get(name) {
      if (name === 'awayNotify') return options.withoutAwayNotify === true ? undefined : awayNotify
      if (name === 'sessionController') {
        return {
          async fork(request) {
            calls.fork.push(request)
            if (options.forkThrows === true) throw new Error('session/fork-unavailable: no completed turn')
            return options.forkResult ?? { sessionId: 's-child' }
          },
          async rename(request) {
            calls.rename.push(request)
            if (options.renameThrows === true) throw new Error('rename failed')
            return { title: request.title, seq: 1 }
          },
        }
      }
      if (name === 'workspaceController') {
        return {
          async unarchiveSession(request) {
            calls.unarchive.push(request)
            if (options.unarchiveThrows === true) throw new Error('not archived')
          },
          async archiveSession(request) {
            calls.archive.push(request)
            if (options.archiveThrows === true) throw new Error('workspace/session-active')
          },
        }
      }
      if (name === 'sessions') {
        // 只用来验证「归属主会话」的 fork 血缘回退（parentOf 未给时视为拿不到会话）。
        const parentOf = options.parentOf ?? {}
        return {
          get(sessionId) {
            const parent = parentOf[sessionId]
            if (typeof parent !== 'string') return undefined
            return { header: { id: sessionId, parentSession: parent } }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, routes, calls, awayNotify, reveals }
}

/**
 * 向注册好的路由发一条 POST。
 *
 * @param {object} route - 注册的 Fetch 路由。
 * @param {unknown} body - 请求体。
 * @param {boolean} [raw] - 为真时按原文发送（非法 JSON 用例）。
 * @returns {Promise<Response>} 路由响应。
 */
function post(route, body, raw = false) {
  return route.fetch(
    new Request(`http://localhost${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    }),
  )
}

/** 发一条 POST 并读回 JSON。 */
async function call(route, body) {
  return await (await post(route, body)).json()
}

test('宿主半部：注册一个 POST /api 精确路由，且不把 connection 写进 inject', () => {
  const { ctx, routes } = fakeHost()
  hostApply(ctx, {})
  assert.equal(hostName, 'dsh-btw-sidebar')
  assert.deepEqual(hostInject, [])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, ROUTE_PATH)
  assert.deepEqual(routes[0].methods, ['POST'])
  assert.equal(routes[0].requestBody, 'buffered')
})

test('宿主半部：fork 建会话、重命名，并返回可用的右栏地址', async () => {
  const { ctx, routes, calls } = fakeHost()
  hostApply(ctx, {})
  const body = await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: '为什么这样写？' })

  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's-child')
  assert.equal(body.address, btwSessionAddress('s-child'))
  assert.equal(body.title, btwTitle('为什么这样写？'))
  // 省略 atSeq = fork 到主会话最后一个完成轮次。
  assert.deepEqual(calls.fork, [{ sessionId: 's-parent' }])
  assert.deepEqual(calls.rename, [{ sessionId: 's-child', title: '侧边聊天 · 为什么这样写？' }])
})

test('宿主半部：rename 失败不影响可用性（只是标题不好认）', async () => {
  const { ctx, routes } = fakeHost({ renameThrows: true })
  hostApply(ctx, {})
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const body = await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 's-child')
  } finally {
    console.warn = originalWarn
  }
})

test('宿主半部：fork 失败（例如主会话没有完成的轮次）给可读错误', async () => {
  const { ctx, routes } = fakeHost({ forkThrows: true })
  hostApply(ctx, {})
  const body = await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'FORK_FAILED')
  assert.match(body.error.message, /fork-unavailable/)
})

test('宿主半部：参数校验与未知 action', async () => {
  const { ctx, routes } = fakeHost()
  hostApply(ctx, {})
  assert.equal((await call(routes[0], { action: 'fork', parentSessionId: 's', question: '   ' })).error.code, 'EMPTY_QUESTION')
  assert.equal((await call(routes[0], { action: 'fork', question: 'x' })).error.code, 'BAD_REQUEST')
  assert.equal((await call(routes[0], { action: 'open' })).error.code, 'BAD_REQUEST')
  assert.equal((await call(routes[0], { action: 'close' })).error.code, 'BAD_REQUEST')
  assert.equal((await post(routes[0], { action: 'nope' })).status, 400)
  assert.equal((await post(routes[0], '{not json', true)).status, 400)
})

test('宿主半部：open 取消归档；归档中/未归档时报错也不影响使用', async () => {
  const { ctx, routes, calls } = fakeHost({ unarchiveThrows: true })
  hostApply(ctx, {})
  assert.equal((await call(routes[0], { action: 'open', sessionId: 's-child' })).ok, true)
  assert.deepEqual(calls.unarchive, [{ sessionId: 's-child' }])
})

test('宿主半部：close 带 stopActivity 归档（否则进行中的会话会被拒绝）', async () => {
  const { ctx, routes, calls } = fakeHost()
  hostApply(ctx, {})
  assert.equal((await call(routes[0], { action: 'close', sessionId: 's-child' })).ok, true)
  assert.deepEqual(calls.archive, [{ sessionId: 's-child', stopActivity: true }])
})

test('宿主半部：归档失败如实上报', async () => {
  const { ctx, routes } = fakeHost({ archiveThrows: true })
  hostApply(ctx, {})
  const body = await call(routes[0], { action: 'close', sessionId: 's-child' })
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'ARCHIVE_FAILED')
})

// ── 与 dsh-away-notify 的接线：被看着时不打扰 + 点通知回右栏 tab ─────────────
//
// 背景：侧边聊天是普通 fork 会话，而 away-notify 的浏览器半部只上报**主视图**的
// 会话（`retainedBy.mainView`），所以它认不出用户其实正看着侧栏面板里的这条，跑完
// 一轮就会误弹提示。修法不是让 away-notify 去猜标题，而是本插件通过它提供的
// `awayNotify` 服务显式声明通知策略（契约见 dsh-away-notify README 的「给其他插件
// 的接口」）。这几条用例锁住：
//   - **apply 时注册规则 / fork、open 时登记会话与揭示目标**；
//   - **语义 = 面板开着且页面被看着才静音**，切走照常提醒，关面板即失效；
//   - **aborted 永久豁免**（只可能来自你点停止 / 关面板）；
//   - **只按会话 id 匹配**（不做任何标题/关键词匹配）；
//   - **接口缺失或关闭开关时不影响 /btw**。

test('宿主半部：apply 时向 awayNotify 注册一条规则（id/reason 都是本插件）', () => {
  const { ctx, calls } = fakeHost()
  hostApply(ctx, {})
  assert.equal(calls.awayRules.length, 1)
  assert.equal(calls.awayRules[0].id, 'dsh-btw-sidebar')
  assert.equal(calls.awayRules[0].reason, 'dsh-btw-sidebar')
  assert.equal(typeof calls.awayRules[0].match, 'function')
})

test('宿主半部：fork 后立刻登记会话与「点击揭示」目标（早于面板发首条消息）', async () => {
  const { ctx, routes, reveals } = fakeHost()
  hostApply(ctx, {})
  assert.equal(reveals.size, 0, 'fork 前不该登记任何会话')

  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  assert.deepEqual(reveals.get('s-child'), {
    sessionId: 's-child',
    resource: btwSessionAddress('s-child'),
    // 归属主会话 = fork 的父会话：右栏 tab 是按主视图会话分域的，点击回跳必须先切回它。
    mainSessionId: 's-parent',
    reason: 'dsh-btw-sidebar',
  })
})

test('宿主半部：重启后内存态丢失时，用会话 header 的 fork 血缘反推归属主会话', async () => {
  const { ctx, routes, reveals } = fakeHost({ parentOf: { 's-restored': 's-origin' } })
  hostApply(ctx, {})
  await call(routes[0], { action: 'open', sessionId: 's-restored' })
  assert.equal(
    reveals.get('s-restored')?.mainSessionId,
    's-origin',
    '没有内存记录时要能从 header.parentSession 推出归属，否则点通知又会开进当前会话的右栏',
  )
})

test('宿主半部：面板显示在右栏且你正看着 dsh 时不打扰，右栏切到别的 tab 就恢复提醒', async () => {
  const { ctx, routes, awayNotify } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })

  // 面板还没显示：不算「被看着」，照常提醒
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    undefined,
    '面板没显示时不该抑制',
  )

  // 面板显示在右栏 + 你正看着 dsh → 不打扰
  await call(routes[0], { action: 'open', sessionId: 's-child' })
  await call(routes[0], { action: 'visible', sessionId: 's-child', visible: true })
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    'dsh-btw-sidebar',
  )
  // 你切到别的应用/标签页 → 照常提醒
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: false }),
    undefined,
    '你切走时应照常提醒（点通知会回右栏 tab）',
  )

  // 右栏切到别的 tab（面板还在，但不在前台）→ 照常提醒
  await call(routes[0], { action: 'visible', sessionId: 's-child', visible: false })
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    undefined,
    '面板在后台时不该静音：这时才需要通知你',
  )

  // 再切回来 → 又不打扰
  await call(routes[0], { action: 'visible', sessionId: 's-child', visible: true })
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    'dsh-btw-sidebar',
  )

  // 关掉面板 → 彻底不再抑制
  await call(routes[0], { action: 'close', sessionId: 's-child' })
  assert.equal(awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }), undefined)
})

test('宿主半部：可见性上报之后，仅「开着面板」不再静音', async () => {
  const { ctx, routes, awayNotify } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  await call(routes[0], { action: 'open', sessionId: 's-child' })
  await call(routes[0], { action: 'visible', sessionId: 's-child', visible: false })
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    undefined,
    '已经能拿到可见性时就以它为准，不再用「开着」兜底',
  )
})

test('宿主半部：页面上还是旧 bundle（从没上报可见性）时退回「开着就静音」', async () => {
  const { ctx, routes, awayNotify } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  await call(routes[0], { action: 'open', sessionId: 's-child' })
  assert.equal(
    awayNotify.isSuppressed('s-child', { kind: 'turn-complete' }, { pageAttended: true }),
    'dsh-btw-sidebar',
    '宁可退回上一版语义，也不要退化成最初的误弹',
  )
})

test('宿主半部：visible 缺 sessionId 时给可读错误', async () => {
  const { ctx, routes } = fakeHost()
  hostApply(ctx, {})
  const body = await call(routes[0], { action: 'visible', visible: true })
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'BAD_REQUEST')
})

test('宿主半部：关闭面板引发的 aborted 永不提醒（两种在场状态都压掉）', async () => {
  const { ctx, routes, awayNotify } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  await call(routes[0], { action: 'open', sessionId: 's-child' })
  await call(routes[0], { action: 'close', sessionId: 's-child' })

  // 关面板走 archiveSession({stopActivity:true}) → 会产出 aborted 轮次；那一下是纯噪声
  assert.equal(awayNotify.isSuppressed('s-child', { kind: 'turn-aborted' }, { pageAttended: true }), 'dsh-btw-sidebar')
  assert.equal(awayNotify.isSuppressed('s-child', { kind: 'turn-aborted' }, { pageAttended: false }), 'dsh-btw-sidebar')
  // 别的会话不受影响
  assert.equal(awayNotify.isSuppressed('s-other', { kind: 'turn-aborted' }, { pageAttended: false }), undefined)
})

test('宿主半部：抑制只认会话 id，不做任何标题/关键词匹配', async () => {
  const { ctx, routes, awayNotify } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  await call(routes[0], { action: 'open', sessionId: 's-child' })
  await call(routes[0], { action: 'visible', sessionId: 's-child', visible: true })

  // 一条标题同样是「侧边聊天 · …」、但不是本插件 fork 出来的会话：不得被误伤
  assert.equal(
    awayNotify.isSuppressed('s-manual', { kind: 'turn-complete', sessionTitle: '侧边聊天 · 手抄的标题' }, { pageAttended: true }),
    undefined,
  )
})

test('宿主半部：面板重新打开时补登记（重启后恢复的侧边聊天也受同样待遇）', async () => {
  const { ctx, routes, awayNotify, reveals } = fakeHost()
  hostApply(ctx, {})
  assert.equal(reveals.size, 0)
  await call(routes[0], { action: 'open', sessionId: 's-restored' })
  await call(routes[0], { action: 'visible', sessionId: 's-restored', visible: true })
  assert.equal(
    awayNotify.isSuppressed('s-restored', { kind: 'turn-complete' }, { pageAttended: true }),
    'dsh-btw-sidebar',
  )
  assert.equal(reveals.get('s-restored')?.resource, btwSessionAddress('s-restored'), '揭示目标也要补登记')
})

test('宿主半部：close 不摘掉揭示目标（点通知仍回右栏那个 tab）', async () => {
  const { ctx, routes, reveals } = fakeHost()
  hostApply(ctx, {})
  await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })
  await call(routes[0], { action: 'close', sessionId: 's-child' })
  assert.equal(reveals.get('s-child')?.resource, btwSessionAddress('s-child'))
})

test('宿主半部：awayNotify 服务缺失时不注册、也不影响 fork', async () => {
  const { ctx, routes, calls } = fakeHost({ withoutAwayNotify: true })
  assert.doesNotThrow(() => hostApply(ctx, {}))
  assert.equal(calls.awayRules.length, 0)
  assert.equal(calls.reveals.length, 0)
  assert.equal((await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })).ok, true)
})

test('宿主半部：suppressNotifications=false 时不声明抑制规则，但揭示目标照常登记', async () => {
  const { ctx, routes, calls, reveals } = fakeHost()
  hostApply(ctx, { suppressNotifications: false })
  assert.equal(calls.awayRules.length, 0)
  assert.equal((await call(routes[0], { action: 'fork', parentSessionId: 's-parent', question: 'x' })).ok, true)
  assert.equal(reveals.get('s-child')?.resource, btwSessionAddress('s-child'), '点击仍应回到右栏 tab')
})

test('宿主半部：注册路由抛错时不把 apply 拖垮', () => {
  const ctx = {
    get: () => undefined,
    inject(_deps, callback) {
      callback({
        connection: {
          fetch: {
            register() {
              throw new Error('route conflict')
            },
          },
        },
      })
    },
  }
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => hostApply(ctx, {}))
  } finally {
    console.warn = originalWarn
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 浏览器半部
// ─────────────────────────────────────────────────────────────────────────────

/** `client.js` 在模块顶层就调用 `window.__ModuleLoader__.load(...)`，垫片必须先装好。 */
const captured = { definition: undefined }
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.definition = definition
    },
  },
}
await import('../lib/client.js')

/** React 垫片：把 children 折进 props（与 React 一致），供面板测试读取。 */
const reactShim = {
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }),
  /** `useEffect` 只收集不执行：测试显式运行，免得「渲染一下就发请求」污染别的用例。 */
  useEffect: (fn) => {
    reactEffects.push(fn)
  },
}

/** 收集到的 effect；面板可见性用例会显式跑掉它们。 */
const reactEffects = []

/** 跑掉已收集的 effect，返回它们的清理函数（供模拟卸载）。 */
function runEffects() {
  const cleanups = []
  while (reactEffects.length > 0) {
    const cleanup = reactEffects.shift()()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}
const clientExports = captured.definition.factory((specifier) => {
  if (specifier === 'react') return reactShim
  throw new Error(`unexpected require: ${specifier}`)
})

/**
 * 造一个客户端插件上下文。
 *
 * 刻意**只**通过 `ctx.inject([...])` 暴露 resources / sidebarRightTabs——
 * 与真机一致；如果实现退回 `ctx.get('resources')`，providers 就会是空的，测试立刻红。
 *
 * @param {object} [options] - `withoutSidebar` / `promptResult` / `withoutBinding` 等覆盖点。
 * @returns {object} 上下文与捕获记录。
 */
function fakeClient(options = {}) {
  const sources = []
  const opened = []
  const listeners = []
  const disposers = []
  const providers = []
  const tabTypes = []
  const slotBodies = []
  const prompts = []
  const releases = []
  const hostCalls = []
  let snapshot = []

  const sessionFace = {
    beginSubmission: (input) => {
      assert.equal(input.mode, 'queue')
      assert.ok(Array.isArray(input.attachments), 'beginSubmission 需要 attachments 数组')
      return { requestId: 'req-1', abandon: () => {} }
    },
    prompt: async (content, mode, _signal, requestId) => {
      prompts.push({ content, mode, requestId })
      return options.promptResult ?? { ok: true, value: { accepted: true } }
    },
  }

  const sessions = {
    retain(sessionId, retainOptions) {
      assert.equal(typeof retainOptions?.source, 'string')
      if (options.retainThrows === true) throw new Error('session not found')
      return {
        sessionId,
        release() {
          releases.push(sessionId)
        },
      }
    },
    binding(sessionId) {
      if (options.withoutBinding === true) return undefined
      return { session: sessionFace, sessionId }
    },
    list: { getSnapshot: () => ({ byId: { 's-child': { title: '侧边聊天 · 问题' } } }) },
  }

  const sidebarRight = {
    openResource(address, opts) {
      opened.push({ address, opts })
    },
    openTabs: {
      subscribe(listener) {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
      getSnapshot() {
        return snapshot
      },
    },
  }

  const ctx = {
    sessions,
    // 真机的可选查找：与属性访问不同，它不要求服务写进 inject，也不抛。
    // 插件内部一律走 `ctx.get(name)`（见 lib/client.js 的 service()）。
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'sidebarRight') return options.withoutSidebar === true ? undefined : sidebarRight
      if (name === 'sidebarRightTabs') return { register() {} }
      if (name === 'resources') return { register() {} }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      const cleanup = typeof disposer === 'function' ? disposer : () => {}
      disposers.push(cleanup)
      return cleanup
    },
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    },
    inputTriggers: {
      registerSource(source) {
        sources.push(source)
        return () => {}
      },
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => {}
      },
      register(definition, component) {
        slotBodies.push({ definition, component })
        return () => {}
      },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['resources', 'sidebarRightTabs'], '必须用 ctx.inject 等这两个服务就绪')
      callback({
        resources: {
          register(provider) {
            providers.push(provider)
            return () => {}
          },
        },
        sidebarRightTabs: {
          register(definition) {
            tabTypes.push(definition)
            return () => {}
          },
        },
        slots: ctx.slots,
        effect: ctx.effect,
      })
      return () => {}
    },
  }
  if (options.withoutSidebar !== true) ctx.sidebarRight = sidebarRight

  return {
    ctx,
    sources,
    opened,
    providers,
    tabTypes,
    slotBodies,
    prompts,
    releases,
    hostCalls,
    fire() {
      for (const listener of [...listeners]) listener()
    },
    setSnapshot(value) {
      snapshot = value
    },
    disposeAll() {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

/** 装一个记录调用的 fetch；fork 返回 s-child。 */
function installFetch(client, forkResult) {
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    client.hostCalls.push(payload)
    if (payload.action === 'fork') {
      return {
        ok: true,
        status: 200,
        json: async () =>
          forkResult ?? {
            ok: true,
            sessionId: 's-child',
            address: btwSessionAddress('s-child'),
            title: '侧边聊天 · 问题',
          },
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
}

test('浏览器半部：bundle 契约与注入项', () => {
  assert.equal(captured.definition.id, 'dsh-btw-sidebar')
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual(clientExports.inject, ['sessions', 'slots', 'locale', 'inputTriggers'])
})

test('浏览器半部：注册 btw 资源协议、tab 类型，并声明渲染官方会话子槽', () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)

  assert.equal(client.providers.length, 1)
  assert.equal(client.providers[0].protocol, 'btw')

  assert.equal(client.tabTypes.length, 1)
  const tab = client.tabTypes[0]
  assert.equal(tab.kind, 'btw')
  assert.deepEqual(tab.patterns, ['dsh-resource://btw/session/**'])
  assert.equal(tab.canOpen(btwSessionAddress('s-child')), true)
  assert.equal(tab.canOpen('dsh-resource://subagentchat/session/x?parent=p&mode=continuable'), false)
  assert.equal(tab.title(btwSessionAddress('s-child')), '侧边聊天 · 问题')

  assert.equal(client.slotBodies.length, 2)
  assert.equal(client.slotBodies[0].definition.key, 'dsh-btw-sidebar')
  // 必须声明一个**自己的** session 作用域子槽：框架据此把 SessionProvider 注入 body，
  // body 才能把面板重新绑到 fork 出来的子会话上（否则渲染的是父会话）。
  assert.deepEqual(client.slotBodies[0].definition.children, {
    'btw.conversation': { kind: 'single', scope: 'session' },
  })
  // 而且**绝不能**去声明官方那个子槽：它已被 ui-subagent 独占声明，重复声明会抛
  // `slot "…" is already declared`，把整个 web boot 打挂（上一轮实测过）。
  assert.equal(
    client.slotBodies[0].definition.children['sidebar.chat.conversation'],
    undefined,
    '不得声明官方 sidebar.chat.conversation 子槽',
  )
  // 子槽的组件也要注册上，否则面板里那一格是空的。
  assert.equal(client.slotBodies[1].definition.name, 'btw.conversation')
  assert.equal(typeof client.slotBodies[1].component, 'function')
  client.disposeAll()
})

test('浏览器半部：面板在任何异常下都渲染可见文案，绝不 return null', () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const registered = client.slotBodies[0].component
  const address = btwSessionAddress('s-child')
  /** 调用注册的包装组件，再展开内层函数组件（垫片没有真实 React 调度）。 */
  const render = (hooks) => {
    const element = registered({ useTabInfo: () => ({ tab: { contentId: address } }), t: (key) => key, ...hooks })
    return element.type(element.props)
  }
  const textOf = (node) => {
    if (typeof node === 'string') return node
    const children = node?.props?.children
    if (typeof children === 'string') return children
    if (Array.isArray(children)) return children.map(textOf).join('')
    return String(children ?? '')
  }

  // 资源没有 provider（就是之前"tab 能开、面板全空"的形态）：必须看得见原因。
  assert.match(textOf(render({ useResource: () => ({ status: 'none' }) })), /panel\.noProvider/)
  assert.match(
    textOf(render({ useResource: () => ({ status: 'failed', failure: { message: 'boom' } }) })),
    /boom/,
  )
  // 资源给了错误值。
  assert.match(
    textOf(render({ useResource: () => ({ status: 'live', value: { error: '会话打不开' } }) })),
    /会话打不开/,
  )
  // 资源正常但没有会话作用域绑定（SessionProvider 缺席）：必须说清楚，而不是渲染父会话。
  const live = { status: 'live', value: { reference: { id: 'r' } } }
  assert.match(textOf(render({ useResource: () => live })), /panel\.noSessionProvider/)
  // 有绑定但没有子槽渲染能力。
  assert.match(
    textOf(render({ useResource: () => live, SessionProvider: () => null })),
    /panel\.noSlot/,
  )
  // 一切就绪：必须把子会话 reference 交给官方 SessionProvider，并在里面渲染我们自己的子槽。
  const provider = (props) => ({ type: 'provider', props })
  const node = render({
    useResource: () => live,
    SessionProvider: provider,
    renderSlot: (key) => ({ type: 'slot', key }),
  })
  // 外层容器必须撑满高度，否则内容短时输入框会跟着最后一条消息走、贴不到面板底部。
  assert.equal(node.type, 'div', '面板最外层必须是撑满高度的容器')
  assert.equal(node.props.style.height, '100%')
  assert.equal(node.props.style.display, 'flex')

  const bound = node.props.children
  assert.equal(bound.type, provider, '必须用官方 SessionProvider 绑定子会话')
  assert.equal(bound.props.session, live.value.reference, '绑定的必须是子会话 reference')
  assert.equal(bound.props.children.type, 'slot')
  assert.equal(bound.props.children.key, 'btw.conversation', '绑定作用域后再渲染自己的子槽')
  client.disposeAll()
})

test('浏览器半部：按官方 tab.visible 上报面板可见性（变化才发，卸载补一次不可见）', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  installFetch(client)
  const registered = client.slotBodies[0].component
  const address = btwSessionAddress('s-child')

  /**
   * 渲染一次 tab body 并跑掉它注册的 effect。
   *
   * @param {boolean} visible - 官方 `useTabInfo().tab.visible` 的值。
   * @returns {Array<() => void>} 清理函数（模拟切走 tab / 关面板时的卸载）。
   */
  const mount = (visible) => {
    reactEffects.length = 0
    const element = registered({
      useTabInfo: () => ({ tab: { contentId: address, visible } }),
      useResource: () => ({ status: 'none' }),
      t: (key) => key,
    })
    assert.ok(element.type(element.props), 'body 应渲染出可见文案')
    return runEffects()
  }
  const visibleCalls = () => client.hostCalls.filter((entry) => entry.action === 'visible')
  const tick = () => new Promise((r) => setTimeout(r, 0))

  // 面板显示在右栏 → 上报「可见」（这正是宿主静音的依据）
  const cleanups = mount(true)
  await tick()
  assert.deepEqual(visibleCalls(), [{ action: 'visible', sessionId: 's-child', visible: true }])

  // 同一个值重复渲染不再重复发（React 会反复求值，不节流会把宿主刷爆）
  mount(true)
  await tick()
  assert.equal(visibleCalls().length, 1)

  // 右栏折叠 / 切到别的 tab：组件卸载 → 补一次「不可见」
  for (const cleanup of cleanups) cleanup()
  await tick()
  assert.deepEqual(visibleCalls().at(-1), { action: 'visible', sessionId: 's-child', visible: false })

  // 再切回来 → 值又变了，重新上报
  mount(true)
  await tick()
  assert.deepEqual(visibleCalls().at(-1), { action: 'visible', sessionId: 's-child', visible: true })

  client.disposeAll()
})

test('浏览器半部：可见性上报失败不回滚本地状态、也不影响面板', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const registered = client.slotBodies[0].component
  const address = btwSessionAddress('s-child')
  globalThis.fetch = () => Promise.reject(new Error('network down'))
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    reactEffects.length = 0
    const element = registered({
      useTabInfo: () => ({ tab: { contentId: address, visible: true } }),
      useResource: () => ({ status: 'none' }),
      t: (key) => key,
    })
    assert.doesNotThrow(() => {
      assert.ok(element.type(element.props))
      runEffects()
    })
    await new Promise((r) => setTimeout(r, 10))
  } finally {
    console.warn = originalWarn
    client.disposeAll()
  }
})

test('浏览器半部：子槽组件渲染官方会话工厂（消息流 + 输入框那一整套）', () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const conversation = client.slotBodies[1].component

  const node = conversation({ renderFactorySlot: (name, props, options) => ({ type: 'factory', name, props, options }) })
  assert.equal(node.type, 'factory')
  assert.equal(node.name, 'conversation.content', '子槽里必须渲染官方会话工厂槽')
  // 三个必填输入属性。
  assert.equal(node.props.variant, 'embedded')
  assert.equal(node.props.phase, 'active')
  assert.equal(node.props.hero, false)
  // views 固定选 chat（侧栏里没有视图切换器的位置）。
  const views = node.options.slots.views
  const viewNode = views({ renderSlot: (key, owner) => ({ type: 'slot', key, owner }) })
  assert.equal(viewNode.key, 'conversation.session')
  assert.deepEqual(viewNode.owner, { view: 'chat' })
  client.disposeAll()
})

test('浏览器半部：/ 源只认领 /btw，菜单候选只在 leading 位置出现', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const source = client.sources[0]
  assert.equal(source.trigger, '/')
  assert.equal(source.name, 'btw')

  const leading = await source.candidates({ sessionId: 's-1' }, { query: '', position: 'leading' })
  assert.equal(leading.length, 1)
  assert.equal(leading[0].name, 'btw')
  assert.equal((await source.candidates({ sessionId: 's-1' }, { query: 'zz', position: 'leading' })).length, 0)
  assert.equal((await source.candidates({ sessionId: 's-1' }, { query: '', position: 'inline' })).length, 0)

  const session = { sessionId: 's-1' }
  assert.equal(await source.matchEnter(session, '/compact', undefined, { attachments: 0 }), undefined)
  assert.equal(await source.matchEnter(session, '/btwx', undefined, { attachments: 0 }), undefined)
  const claimed = await source.matchEnter(session, '/btw 问题', undefined, { attachments: 0 })
  assert.equal(claimed.claim.name, 'btw')
  await assert.rejects(() => source.matchEnter(session, '/btw 问题', undefined, { attachments: 1 }))
  client.disposeAll()
})

test('浏览器半部：submit fork、开在当前格（不带 preferNewPane）、并发出首条消息', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim

  installFetch(client)
  try {
    const outcome = await claim.submit('  为什么这样写？  ', undefined, [])
    assert.deepEqual(outcome, { kind: 'success' })

    assert.equal(client.hostCalls[0].action, 'fork')
    assert.equal(client.hostCalls[0].parentSessionId, 's-1')
    assert.equal(client.hostCalls[0].question, '为什么这样写？')

    assert.equal(client.opened.length, 1)
    assert.equal(client.opened[0].address, btwSessionAddress('s-child'))
    // 回归测试：多传 preferNewPane 会让右栏裂成两格（默认页留左格、tab 掉右格）。
    assert.equal(client.opened[0].opts, undefined)

    assert.equal(client.prompts.length, 1)
    assert.deepEqual(client.prompts[0].content, [{ type: 'text', text: '为什么这样写？' }])
    assert.equal(client.prompts[0].mode, 'queue')
    assert.equal(client.prompts[0].requestId, 'req-1')
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：args 万一是整行也不会把 "/btw …" 原样发出去', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim
  installFetch(client)
  try {
    await claim.submit('/btw 完整一行', undefined, [])
    assert.equal(client.hostCalls[0].question, '完整一行')
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：空问题不发请求；宿主失败 / 404 / 右栏缺失都给可读错误', async () => {
  const client = fakeClient({ withoutSidebar: true })
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim

  const calls = []
  globalThis.fetch = async () => {
    calls.push(1)
    return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'X', message: '宿主说不行' } }) }
  }
  try {
    assert.equal((await claim.submit('   ', undefined, [])).kind, 'error')
    assert.equal(calls.length, 0, '空问题不应该打宿主')
    assert.equal((await claim.submit('问题', undefined, [])).text, '宿主说不行')
  } finally {
    delete globalThis.fetch
  }

  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  try {
    assert.equal((await claim.submit('问题', undefined, [])).text, 'error.unreachable')
  } finally {
    delete globalThis.fetch
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessionId: 's-child', address: btwSessionAddress('s-child') }),
  })
  try {
    assert.equal((await claim.submit('问题', undefined, [])).text, 'error.sidebar')
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：首条消息发不出去时如实回显原因，而不是假装成功', async () => {
  const client = fakeClient({ promptResult: { ok: false, error: { message: 'session/agent-busy' } } })
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim
  installFetch(client)
  try {
    const outcome = await claim.submit('问题', undefined, [])
    assert.equal(outcome.kind, 'error')
    assert.match(outcome.text, /^error\.notSent:/)
    assert.match(outcome.text, /session\/agent-busy/)
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：会话迟迟不就绪时给出可操作提示', async () => {
  const client = fakeClient({ withoutBinding: true })
  clientExports.apply(client.ctx, { readyTimeoutMs: 120 })
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim
  installFetch(client)
  try {
    const outcome = await claim.submit('问题', undefined, [])
    assert.equal(outcome.kind, 'error')
    assert.match(outcome.text, /error\.notSent/)
    assert.match(outcome.text, /就绪/)
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：资源打开时取消归档并保留引用，中止时释放并归档', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  installFetch(client)
  const controller = new AbortController()
  try {
    const iterator = client.providers[0]
      .open(btwSessionAddress('s-child'), { signal: controller.signal })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.done, false)
    assert.equal(first.value.ok, true)
    assert.equal(first.value.value.sessionId, 's-child')
    assert.equal(typeof first.value.value.reference.release, 'function')
    assert.deepEqual(client.hostCalls[0], { action: 'open', sessionId: 's-child' })

    controller.abort()
    const second = await iterator.next()
    assert.equal(second.done, true, 'abort 之后流必须结束')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(client.releases, ['s-child'])
    assert.ok(
      client.hostCalls.some((entry) => entry.action === 'close' && entry.sessionId === 's-child'),
      '面板关闭后必须归档回去',
    )
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：资源流内的失败变成一帧带 error 的值，而不是抛断流', async () => {
  const client = fakeClient({ retainThrows: true })
  clientExports.apply(client.ctx)
  installFetch(client)
  const controller = new AbortController()
  try {
    const iterator = client.providers[0]
      .open(btwSessionAddress('s-child'), { signal: controller.signal })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.value.ok, true)
    assert.match(String(first.value.value.error), /panel\.retainFailed/)
    // 真实原因必须带出来，否则线上无从排查（曾经只写"无法打开"）。
    assert.match(String(first.value.value.error), /session not found/)
    controller.abort()
    await iterator.next()
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：地址无效时也给可见错误帧', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const iterator = client.providers[0]
    .open('dsh-resource://btw/nonsense', { signal: new AbortController().signal })
    [Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value.ok, true)
  assert.equal(first.value.value.error, 'panel.badAddress')
  client.disposeAll()
})

test('浏览器半部：取消归档失败只告警，不阻断面板', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    client.hostCalls.push(payload)
    if (payload.action === 'open') throw new Error('boom')
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const controller = new AbortController()
  const originalWarn = console.warn
  const warned = []
  console.warn = (...args) => warned.push(args.join(' '))
  try {
    const iterator = client.providers[0]
      .open(btwSessionAddress('s-child'), { signal: controller.signal })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.value.ok, true)
    assert.equal(warned.length, 1)
    assert.match(warned[0], /取消归档失败/)
    controller.abort()
    await iterator.next()
  } finally {
    console.warn = originalWarn
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：tab 只挂在**别的**主视图会话的右栏里时，照样兜底归档', async () => {
  // 右栏的状态是按主视图会话分域的：同一条侧边聊天可能因为点过通知而在另一条会话的
  // 右栏里留下一个同地址的 tab（老版本行为）。只看 contentId 会把它当成「还开着」，
  // 于是在归属会话里关掉 tab 也不会归档——本用例把这条锁死。
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-owner' }, candidate: { name: 'btw' } }).claim
  installFetch(client)
  try {
    await claim.submit('问题', undefined, [])
    const address = btwSessionAddress('s-child')
    const closeCalls = () => client.hostCalls.filter((entry) => entry.action === 'close').length

    // 归属会话里出现过 → 记为开着。
    client.setSnapshot([{ sessionId: 's-owner', tabId: 't1', kind: 'btw', contentId: address }])
    client.fire()
    // 归属会话里没了，只剩另一条会话的右栏里那个同地址 tab。
    client.setSnapshot([{ sessionId: 's-other', tabId: 't2', kind: 'btw', contentId: address }])
    client.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(closeCalls(), 1, '别的会话里的同名 tab 不该阻止归档')
    assert.equal(client.hostCalls.at(-1).sessionId, 's-child')
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})

test('浏览器半部：tab 先出现再消失时兜底归档', async () => {
  const client = fakeClient()
  clientExports.apply(client.ctx)
  const claim = client.sources[0].onPick({ session: { sessionId: 's-1' }, candidate: { name: 'btw' } }).claim
  installFetch(client)
  try {
    await claim.submit('问题', undefined, [])
    const address = btwSessionAddress('s-child')
    const closeCalls = () => client.hostCalls.filter((entry) => entry.action === 'close').length

    // 还没出现过就"消失"不算关闭。
    client.setSnapshot([])
    client.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(closeCalls(), 0)

    client.setSnapshot([{ sessionId: 's-1', tabId: 't1', kind: 'btw', contentId: address }])
    client.fire()
    client.setSnapshot([])
    client.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(closeCalls(), 1)
    assert.equal(client.hostCalls.at(-1).sessionId, 's-child')
  } finally {
    delete globalThis.fetch
    client.disposeAll()
  }
})
