# 上游反馈草稿（可直接贴到 Discussion #10066 / 新开 discussion）

> 这份草稿只描述**上游代码里的事实**和一个**不需要改 asar** 的可行方案。
> 贴之前请按你自己的环境改掉版本号和路径。

---

## 标题

**Windows: `workspace-acl` runner should not be hosted by a GUI-subsystem `process.execPath` — reproducible fix via `runnerCommand`**

## 正文（英文）

### Summary

On Windows, `workspace-write` sessions fail every command with `exit 3221225794`
(`0xC0000142`, `STATUS_DLL_INIT_FAILED`) and empty output. `read-only` and
`danger-full-access` both work. Root cause is the **host process** chosen for the ACL runner,
not the confinement logic.

### Root cause in upstream code

`packages/sandbox/sandbox-local/lib/index.js`, `windowsAclRunnerInvocation()` (L539-543 in
`0.2.1-rc.2`):

```js
if (existsSync(builtEntry)) return [process.execPath, builtEntry];
```

Under the Electron desktop app, `process.execPath` is the **GUI-subsystem** main binary
(`DeepSeek Harness.exe`, PE Subsystem = 2). The runner then creates the target under a
`WRITE_RESTRICTED` token dropped to Low integrity. Every console-subsystem target
(`cmd.exe`, `pwsh.exe`, …) must allocate a console; a restricted token cannot, so the child
dies in DLL initialization with `0xC0000142`.

`read-only` does not hit this because it merges `Everyone` into the token's default DACL,
which is enough for the console-creation path. GUI targets also work inside the sandbox.
So the dividing line is *"does the child need a console"*, not *"can it write"*.

### A/B measurement

Same `runner.js`, same argv, same machine, only the host differs:

| host | command | result |
| --- | --- | --- |
| `DeepSeek Harness.exe` (`ELECTRON_RUN_AS_NODE=1`) | `cmd /c echo` | `3221225794`, no output |
| bundled `node.exe` (PE Subsystem = 3) | same | `exit 0`, output present |

### Two other facts worth fixing independently

1. **`enforcement` is hardcoded.** The `runnerCommand` branch of `confine()` returns
   `enforcement: "full"` (L311-321) instead of consulting `selectRunner`. Upstream's static value
   for `windows-acl` is `"partial"`. Setting `runnerCommand` therefore makes the seam *report*
   stronger enforcement than the platform's own rung would. Anything reasoning about that field
   (UI badges, policy decisions) gets a wrong answer.

2. **`runnerCommand` only ever receives the bwrap dialect.** `confine()` passes
   `bwrapProfileArgs(policy)` to *any* configured `runnerCommand` (L314). That is fine for a
   translation shim, but it means a `runnerCommand` cannot be a drop-in replacement for the
   windows-acl runner, which speaks `--workspace/--temp/--mode`. Passing the platform's own
   runner dialect when the configured command is not `bwrap` would make the field composable.

### Suggested upstream fix (small)

Prefer a console-subsystem host for the ACL runner on Windows, e.g.:

```js
// resolve a real node.exe rather than the Electron binary
const nodeHost = resolveConsoleNode() ?? process.execPath;
return [nodeHost, builtEntry];
```

or expose the runner argv prefix as config (the `runnerCommand` field already exists — it just
needs the dialect contract documented as "bwrap profile", plus the `enforcement` fix above).

### Workaround that does not touch the asar

Set `runnerCommand` in the desktop profile to a console-subsystem `node.exe` plus a ~140-line
shim that translates the bwrap argv prefix into the ACL runner argv **in-process** (a grandchild
loses fds 4/5/6 and control fd 7). The repo also carries a dependency-closure extractor that
parses the asar header directly (`plain node.exe` cannot read asar paths) and a verifier that
re-checks every extracted file against the sha256 recorded in the asar, so a DSH upgrade is
detected instead of silently running a stale runner.

*(add your repository link here before posting)*

Notably the shim does not weaken confinement: it imports the **unmodified** shipped `runner.js`,
which still builds the restricted token, capability SIDs, Low integrity label and write envelope.

### Environment

- DSH Desktop `0.2.1-rc.2` (Electron 44.7.0, Node 24.21.0)
- Windows 10.0.26300, elevated token (High Mandatory Level)
- `@deepseek-ai/dsh-sandbox-windows-acl` `0.2.1-rc.1` and `0.2.1-rc.2` `lib/*` byte-identical —
  still present as of 2026-10-20
