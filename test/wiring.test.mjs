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
  const calls = { fork: [], rename: [], unarchive: [], archive: [] }
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection'], '宿主半部应只延迟注入 connection')
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
    },
    get(name) {
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
      return undefined
    },
  }
  return { ctx, routes, calls }
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
