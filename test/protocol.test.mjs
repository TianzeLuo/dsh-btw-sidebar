/**
 * 纯逻辑测试：`/btw` 行解析、右栏会话地址、标题生成。
 *
 * 这些都是「错了不报错、只是行为诡异」的代码：正则放宽一个字符就会吞掉别人的 `/btwx`，
 * 地址拼错一个字符右栏就打不开，标题拼错则会话在列表里认不出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BTW_SESSION_PREFIX,
  COMMAND_NAME,
  PLUGIN_ID,
  ROUTE_PATH,
  TITLE_PREFIX,
  btwLabel,
  btwSessionAddress,
  btwTitle,
  parseBtwLine,
  parseBtwSessionAddress,
} from '../lib/protocol.js'

test('常量：路由必须落在带鉴权的 /api 前缀内', () => {
  assert.equal(PLUGIN_ID, 'dsh-btw-sidebar')
  assert.equal(COMMAND_NAME, 'btw')
  assert.equal(TITLE_PREFIX, '侧边聊天')
  assert.match(ROUTE_PATH, /^\/api\//)
  assert.equal(BTW_SESSION_PREFIX, 'dsh-resource://btw/session/')
})

test('parseBtwLine：认领 /btw 与 /btw <问题>', () => {
  assert.deepEqual(parseBtwLine('/btw'), { mine: true, question: '' })
  assert.deepEqual(parseBtwLine('/btw 为什么这样写？'), { mine: true, question: '为什么这样写？' })
  assert.deepEqual(parseBtwLine('  /btw   多  空格  '), { mine: true, question: '多  空格' })
  assert.deepEqual(parseBtwLine('/btw\n第二行'), { mine: true, question: '第二行' })
})

test('parseBtwLine：不吞别人的命令与普通文本', () => {
  for (const line of ['/btwx', '/btw-abc', '/bt', '/compact', 'btw 问题', '', undefined, 42]) {
    assert.deepEqual(parseBtwLine(line), { mine: false, question: '' }, `should not claim: ${String(line)}`)
  }
})

test('会话地址：拼得出、解得出、只认自己的协议', () => {
  assert.equal(btwSessionAddress('s-1'), `${BTW_SESSION_PREFIX}s-1`)
  assert.equal(parseBtwSessionAddress(btwSessionAddress('s-1')), 's-1')
  const odd = 'session a/b?c'
  assert.equal(parseBtwSessionAddress(btwSessionAddress(odd)), odd)

  for (const bad of [
    'dsh-resource://subagentchat/session/child-1?parent=p&mode=continuable',
    'dsh-resource://btw/thread/btw-1',
    'dsh-resource://btw/session/',
    'dsh-resource://btw/session/a/b',
    'https://example.com/btw/session/x',
    's-1',
    undefined,
    42,
  ]) {
    assert.equal(parseBtwSessionAddress(bad), undefined, `should reject: ${String(bad)}`)
  }
})

test('btwLabel：单行、折叠空白、超长省略', () => {
  assert.equal(btwLabel('  简单问题  '), '简单问题')
  assert.equal(btwLabel('第一行\n第二行'), '第一行')
  assert.equal(btwLabel('多   空格\t混排'), '多 空格 混排')
  assert.equal(btwLabel(''), '新会话')
  assert.equal(btwLabel(undefined), '新会话')
  const long = btwLabel('x'.repeat(100), 10)
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
})

test('btwTitle：会话/标签页标题带前缀', () => {
  assert.equal(btwTitle('为什么这样写？'), '侧边聊天 · 为什么这样写？')
  assert.equal(btwTitle(''), '侧边聊天 · 新会话')
  assert.equal(btwTitle('问题', '旁聊'), '旁聊 · 问题')
})
