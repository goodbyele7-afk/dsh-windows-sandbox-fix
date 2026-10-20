# DSH Windows sandbox `0xC0000142` fix (profile-only, no asar patch)

> **Symptom.** DeepSeek Harness desktop on Windows: the moment you switch a session to
> **workspace-write** (sandboxed), *every* shell command fails with
> `[exit code: 3221225794]` — no stdout, no stderr. Switching back to
> **danger-full-access** makes it work again immediately.
>
> **Cause.** The sandbox is fine. The **host process that hosts the sandbox runner** is wrong:
> upstream uses `process.execPath`, which in the desktop app is the **GUI-subsystem** Electron
> binary with no console — and every console-subsystem child it must create under the restricted
> token needs a console. Hosting the *same, unmodified* runner under a console-subsystem
> `node.exe` fixes it without weakening confinement.

```
3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED
```

---

## 1. Do you have this bug?

Any of these in a DSH session:

- permission preset **workspace-write** → `echo hi` returns `[exit code: 3221225794]`, empty output
- the *same* session at **danger-full-access** → the same command works
- **read-only** mode → usually **works** (a misleading clue, see §2.4)

All three → almost certainly this bug.

| | |
| --- | --- |
| Platform | Windows 10 / 11 |
| Key precondition | DSH running with an **elevated** token (High Mandatory Level) is where it bites |
| Verified version | DSH Desktop `0.2.1-rc.2` (Electron 44.7.0 / Node 24.21.0 / Windows 10.0.26300) |
| Upstream status | `@deepseek-ai/dsh-sandbox-windows-acl@0.2.1-rc.1` `lib/*` is **byte-identical** to rc.2 — still unfixed as of 2026-10-20 |

> Not verified on `0.2.0-rc.2` or earlier. If your version differs, run §6 "confirm the cause
> yourself" before applying anything.

---

## 2. Root cause

### 2.1 How upstream starts the runner

```js
// @deepseek-ai/dsh-sandbox-local/lib/index.js  L539-543
windowsAclRunnerInvocation() {
  ...
  if (existsSync(builtEntry)) return [process.execPath, builtEntry];
  ...
}
```

Under the desktop app, `process.execPath` is:

```
D:\...\DeepSeek Harness.exe     <- GUI subsystem (PE Subsystem = 2), owns no console
```

### 2.2 What that does

```
DeepSeek Harness.exe         GUI subsystem, no console
  └─ runner.js               creates a WRITE_RESTRICTED token, drops to Low integrity
       └─ cmd.exe / pwsh.exe console subsystem -> must allocate a console
            └─ restricted token cannot -> dies in DLL init -> 0xC0000142
```

### 2.3 A/B measurement (the decisive evidence)

Same `runner.js`, same arguments, same machine — **only the host changes**:

| Host | Command | Result |
| --- | --- | --- |
| `DeepSeek Harness.exe` (`ELECTRON_RUN_AS_NODE=1`) | `cmd /c echo` | `3221225794`, empty output |
| bundled `node.exe` (PE Subsystem = 3) | same | **exit 0**, output present |

### 2.4 Why read-only is fine

`read-only` merges `Everyone` into the token's default DACL, so the console-creation path
succeeds; `workspace-write` goes through the `WRITE_RESTRICTED` capability-SID path and does not.
GUI programs (notepad, …) also run fine inside the sandbox because they need no console.

The real dividing line is **"does the child need a console?"**, not **"can it write?"**.

---

## 3. How the fix works

**Nothing in the sandbox logic changes — only the runner's host process.**

```
DeepSeek Harness.exe
  └─ node.exe (console subsystem)             <- swapped
       └─ runner-shim.mjs                     <- argv dialect translation, in-process
            └─ import() the original runner.js <- unmodified upstream code
                 └─ restricted token + capability SIDs + Low integrity + write envelope
```

### Why the translation must be in-process

A configured `runnerCommand` is handed **bwrap-dialect** argv:

```
--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
[--tmpfs /tmp --bind <ws> <ws>] -- <target argv...>
```

The ACL runner reads its own dialect:

```
--workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <target argv...>
```

**This translation must happen in the same process.** The DSH subprocess layer hands the target's
stdio on **fds 4/5/6** and the control channel on **fd 7**. A grandchild spawned with
`stdio: "inherit"` only carries 0/1/2, loses fd 7, and fails with:

```
windows-acl-run: uv_get_osfhandle returned an invalid handle for target control fd 7
```

So the shim rewrites `process.argv` and `import()`s the unmodified runner, leaving every
inherited descriptor exactly where DSH put it.

### Why the dependency closure goes to disk

A plain `node.exe` **cannot read paths inside `app.asar`** (`ENOENT`). The runner and its
dependency closure (measured: 28 packages / 1717 files / ~20 MB) therefore need a real directory.
`node.exe` itself is ~89 MB — or just point at the system Node.js (§4.2).

---

## 4. Install

```bash
# 1) extract the runner dependency closure (plain node; parses the asar header itself)
node scripts/extract.mjs --out "D:\dsh-sandbox-support"

# 2) drop a console-subsystem node.exe in there (or use --node)
copy "C:\Program Files\nodejs\node.exe" "D:\dsh-sandbox-support\node.exe"

# 3) copy the shim
copy runner-shim.mjs "D:\dsh-sandbox-support\runner-shim.mjs"
```

Then add the profile entry (§4.3) and **restart DSH**.

`scripts/install.mjs` does steps 1–3 plus the profile write:

```bash
node scripts/install.mjs --out "D:\dsh-sandbox-support"
```

### 4.2 Choosing the host node

Only hard requirement: **PE Subsystem = 3 (CONSOLE)** and an ABI that can load `koffi`'s native
module. The system Node.js install is usually the easiest — it typically matches the Node version
DSH bundles.

```bash
node -e "const b=require('fs').readFileSync('node.exe');const pe=b.readUInt32LE(0x3c);console.log('Subsystem =',b.readUInt16LE(pe+0x5c))"
```

Note that DSH's own `DeepSeek Harness.exe` **cannot** host the runner even with
`ELECTRON_RUN_AS_NODE=1` — it is still a GUI-subsystem executable.

> **ABI caveat.** Electron's bundled Node and the standalone Node.js build may use
> different module ABI numbers (measured here: Electron reports `modules 149`, stock Node.js
> reports `modules 137`). `koffi` is this fix's only native dependency and it loads fine under
> stock Node.js; if a different host node cannot load it, `scripts/verify.mjs` reports it:

```bash
node scripts/verify.mjs --tree "D:\dsh-sandbox-support"
#  ok   host node can load koffi  (ABI compatible)
```

### 4.3 Profile entry

`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`

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

Both fields must be present together — upstream validates the pairing.

---

## 5. Verify

| Check | Expected |
| --- | --- |
| `echo hi` under workspace-write | `exit 0`, output present |
| a `pwsh` command | `exit 0`, PowerShell 7.x |
| write inside the workspace | succeeds |
| write **outside** the workspace | **fails** (`Access is denied`), no file created |

The last row matters: the fix must not weaken the boundary.

```bash
node scripts/verify.mjs --tree "D:\dsh-sandbox-support"
```

---

## 6. Known side effects

- **bash prints a cygheap line on stderr** — `cygheap_user::init: NtSetInformationToken
  (TokenDefaultDacl), 0xC0000022`. Cygwin trying to rewrite its own token DACL under a restricted
  token. Harmless; exit codes are normal. `pwsh` is clean.
- **The `diagnose-windows-sandbox-acl` skill gets unregistered** while `runnerCommand` is set
  (upstream conditional, `dsh-sandbox-local` L286-291).
- **`enforcement` is hardcoded to `"full"`** in the `runnerCommand` branch of `confine()`
  (L311-321), bypassing `selectRunner`'s probe. Upstream's static value for `windows-acl` is
  `"partial"`. Confinement strength is unchanged (it is the same `runner.js`), but the reported
  field overstates it. Worth knowing if you make security decisions from it.

### Confirm the cause yourself

```bash
ELECTRON_RUN_AS_NODE=1 "...\DeepSeek Harness.exe" -e "console.log(process.execPath)"   # GUI exe
node -e "console.log(process.execPath)"                                                  # console exe
```

---

## 7. Maintenance

After a DSH upgrade the asar changes and the support tree goes stale:

```bash
node scripts/extract.mjs --out "D:\dsh-sandbox-support"
```

then restart. The profile entry does not change unless you move the directory.

Rollback: delete the `- id: sandbox` block, restart, and set session permission back to
`danger-full-access` (otherwise you return to "every command fails").

---

## 8. Why not patch the asar

Replacing `runner.js` inside `app.asar` works, but every DSH upgrade overwrites it, and once you
have modified the install you can no longer verify what is actually running. This approach uses
`runnerCommand`, an upstream-supported config field, and leaves `runner.js` byte-identical.

Its own cost: the support tree needs a refresh per version, and the `enforcement` field lies (§6).

---

## 9. Upstream

- Discussion [#10066](https://github.com/deepseek-ai/deepseek-harness/discussions/10066) — same
  root cause identified (GUI subsystem), but no usable fix
- [T-Auto/dsh-ops#92](https://github.com/T-Auto/dsh-ops/issues/92) — related report
- [Astral-Dream workaround](https://github.com/Astral-Dream/dsh-windows-sandbox-0xC0000142-workaround)
  — the asar-patching approach

[docs/upstream-report.md](docs/upstream-report.md) is a ready-to-paste report for the upstream
discussion.

---

## 10. Disclaimer

Third-party patch, MIT-licensed, not affiliated with DeepSeek. Verified on a small number of
machines only. Back up your profile before editing. Use at your own risk.

## License

MIT
