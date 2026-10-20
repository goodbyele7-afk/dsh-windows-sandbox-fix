# 发布用的中英文文案

> 复制粘贴用。分三块：仓库描述、上游 Discussion 回复、社交媒体短版。

---

## 1. 仓库 Description（GitHub 那个输入框，限 350 字符）

**英文（推荐用这个，GitHub 上更通用）**

```
Fix DSH Windows workspace-write sandbox failing every command with 0xC0000142. Re-hosts the unmodified upstream ACL runner under a console-subsystem node.exe via runnerCommand. No asar patch, confinement unchanged.
```

**中文**

```
修复 DSH 桌面版 Windows 上 workspace-write 沙箱所有命令 0xC0000142 的问题。通过 runnerCommand 把未修改的上游 ACL runner 换成控制台子系统的 node.exe 托管。不改 asar，隔离强度不变。
```

**Topics（仓库页右上角齿轮里填）**

```
deepseek-harness  dsh  windows  sandbox  acl  restricted-token  c0000142
```

---

## 2. 发到上游 Discussion #10066 的回复

链接：<https://github.com/deepseek-ai/deepseek-harness/discussions/10066>

### 英文版

```markdown
Thanks for pinning down the GUI-subsystem angle — that matches what I measured, and it led to a
working fix that does not touch `app.asar`.

## A/B confirmation

Same `runner.js`, same argv, same machine, only the host differs:

| host | `cmd /c echo` under workspace-write |
| --- | --- |
| `DeepSeek Harness.exe` (`ELECTRON_RUN_AS_NODE=1`, PE Subsystem = 2) | `3221225794` (`0xC0000142`), no output |
| bundled `node.exe` (PE Subsystem = 3) | `exit 0`, output present |

## Why `read-only` is unaffected (a useful confirmation, not a counterexample)

`read-only` merges `Everyone` into the token's default DACL, which is enough for the
console-creation path that `WRITE_RESTRICTED` cannot take. GUI targets also run fine inside the
sandbox because they need no console. So the dividing line is *"does the child need a
console"*, not *"can it write"*.

## Working fix: re-host the runner, leave the runner alone

`runnerCommand` is already a supported config field, so no asar edit is needed:

```yaml
- id: sandbox
  name: "@deepseek-ai/dsh-sandbox-local"
  config:
    runnerCommand:
      - "D:\\dsh-sandbox-support\\node.exe"
      - "D:\\dsh-sandbox-support\\runner-shim.mjs"
    runnerFailureSignatures:
      - "windows-acl-run"
```

The shim has one non-obvious constraint: the bwrap→ACL argv translation **must happen in the
same process**. A configured `runnerCommand` receives `bwrapProfileArgs(policy)`, while the ACL
runner reads `--workspace/--temp/--mode`. Doing that translation in a spawned grandchild loses
fds 4/5/6 (target stdio) and control fd 7, and dies with:

```
windows-acl-run: uv_get_osfhandle returned an invalid handle for target control fd 7
```

So the shim rewrites `process.argv` and `import()`s the unmodified runner in-process. The
restricted token, capability SIDs, Low-integrity label and write envelope are all still created
by the shipped `runner.js` — confinement is unchanged. Verified: writes inside the workspace
succeed, writes outside fail with `Access is denied`.

Repo (shim + asar-header extractor + verifier; MIT):
https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix

Extracted files are byte-identical to what the asar records (1717/1717 sha256 match), which also
gives a cheap upgrade check: re-extract, and `verify.mjs` tells you when the tree went stale.

## Two smaller upstream issues found on the way

1. **`enforcement` is hardcoded.** The `runnerCommand` branch of `confine()` returns
   `enforcement: "full"` instead of consulting `selectRunner`, while the static value for
   `windows-acl` is `"partial"`. Anything that branches on that field (UI badges, policy
   decisions) gets the wrong answer once `runnerCommand` is set.
2. **`runnerCommand` only ever receives the bwrap dialect.** `confine()` hands it
   `bwrapProfileArgs(policy)` unconditionally, so the field cannot be a drop-in replacement for
   the platform's own runner. Passing the platform dialect when the configured command is not
   `bwrap` would make the field composable.

## Suggested upstream fix

Resolve a console-subsystem host for the ACL runner instead of using `process.execPath`
directly, e.g. `[resolveConsoleNode() ?? process.execPath, builtEntry]`.

## Environment

- DSH Desktop `0.2.1-rc.2` (Electron 44.7.0, Node 24.21.0, modules ABI 149)
- Windows 10.0.26300, elevated token (High Mandatory Level)
- `@deepseek-ai/dsh-sandbox-windows-acl` `0.2.1-rc.1` and `0.2.1-rc.2` `lib/*` byte-identical;
  still present as of 2026-10-20
```

### 中文版

```markdown
感谢定位到 GUI 子系统这条线 —— 和我这里实测一致，而且顺着它找到了一个不改 `app.asar` 的可用修复。

## A/B 实测

同一份 `runner.js`、同一组参数、同一台机器，只换宿主：

| 宿主 | workspace-write 下跑 `cmd /c echo` |
| --- | --- |
| `DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`，PE Subsystem = 2） | `3221225794`（`0xC0000142`），无输出 |
| 随包 `node.exe`（PE Subsystem = 3） | `exit 0`，输出正常 |

## 为什么 read-only 不受影响（这是佐证，不是反例）

`read-only` 把 `Everyone` 合并进令牌默认 DACL，控制台创建路径能通过；`WRITE_RESTRICTED` 那条路
就走不通。GUI 程序（如 notepad）在沙箱里也能跑，因为它们不需要控制台。

所以真正的分界线是**「子进程要不要控制台」**，不是**「能不能写」**。

## 可用修复：换宿主，不动 runner

`runnerCommand` 本来就是支持的配置项，所以不用改 asar：

```yaml
- id: sandbox
  name: "@deepseek-ai/dsh-sandbox-local"
  config:
    runnerCommand:
      - "D:\\dsh-sandbox-support\\node.exe"
      - "D:\\dsh-sandbox-support\\runner-shim.mjs"
    runnerFailureSignatures:
      - "windows-acl-run"
```

shim 有个不明显的约束：bwrap→ACL 的参数方言转换**必须在同一个进程内完成**。
配置了 `runnerCommand` 之后拿到的是 `bwrapProfileArgs(policy)`，而 ACL runner 读的是
`--workspace/--temp/--mode`。如果在 spawn 出的大孙进程里做这个转换，会丢掉 fd 4/5/6
（目标 stdio）和控制通道 fd 7，报：

```
windows-acl-run: uv_get_osfhandle returned an invalid handle for target control fd 7
```

所以 shim 的做法是改写 `process.argv` 后直接 `import()` 原版 runner。
受限令牌、能力 SID、Low 完整性标签、写入边界，全部仍由随包的 `runner.js` 创建 ——
隔离强度不变。实测：工作区内可写，工作区外 `Access is denied`。

仓库（shim + asar 头解析抽取器 + 校验器，MIT）：
https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix

抽出来的文件与 asar 记录逐字节一致（1717/1717 sha256 全等），顺带成了一个低成本的升级检查：
重跑一次抽取，`verify.mjs` 会告诉你支撑树是否已经过期。

## 顺带发现的两个上游小问题

1. **`enforcement` 被硬编码。** `confine()` 的 `runnerCommand` 分支直接返回
   `enforcement: "full"`，绕过了 `selectRunner`；而 `windows-acl` 的静态值是 `"partial"`。
   一旦设了 `runnerCommand`，任何依据这个字段做判断的地方（UI 提示、策略决策）都会拿到错误答案。
2. **`runnerCommand` 只能收到 bwrap 方言。** `confine()` 无条件传 `bwrapProfileArgs(policy)`，
   所以这个字段没法直接替代平台自己的 runner。当配置的命令不是 `bwrap` 时改传平台自身方言，
   这个字段就能真正可组合了。

## 建议的上游修复

不要直接用 `process.execPath`，给 ACL runner 解析一个控制台子系统的宿主，
例如 `[resolveConsoleNode() ?? process.execPath, builtEntry]`。

## 环境

- DSH Desktop `0.2.1-rc.2`（Electron 44.7.0 / Node 24.21.0 / modules ABI 149）
- Windows 10.0.26300，提权令牌（High Mandatory Level）
- `@deepseek-ai/dsh-sandbox-windows-acl` `0.2.1-rc.1` 与 `0.2.1-rc.2` 的 `lib/*` 逐字节相同，
  截至 2026-10-20 仍然存在
```

---

## 3. 短版（V2EX / Reddit / HN / 群里）

### 英文

```markdown
DSH desktop on Windows: switching a session to workspace-write made every shell command fail
with `exit 3221225794` (`0xC0000142`) and no output. danger-full-access worked fine.

Cause: the sandbox runner is hosted by `process.execPath`, which in the desktop app is the
GUI-subsystem Electron binary. Children created under the restricted + Low-integrity token need
a console, cannot get one, and die in DLL init.

Fix: host the same, unmodified runner under a console-subsystem `node.exe` via the supported
`runnerCommand` config field. No asar patch, confinement unchanged.

https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix
```

### 中文

```markdown
DSH 桌面版 Windows，把会话切到 workspace-write（沙箱内）后，任何 shell 命令都返回
`[exit code: 3221225794]`（`0xC0000142`），无任何输出；切回 danger-full-access 立刻正常。

根因：沙箱 runner 的宿主用的是 `process.execPath`，在桌面版里那是 GUI 子系统的 Electron
主程序。它下面要起的子进程在受限令牌 + Low 完整性下必须新建控制台，建不出来，
就在 DLL 初始化阶段死了。

修复：还是同一份未修改的 runner，只是换成控制台子系统的 `node.exe` 来托管，
走官方支持的 `runnerCommand` 配置项。不改 asar，隔离强度不变。

https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix
```

---

## 4. 上传时的填写清单

| 位置 | 填什么 |
| --- | --- |
| Repository name | `dsh-windows-sandbox-fix`（已建好） |
| Description | 上面第 1 节那行英文 |
| Topics | `deepseek-harness` `dsh` `windows` `sandbox` `acl` `restricted-token` `c0000142` |
| Website | 留空，或填 Discussion #10066 的链接 |
| 上传方式 | 解压 zip → <https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix/upload/main> |

上传完后建议手动在 GitHub 网页上改一次 commit message（网页上传的默认消息很丑），
或者在本地 push 后用 `git log` 对照 —— 本地这 7 个 commit 的措辞可以直接抄：

```
23edf92 fix: host the Windows ACL runner under a console-subsystem node.exe
d3b8418 docs: note the Electron/Node ABI difference and how verify catches it
c5d7cb7 docs: add publishing instructions
be6765e docs: describe the shim/extractor/verifier set instead of a placeholder link
231176e docs: point at the published repository
70248e5 chore: add push.cmd helper
c5ae012 docs: document the missing-git / broken-GCM / flaky-network traps here
```
