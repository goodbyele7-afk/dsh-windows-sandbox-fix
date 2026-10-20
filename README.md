# DSH Windows 沙箱 `0xC0000142` 修复（profile 补丁，不改 asar）

> **症状**：DeepSeek Harness 桌面版在 Windows 上，把权限切到 **workspace-write（沙箱内）** 后，
> **任何** shell 命令都返回 `[exit code: 3221225794]`，没有 stdout、没有 stderr。
> 切回 **danger-full-access** 立刻正常。
>
> **结论**：沙箱本身没坏，是**托管沙箱 runner 的宿主进程选错了**——
> 上游用 `process.execPath`，在桌面版里那是 GUI 子系统的 Electron 主程序，
> 它没有控制台，而它下面要起的每个子进程都必须在受限令牌下**新建**一个控制台。
> 换成一个控制台子系统的 `node.exe` 托管同一份未修改的 runner，问题消失，隔离强度不打折。

```
3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED
```

---

## English TL;DR

On Windows, DeepSeek Harness desktop's `workspace-write` sandbox fails every command with
`exit 3221225794` (`0xC0000142`, `STATUS_DLL_INIT_FAILED`) and empty output.

**Cause**: `@deepseek-ai/dsh-sandbox-local` launches the ACL confinement runner via
`process.execPath`, which under the desktop app is `DeepSeek Harness.exe` — a **GUI-subsystem**
binary with no console. Every console-subsystem child the runner creates under the
`WRITE_RESTRICTED` + Low-integrity token must allocate a console, cannot, and dies in DLL init.

**Fix**: override `runnerCommand` in the profile so a **console-subsystem `node.exe`** hosts the
**unmodified** upstream runner. A tiny in-process shim translates the bwrap-style argv prefix the
seam hands to a configured runner into the ACL runner's own dialect. No asar patch, no upgrade
breakage, confinement unchanged.

See [README.en.md](README.en.md) for the full English version.

---

## 1. 你是否命中这个问题

在 DSH 里执行下面任意一条，看结果：

- 会话权限设为 **workspace-write**，跑 `echo hi` → `[exit code: 3221225794]`，无输出
- 同一个会话切到 **danger-full-access**，同一条命令 → 正常
- **read-only** 模式 → 往往**能跑**（这是个很有迷惑性的旁证，见 §3）

三条都符合，基本就是这个问题。

### 影响面

| 项目 | 值 |
| --- | --- |
| 平台 | Windows 10 / 11 |
| 关键条件 | DSH 以**提权令牌**运行（High Mandatory Level）时最容易命中 |
| 已验证版本 | DSH Desktop `0.2.1-rc.2`（Electron 44.7.0 / Node 24.21.0 / Windows 10.0.26300） |
| 上游状态 | `@deepseek-ai/dsh-sandbox-windows-acl@0.2.1-rc.1` 的 `lib/*` 与 rc.2 **逐字节相同**，截至 2026-10-20 未修 |

> 不适用的版本：`0.2.0-rc.2` 及更早的差异未验证。若你的版本不同，**先看 §6 的"自行确认根因"**，
> 再决定要不要用。

---

## 2. 根因

### 2.1 上游怎么起 runner

```js
// @deepseek-ai/dsh-sandbox-local/lib/index.js  L539-543
windowsAclRunnerInvocation() {
  ...
  if (existsSync(builtEntry)) return [process.execPath, builtEntry];
  ...
}
```

桌面版的 `process.execPath` 是：

```
D:\...\DeepSeek Harness.exe     ← GUI 子系统（PE Subsystem = 2），没有控制台
```

### 2.2 于是发生了什么

```
DeepSeek Harness.exe          GUI 子系统，无控制台
  └─ runner.js                创建 WRITE_RESTRICTED 令牌 + 降 Low 完整性
       └─ cmd.exe / pwsh.exe  控制台子系统 → 必须有控制台
            └─ 受限令牌下无法分配控制台 → DLL 初始化阶段死亡 → 0xC0000142
```

### 2.3 A/B 实测（决定性证据）

同一份 `runner.js`、同一组参数、同一台机器，**只换宿主**：

| 宿主 | 命令 | 结果 |
| --- | --- | --- |
| `DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`） | `cmd /c echo` | `3221225794`，输出全空 |
| 同目录的 `node.exe`（PE Subsystem = 3） | 同上 | **exit 0**，输出正常 |

### 2.4 为什么 read-only 反而是好的

`read-only` 把 `Everyone` 合并进令牌默认 DACL，控制台创建路径能通过；
`workspace-write` 走 `WRITE_RESTRICTED` 能力 SID 那条路，就过不去。

GUI 程序（如 notepad）在沙箱里也能跑，因为它们**不需要控制台**。
这两个旁证会把人带偏——真正的分界线不是"能不能写"，而是**"子进程要不要控制台"**。

---

## 3. 修复原理

**不动沙箱逻辑，只换 runner 的宿主进程。**

```
DeepSeek Harness.exe
  └─ node.exe（控制台子系统）                 ← 换这里
       └─ runner-shim.mjs                     ← argv 方言转换（进程内）
            └─ import() 原版 runner.js        ← 一份未修改的上游代码
                 └─ 受限令牌 + 能力 SID + Low 完整性 + 写入边界   ← 全部照旧
```

### 为什么 shim 必须"进程内"转换

配置了 `runnerCommand` 之后，seam 交给它的 argv 是 **bwrap 方言**：

```
--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
[--tmpfs /tmp --bind <ws> <ws>] -- <目标 argv...>
```

而 ACL runner 读的是自己的方言：

```
--workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <目标 argv...>
```

**这个翻译必须在同一个进程里做。** DSH 的子进程层把目标进程的 stdio 放在
**fd 4/5/6**、控制通道放在 **fd 7**。用 `stdio: "inherit"` 起的大孙进程只继承 0/1/2，
fd 7 就丢了，你会看到：

```
windows-acl-run: uv_get_osfhandle returned an invalid handle for target control fd 7
```

所以 shim 的做法是**改写 `process.argv` 后直接 `import()` 原版 runner**，
让所有继承描述符原样留在 DSH 放的位置。

### 为什么要把依赖复制到磁盘

普通 `node.exe` **读不了 `app.asar` 内部路径**（`ENOENT`）。所以 runner 和它的依赖闭包
（实测 28 个包 / 1717 个文件 / 约 20 MB）必须落到一个真实目录里。
`node.exe` 本身约 89 MB——直接用系统 PATH 上的 node 也行，见 §4.2。

---

## 4. 安装

### 4.1 三步

```bash
# 1) 取出 runner 依赖闭包（纯 node，会自己解析 app.asar 头，不需要 Electron）
node scripts/extract.mjs --out "D:\dsh-sandbox-support"

# 2) 把宿主 node 放进去（或用 --node 指向已有的）
#    见 4.2
copy "C:\Program Files\nodejs\node.exe" "D:\dsh-sandbox-support\node.exe"

# 3) 拷 shim
copy runner-shim.mjs "D:\dsh-sandbox-support\runner-shim.mjs"
```

然后往 profile 里加配置（见 §4.3），**重启 DSH**。

`scripts/install.mjs` 会把 1–3 步和 §4.3 的 profile 写入一起做掉：

```bash
node scripts/install.mjs --out "D:\dsh-sandbox-support"
```

> 目录可以放任意位置（放系统盘外更好，避免被清理）。

### 4.2 宿主 node 的挑选

要求只有一条：**PE Subsystem = 3（CONSOLE）**，且 ABI 能加载 `koffi` 原生模块。
最省事的做法是直接用**系统安装的 Node.js**——它和 DSH 自带的 Node 版本通常一致。

检查语法：

```powershell
# PE 子系统：3 = 控制台，2 = GUI
```

```bash
node -e "const b=require('fs').readFileSync('node.exe');const pe=b.readUInt32LE(0x3c);console.log('Subsystem =',b.readUInt16LE(pe+0x5c))"
```

顺带说明：DSH 安装目录里的 `DeepSeek Harness.exe` **不能**当宿主，即使加了
`ELECTRON_RUN_AS_NODE=1` —— 它照样是 GUI 子系统。

> **ABI 提醒**：Electron 内置 Node 和官方 Node.js **ABI 号可能不同**（本机实测
> Electron 报 `modules 149`，官方 Node.js 报 `modules 137`）。`koffi` 是本方案唯一的原生依赖，
> 实测在官方 Node.js 下能加载；但如果你换的宿主 node 加载失败，`scripts/verify.mjs` 会直接报出来。

```bash
node scripts/verify.mjs --tree "D:\dsh-sandbox-support"
#  ok   host node can load koffi  (ABI compatible)
```

### 4.3 profile 配置

文件：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`

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

两个字段必须成对出现——上游会校验：
`runnerFailureSignatures` 非空但 `runnerCommand` 为空会抛错，反之亦然。

---

## 5. 验证

重启后：

| 检查 | 期望 |
| --- | --- |
| `workspace-write` 下 `echo hi` | `exit 0`，有输出 |
| `pwsh` 命令 | `exit 0`，PowerShell 7.x |
| 往工作区里写文件 | 成功 |
| 往工作区外写文件 | **失败**（`Access is denied` / `No such file or directory`），文件不存在 |

最后一条是关键：**修复只换宿主，不该削弱边界**。如果沙箱外写入成功了，说明哪里配错了。

自动化检查：

```bash
node scripts/verify.mjs --tree "D:\dsh-sandbox-support"
```

---

## 6. 已知副作用

### bash 的 cygheap 警告（无害）

minGW/MSYS 的 bash 每次启动会往 stderr 打一行：

```
0 [main] bash (2856) cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022
```

Cygwin 在受限令牌下试图改自己进程令牌的默认 DACL，被拒（`0xC0000022` = `STATUS_ACCESS_DENIED`）。
**不影响功能**，退出码正常。`pwsh` 完全干净。

### 诊断技能被注销

设置 `runnerCommand` 后，上游会条件性注销 `diagnose-windows-sandbox-acl` 技能
（`dsh-sandbox-local` L286-291）。修复生效后也不需要它。

### `enforcement` 被硬编码为 `"full"`

`confine()` 在 `runnerCommand` 分支里直接写死 `enforcement: "full"`（L311-321），
绕过 `selectRunner` 的探测。上游对 `windows-acl` 的静态值是 `"partial"`。
本修复因此把"部分强制"报成了"完全强制"。
**实际隔离强度等于没变的 `runner.js`**，但这个字段会误导做安全判断的人，建议知情。

### 自行确认根因

如果你的版本行为不同，先做这个判断：

```bash
# 用 DSH 自己的 Electron 跑一次 runner（应当复现 0xC0000142）
ELECTRON_RUN_AS_NODE=1 "...\DeepSeek Harness.exe" -e "console.log(process.execPath)"

# 用系统 node 跑同一份 runner（应当正常）
node -e "console.log(process.execPath)"
```

---

## 7. 维护

### DSH 升级后

asar 内容变了，支撑树会过期。重跑：

```bash
node scripts/extract.mjs --out "D:\dsh-sandbox-support"
```

然后重启。profile 不用改。

### 目录被挪走

改 profile 里的两条路径即可。

### 回滚

删掉 profile 里 `- id: sandbox` 整段，重启。**同时把会话权限切回 `danger-full-access`**，
否则会退回"命令全挂"的状态。

---

## 8. 为什么不是改 asar

社区已有直接替换 `app.asar` 内 `runner.js` 的方案。它能用，但：

- 每次 DSH 升级都会覆盖 `app.asar`，补丁失效，需要重打
- 修改安装目录意味着你**无法验证**当前跑的是不是被改过的代码
- 本方案用的 `runnerCommand` 是**上游公开的配置项**，`runner.js` 一个字节都不动

本方案自己的代价是：支撑树需要随版本刷新，且 `enforcement` 字段会说谎（见 §6）。

---

## 9. 上游反馈

- Discussion [#10066](https://github.com/deepseek-ai/deepseek-harness/discussions/10066) ——
  已经是同一个根因（GUI 子系统），但只到"能解释"，没给可用修复
- [T-Auto/dsh-ops#92](https://github.com/T-Auto/dsh-ops/issues/92) —— 同类现象
- [Astral-Dream/dsh-windows-sandbox-0xC0000142-workaround](https://github.com/Astral-Dream/dsh-windows-sandbox-0xC0000142-workaround) ——
  改 asar 的方案

仓库里 [docs/upstream-report.md](docs/upstream-report.md) 是一份可以直接贴到上游讨论区的报告草稿。

---

## 10. 免责

- 本仓库**不是**上游官方修复，是按 MIT 分发的第三方补丁。
- 只在少数机器上验证过，不能保证对你的环境有效。
- 修改 profile 前请自行备份。
- 用不用、怎么用，风险自负。

## License

MIT
