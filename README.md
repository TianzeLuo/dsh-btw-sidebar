# dsh-btw-sidebar

**像 Codex 的 `/btw`：把当前会话在最后一个完成轮次处**分叉**出一条会话，开在 DSH 原生右侧栏里继续聊。**
官方会话界面与工具能力、真实副作用；主会话不被打断，主对话日志也不被污染。

```text
/btw 这里为什么用 fork 而不是 spawn？
        ↓
右栏当前格出现标签页「侧边聊天 · 这里为什么用 fork…」，里面就是普通会话（输入框/工具/审批都在）
        ↓
主会话继续跑；关掉面板 → 这条会话重新归档，从左侧列表消失
```

## 支持范围

| | |
|---|---|
| DSH | `0.1.7` 系列。本仓库在 **0.1.7-rc.2** 上验证：Linux/WSL 端到端实际使用；Windows 验证到「安装 + 加载」（脚本、47/47 单测、`dsh --dump-config` 组合正常），面板交互建议自测一次 `/btw`。不做跨版本兼容 |
| Profile / App | **`web`**：需要原生右侧栏与客户端模块（`dsh.client.platform = "web"`，其他 app 下客户端半部不会加载）。headless / desktop profile 不适用 |
| Node | `>= 22.5`（`engines`；实测 v24） |
| OS | **Linux / WSL ✅**；**Windows ✅**（检出与 `$DSH_HOME` 跨盘符时必须用脚本，见下） |
| 可选依赖 | `dsh-away-notify`：装了才有「看着面板不打扰 + 点通知回到右栏」。缺席时 `/btw` 照常可用，通知走默认行为（见 [docs/notifications.md](docs/notifications.md)） |

## 安装

**Linux / WSL**（检出与 `$DSH_HOME` 同盘时普通 link 即可）：

```bash
dsh plugin --profile web add /mnt/f/project/tools/plugin/dsh-btw-sidebar
```

**Windows**：profile 默认在 `C:\Users\<你>\.dsh`，检出若在别的盘（例如 `F:`），**不要直接
`dsh plugin add F:\...`**——pnpm 会装出一个解析不到的 junction，`dsh plugin` 只给一条误导性的
`declares no dsh.bundle` 警告且退出码仍是 0，插件重启后根本不加载；而且之后任何一次
`pnpm install` / `dsh plugin add` 都会把已经装好的插件弄坏。用脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   -Profile web        指定 profile（默认 web）
#   -SkipInstall        只修不装（依赖已在 package.json 里时用）
#   -WhatIfOnly         只报告，不改任何文件
#   -PluginDir <路径>   脚本是通用的：装/修别的插件也可以
```

原因、脚本行为与镜像目录说明见 [docs/windows.md](docs/windows.md)。

**装完需要重启 `dsh web`**（`dsh.profile.bundles` 只在启动时读取）；只改客户端半部时刷新页面即可。
`cordis.patch.yml` 的 `insert:` 行由 `dsh plugin add` 自动追加进 bundles，**不要**手写同 id 条目
（会报 `duplicate loader entry id`）。

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
- 关掉标签页 → 会话归档、从左侧列表消失；在左侧「已归档」视图里可以恢复它。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（改配置需要重启 `dsh web`）：

```yaml
- id: dsh-btw-sidebar
  config:
    titlePrefix: '侧边聊天'          # 会话/标签页标题前缀
    suppressNotifications: true     # 面板显示在右栏且你正看着 dsh 时静音（默认开）
    debug: false                    # 打印诊断日志
```

`suppressNotifications: false` 只是不声明抑制规则（通知照弹），**「点通知回到右栏 tab」不受影响**。
语义、判定依据与降级行为见 [docs/notifications.md](docs/notifications.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/development.md](docs/development.md) | 三版实现的取舍与两次否决、架构、DSH 契约上的坑、测试与验收状态 |
| [docs/limitations.md](docs/limitations.md) | 已知限制与平台硬约束 |
| [docs/notifications.md](docs/notifications.md) | 与 `dsh-away-notify` 的集成：抑制/揭示语义、可选依赖的降级、开关 |
| [docs/windows.md](docs/windows.md) | Windows 跨盘符安装的坑、`install-windows.ps1` 行为、镜像目录 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障：页面起不来、踩过的三次 UI 事故、日志位置 |

## 开发

```bash
node --test     # 47 项，全部离线：不碰网络、不读真实 home 目录、不调真实模型
```
