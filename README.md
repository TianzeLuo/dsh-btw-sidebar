# dsh-btw-sidebar

像 Codex 的 `/btw`：把当前会话在最后一个完成轮次处分叉，开在 DSH 原生右侧栏里继续聊。主会话不中断，主对话日志不被污染；关掉面板后侧边会话自动归档。

## 安装

```bash
dsh plugin --profile web add github:TianzeLuo/dsh-btw-sidebar
```

1. 重启 `dsh web`（bundle 属启动期组装）
2. 刷新页面

开发调试时可改装本地目录：`dsh plugin --profile web add /path/to/dsh-btw-sidebar`。Windows 上源码与 `$DSH_HOME` 跨盘时不要直接装本地路径，按 [Windows 说明](docs/windows.md) 用脚本。

装不上或装完没反应，看 [排障](docs/troubleshooting.md)。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `>=0.2.2-rc.3`（只写下界） |
| 验证于 | 0.2.2-rc.3（2026-11-13，49 项离线测试通过） |
| Node | `>=22.5` |
| 平台 | WSL2 / Linux 已验证；Windows 未在当前版本复测面板交互 |
| Profile | `web`（依赖原生右侧栏与客户端模块） |

## 能做什么

- **右栏里开一条真实会话**：输入框、工具调用、审批、附件、模型切换与停止都是官方行为。
- **与主会话隔离**：侧边聊天是当前会话在完成轮次处的分叉，主会话继续跑，主对话日志不变。
- **关掉即归档**：关闭标签页后会话从左侧列表消失，需要时可从「已归档」恢复。
- **可选的通知联动**：装了 [dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify) 后，正看着面板时不打扰，点通知回到原来的右栏标签页。

## 用法

| 触发方式 | 位置 | 行为 |
| --- | --- | --- |
| `/btw <问题>` | 任意已开始会话的输入框 | 输入框清空，右栏出现「侧边聊天 · …」标签页并发出首条消息 |
| 继续聊 | 右栏标签页内 | 与普通会话相同的输入、工具、审批与模型选择 |
| 关闭标签页 | 标签页关闭按钮 | 侧边会话归档并从左侧列表消失 |

关掉插件后：`/btw` 命令消失，右栏不再出现新的侧边聊天；已归档的侧边会话仍留在 DSH 会话目录里。

标题前缀、通知抑制与调试开关见 [开发说明](docs/development.md#配置)；已知边界见 [已知限制](docs/limitations.md)。

## 已知限制

- 面板打开期间，这条会话会出现在左侧会话列表里（平台约束）；关闭面板即归档。
- 主会话至少要有**一个已完成的轮次**才能分叉。
- `/btw` 命令本身不接受附件；需要附件时在打开的面板里用官方输入框发送。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 实现取舍、架构、配置、DSH 契约与测试 |
| [docs/limitations.md](docs/limitations.md) | 已知限制与平台硬约束 |
| [docs/notifications.md](docs/notifications.md) | 与 [dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify) 的联调、降级与开关 |
| [docs/windows.md](docs/windows.md) | Windows 跨盘安装的坑与脚本 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障：页面起不来、通知异常、日志位置 |

## 隐私与数据

- 读取：当前会话的已完成轮次（分叉点）、右栏标签页状态与通知可见性。
- 外发：不额外发起网络请求；侧边聊天的模型调用走 DSH 原有会话链路。
- 存储：侧边会话与普通 DSH 会话相同，存放在 DSH 会话目录；归档后仍在磁盘。
- 关闭后：关闭标签页会归档会话；卸载插件不会删除已归档会话。

## 许可证

MIT，见 [LICENSE](LICENSE)。
