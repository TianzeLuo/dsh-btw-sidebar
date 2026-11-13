# Windows：跨盘符安装

## 症状

profile 在 `C:\Users\<你>\.dsh`（C:），插件检出在别的盘（例如 `F:`）。直接：

```powershell
dsh plugin --profile web add F:\path\to\dsh-btw-sidebar
```

命令**退出码 0**，只有一条很容易忽略的 warning：

```text
+ dsh-btw-sidebar link:F:/path/to/dsh-btw-sidebar
dsh: warning: dsh-btw-sidebar declares no dsh.bundle — installed as a plain dependency...
```

依赖写进了 profile 的 `package.json`，但 `dsh.profile.bundles` 没变——**重启后插件根本不加载**，
而报错方向是误导的（看起来像插件少声明了 `dsh.bundle`，实际插件声明得好好的）。

根因：pnpm 把这条**绝对路径当成相对路径**拼到了 profile 目录后面，于是 junction 指向一个不存在的路径：

```text
linkType = Junction
target   = C:\Users\<你>\.dsh\profiles\web\F:\path\to\dsh-btw-sidebar   ← 不存在
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ profile 目录被粘在绝对路径前面
```

触发条件是 **`nodeLinker: hoisted`（dsh 的 profile 模板自己写进 `pnpm-workspace.yaml`）×
link 目标与 profile 不同盘符**：跨盘符没有相对路径可表示，pnpm 就拼出了上面这个畸形目标。

更麻烦的是**它会把已经装好的东西弄坏**：lockfile 里那条 `version: link:F:/...` 同样被当成相对路径，
所以下一次 `pnpm install` / `dsh plugin add` 重建链接时会再次产生坏 junction，并顺手把该包从
`dsh.profile.bundles` 里摘掉；一旦有依赖解析不到，`dsh plugin add` 会直接抛：

```text
Error: dsh: cannot resolve profile bundle "..." from the dsh installation or C:\Users\<你>\.dsh\profiles\web
```

## 做法：同盘镜像 junction

`scripts/install-windows.ps1` 在 profile 所在盘上建一个指向检出的 junction：

```text
%USERPROFILE%\.dsh\plugin-mirrors\<包名>  ->  F:\project\tools\plugin\<包名>
```

依赖于是记成 `link:C:/Users/<你>/.dsh/plugin-mirrors/<包名>`（**同盘**），pnpm 能在 lockfile 里把它写成
普通的相对路径 `version: link:../../plugin-mirrors/<包名>`，`add` 与之后每一次 `install` 都能解析。
Node 顺着 junction 读真实文件，**所以改代码仍然即时生效**，不损失开发时的 link 语义。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   -Profile web        指定 profile（默认 web）
#   -SkipInstall        只修不装
#   -WhatIfOnly         只报告，不改任何文件
#   -PluginDir <路径>   对别的插件检出执行同样的安装/修复
```

脚本按顺序做六件事：

1. 为指定检出建/修镜像 junction（检出与 profile 同盘时自动跳过，直接用原路径）；
2. 跑正常的 `dsh plugin --profile <profile> add <镜像路径>`（**不信任它的退出码**：dsh 失败也返回 0）；
3. 把 profile 里**所有**跨盘符 `link:` 依赖都换成同盘镜像，并修好 `node_modules` 里的链接；
4. 需要时重建 `pnpm-lock.yaml` 与 `node_modules/.pnpm/lock.yaml`
   （lockfile 里的绝对 `link:` 版本就是下一次安装的定时炸弹）；
5. 补登 `dsh.profile.bundles`（dsh 在链接坏掉的那次安装里会把包摘掉，只留一条 warning）；
6. 用 `node require.resolve` 与 `dsh --profile <profile> --dump-config` 复验。

安全细节：脚本只删**链接本身**（先确认它是 reparse point），绝不用 PS 5.1 的 `Remove-Item -Recurse`
——那会顺着 junction 递归删掉检出的源码。

## 注意事项

- profile `package.json` 里的依赖此后是 `link:C:/Users/<你>/.dsh/plugin-mirrors/<包名>`：
  **不要手改回 `F:`**，否则下一次安装又会坏。
- 检出换位置 / 换机器后重跑脚本即可（镜像会重建）。
- 卸载后不再需要镜像时，可以删掉 `%USERPROFILE%\.dsh\plugin-mirrors\<包名>`。
- 在 Windows 上装本仓库的任何插件都**不要**写 `dsh plugin add F:\...`：要么用脚本，要么手动把路径
  写成镜像路径 `%USERPROFILE%\.dsh\plugin-mirrors\<包名>`。
