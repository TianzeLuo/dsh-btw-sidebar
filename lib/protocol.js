/**
 * protocol.js — 两侧共享的纯逻辑：常量、`/btw` 行解析、右栏会话地址、标题生成。
 *
 * 浏览器半部（`lib/client.js`）是一份必须在浏览器里独立加载的手写 bundle，
 * **不能** import 本文件；那里有一份逐字对应的 `parseBtwLine` / 地址拼装副本，
 * `test/wiring.test.mjs` 会用真实调用做交叉校验，防止两侧漂移。
 *
 * 语义（方案 A）：
 *   - 一次 `/btw <问题>` = 用 `sessions.fork()` 在主会话最后一个完成轮次处分叉出一条**普通会话**，
 *     再把它显示在右侧栏里。因为它是普通会话，所以拿到的是**官方的会话 UI 和完整工具能力**。
 *   - 它**只在面板打开期间取消归档**（归档中的会话被 `ArchivedSessionGate` 禁止跑模型步骤），
 *     关闭面板即重新归档——所以它平时不出现在左侧列表，只在用的时候露一次面。
 *   - 不是子代理：不写主会话日志、不唤醒主对话、不进子代理目录。
 *
 * @module dsh-btw-sidebar/protocol
 */

/** 插件 id：loader 行 id、客户端 bundle id、locale 命名空间都取它。 */
export const PLUGIN_ID = 'dsh-btw-sidebar'

/** 宿主半部注册的精确路由；浏览器半部请求的路径必须逐字一致。 */
export const ROUTE_PATH = '/api/dsh-btw-sidebar'

/** 斜杠命令名（不带前导斜杠）。 */
export const COMMAND_NAME = 'btw'

/** 本插件占用的资源协议名。 */
export const BTW_PROTOCOL = 'btw'

/** 右栏会话资源地址前缀。 */
export const BTW_SESSION_PREFIX = 'dsh-resource://btw/session/'

/** 会话标题前缀。 */
export const TITLE_PREFIX = '侧边聊天'

/** 标题里问题摘要的最大字符数。 */
export const TITLE_QUESTION_MAX = 32

/**
 * 拼一条右栏会话地址。
 *
 * @param {string} sessionId - 分叉出来的会话 id。
 * @returns {string} `dsh-resource://btw/session/<encoded>`。
 */
export function btwSessionAddress(sessionId) {
  return `${BTW_SESSION_PREFIX}${encodeURIComponent(sessionId)}`
}

/**
 * 解析一条右栏会话地址。
 *
 * @param {unknown} address - 可能的资源地址。
 * @param {string} [protocol] - 期望的协议名，默认 `btw`。
 * @returns {string | undefined} 会话 id，非本协议或缺 id 时为 undefined。
 */
export function parseBtwSessionAddress(address, protocol = BTW_PROTOCOL) {
  if (typeof address !== 'string') return undefined
  let url
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== protocol) return undefined
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
 * 解析一条输入框提交行，判断它是不是我们的 `/btw <问题>`。
 *
 * 只有「`/btw` 后跟空白再跟任意内容」或「整行就是 `/btw`」才算我们；`/btwx`、
 * `/btw-abc` 都不算，会交回其它 `/` 触发源，避免吞掉别人的命令。
 *
 * @param {unknown} line - 输入框整行文本（管道已 trim）。
 * @returns {{ mine: boolean, question: string }} 解析结果。
 */
export function parseBtwLine(line) {
  const text = typeof line === 'string' ? line.trim() : ''
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return { mine: false, question: '' }
  return { mine: true, question: (match[1] ?? '').trim() }
}

/**
 * 把问题压成标题里的摘要片段。
 *
 * @param {string} question - 用户的问题。
 * @param {number} [max] - 最大字符数。
 * @returns {string} 单行、折叠空白、超长带省略号的摘要。
 */
export function btwLabel(question, max = TITLE_QUESTION_MAX) {
  const line = String(question ?? '')
    .split('\n', 1)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (line === '') return '新会话'
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * 会话/标签页标题：`侧边聊天 · <摘要>`。
 *
 * @param {string} question - 用户的问题。
 * @param {string} [prefix] - 自定义前缀。
 * @returns {string} 标题。
 */
export function btwTitle(question, prefix = TITLE_PREFIX) {
  return `${prefix} · ${btwLabel(question)}`
}
