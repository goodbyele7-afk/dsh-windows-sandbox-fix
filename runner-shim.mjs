#!/usr/bin/env node
// DSH Windows ACL sandbox -- runnerCommand shim.
//
// WHAT THIS SOLVES
// ----------------
// @deepseek-ai/dsh-sandbox-local builds the ACL runner argv prefix as
//   [process.execPath, runner.js, ...]
// Under the desktop app process.execPath is the GUI-subsystem
// "DeepSeek Harness.exe", which owns no console. Every console-subsystem child
// the runner then creates under the WRITE_RESTRICTED + Low-integrity token has
// to create a console, cannot, and dies in DLL init with 0xC0000142
// (STATUS_DLL_INIT_FAILED = 3221225794). Measured A/B, same runner.js and same
// arguments: host=Electron -> 3221225794, host=node.exe -> exit 0.
//
// The fix is to name a console-subsystem node.exe as the runner host, pointing
// at a disk copy of the support tree (plain node cannot read app.asar paths).
//
// TWO DIALECTS, ONE PROCESS
// -------------------------
// A configured runnerCommand is handed bwrap-profile argv
//   --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
//   [--tmpfs /tmp --bind <ws> <ws>] -- <argv...>
// while the ACL runner reads
//   --workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <argv...>
//
// The translation MUST happen in this process, not in a grandchild: the DSH
// subprocess layer passes the target's stdio on fds 4/5/6 and the control
// channel on fd 7. A grandchild spawned with stdio "inherit" only carries
// 0/1/2, so the control fd is lost and the runner fails with
//   windows-acl-run: uv_get_osfhandle returned an invalid handle for target
//   control fd 7
// We therefore rewrite process.argv and import the unmodified runner in-process,
// so every inherited descriptor stays exactly where DSH put it.
//
// Confinement is untouched: the shipped runner.js still builds the restricted
// token, the capability SIDs, the Low integrity label and the write envelope.
//
// ENVIRONMENT
// -----------
//   DSH_SANDBOX_RUNNER   absolute path to the ACL runner entry to import.
//                        Default: <shim dir>/node_modules/@deepseek-ai/
//                        dsh-sandbox-windows-acl/lib/runner.js
//   DSH_SANDBOX_WORKSPACE  workspace to name when the profile binds none
//                        (read-only mode). Default: process.cwd()
//   DSH_SANDBOX_DEBUG=1  print the translated argv to stderr and exit 0 without
//                        running anything (useful to check dialect translation)
process.on("uncaughtException", (error) => {
  process.stderr.write("windows-acl-run: shim: uncaught " + (error && error.message ? error.message : String(error)) + "\n");
  process.exit(127);
});
process.on("unhandledRejection", (error) => {
  process.stderr.write("windows-acl-run: shim: unhandled " + (error && error.message ? error.message : String(error)) + "\n");
  process.exit(127);
});

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER = join(HERE, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl", "lib", "runner.js");
const RUNNER = resolve(process.env.DSH_SANDBOX_RUNNER ?? DEFAULT_RUNNER);
const DEBUG = process.env.DSH_SANDBOX_DEBUG === "1";

function fail(detail) {
  process.stderr.write("windows-acl-run: " + detail + "\n");
  process.exit(127);
}

/** Translate the bwrap-profile prefix into the ACL runner's argv dialect. */
function translate(argv) {
  let workspace;
  let mode = "read-only";
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") { index += 1; break; }
    switch (token) {
      case "--ro-bind":          // --ro-bind / /
        index += 3; break;
      case "--dev":              // --dev /dev
      case "--proc":             // --proc /proc
      case "--tmpfs":            // --tmpfs /tmp
        index += 2; break;
      case "--unshare-pid":
      case "--die-with-parent":
        index += 1; break;
      case "--bind": {           // --bind <src> <dest>
        const src = argv[index + 1];
        const dest = argv[index + 2];
        if (src === undefined || dest === undefined) fail("missing value after --bind");
        if (workspace !== undefined) fail("multiple --bind tokens are not supported");
        // bwrap semantics: SRC is the host path, DEST is the in-sandbox mount point.
        // The ACL runner has no mount namespace, so it can only confine the HOST
        // path. Refuse an asymmetric pair instead of silently granting SRC.
        if (src !== dest) fail("asymmetric --bind is not supported: " + src + " -> " + dest);
        workspace = src;
        mode = "workspace-write";
        index += 3; break;
      }
      default:
        fail("unexpected profile token: " + String(token));
    }
  }
  const target = argv.slice(index);
  if (target.length === 0) fail("missing command after --");
  // read-only binds nothing, so the seam never names a workspace. The runner
  // still validates the directory; any real directory is inert in that mode
  // because writableDirs stays empty.
  if (workspace === undefined) workspace = process.env.DSH_SANDBOX_WORKSPACE ?? process.cwd();
  return { workspace, mode, target };
}

async function main() {
  if (!existsSync(RUNNER)) fail("acl runner missing: " + RUNNER);
  const { workspace, mode, target } = translate(process.argv.slice(2));
  const argv = [
    process.argv[0],
    RUNNER,
    "--workspace", workspace,
    "--temp", tmpdir(),
    "--mode", mode,
    "--",
    ...target,
  ];
  if (DEBUG) {
    process.stderr.write("windows-acl-run: translated argv " + JSON.stringify(argv) + "\n");
    process.exit(0);
  }
  // The runner reads process.argv.slice(2) and decides on
  // process.env[SUBPROCESS_CONTROL_ENV] / fd 7 -- both untouched here.
  process.argv = argv;
  await import(pathToFileURL(RUNNER).href);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
