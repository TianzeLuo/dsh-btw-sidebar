/**
 * 清单测试：package.json 与 cordis.patch.yml 的安装契约。
 *
 * 这两份文件的错误不会在运行时暴露——`dsh plugin add` 会「成功」，然后插件根本不加载。
 * 典型坑：`main` 指错、`exports["./client"]` 漏了（浏览器半部不会被 dsh-client-modules
 * 发现）、patch 里的 `name` 和包名不一致（loader 两段解析落空）、以及 `dsh.client.platform`
 * 不是 `web`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', ROOT)), 'utf8'))
const patch = readFileSync(fileURLToPath(new URL('cordis.patch.yml', ROOT)), 'utf8')

test('package.json：宿主入口、客户端入口与 bundle 声明齐备', () => {
  assert.equal(manifest.name, 'dsh-btw-sidebar')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './lib/host.js')
  assert.equal(manifest.exports['.'], './lib/host.js')
  // 浏览器半部靠这两项被 dsh-client-modules 发现。
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, [])
  // 现在只 require `react`（seed），面板完全复用官方会话槽，没有再声明 external 的需要。
  assert.equal(manifest.dsh.client.external, undefined)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  // 私有包：本插件只在本机 profile 里链接验证，不对外发布。
  assert.equal(manifest.private, true)
})

test('cordis.patch.yml：insert 行的 id 与 name 都指向本包', () => {
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /^\s+- id: dsh-btw-sidebar$/m)
  assert.match(patch, /^\s+name: 'dsh-btw-sidebar'$/m)
  // 同 id 的重复 loader 行会让启动报 duplicate loader entry id。
  assert.equal(patch.match(/id: dsh-btw-sidebar/g).length, 1)
})

test('客户端 bundle：单文件、无 import、以 __ModuleLoader__.load 导出', () => {
  const client = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{/m)
  assert.match(client, /id: 'dsh-btw-sidebar'/)
  // 浏览器 bundle 不能有模块级 import：它是以经典脚本注入的单独文件。
  assert.doesNotMatch(client, /^\s*import\s/m)
})
