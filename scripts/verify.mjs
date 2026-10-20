#!/usr/bin/env node
// Sanity-check a support tree built by this repo.
//
//   node scripts/verify.mjs --tree "D:\dsh-sandbox-support"
//
// Everything here works from inside the DSH sandbox too. That matters because
// the sandbox denies named-pipe creation, so a spawnSync() with piped stdio
// fails with EPERM. Child output is therefore redirected to a temp FILE.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const TREE = resolve(flag("tree", join(homedirDefault(), "dsh-sandbox-support")));
const ASAR = flag("asar", undefined);

function homedirDefault() {
  return process.env.USERPROFILE ?? process.env.HOME ?? ".";
}

/** Run a child with its output redirected to a temp file (no pipes: the DSH
 *  sandbox denies named-pipe creation, which makes piped spawnSync fail EPERM). */
function capture(command, args, env, cwd) {
  const logPath = join(tmpdir(), "dsh-verify-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".log");
  const fd = openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      stdio: ["ignore", fd, fd],
      env: env ?? process.env,
      cwd: cwd ?? process.cwd(),
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  let output = "";
  try {
    output = readFileSync(logPath, "utf8");
  } catch {
    // leave empty
  }
  rmSync(logPath, { force: true });
  return { status: result.status, error: result.error, output };
}

let failures = 0;
const pass = (label, detail) => console.log("  ok   " + label + (detail ? "  (" + detail + ")" : ""));
const fail = (label, detail) => {
  failures += 1;
  console.log("  FAIL " + label + (detail ? "  (" + detail + ")" : ""));
};

console.log("support tree: " + TREE);
console.log("");

// --- node.exe ---------------------------------------------------------------

const nodeExe = join(TREE, "node.exe");
if (!existsSync(nodeExe)) {
  fail("node.exe present", nodeExe + " is missing");
} else {
  const head = readFileSync(nodeExe);
  if (head.readUInt16LE(0) !== 0x5a4d) {
    fail("node.exe is a PE image", "missing MZ signature");
  } else {
    const pe = head.readUInt32LE(0x3c);
    const subsystem = head.readUInt16LE(pe + 0x5c);
    if (subsystem === 3) pass("node.exe is console-subsystem", head.length + " bytes");
    else fail("node.exe is console-subsystem", "PE subsystem = " + subsystem + " (need 3)");
  }
}

// --- shim -------------------------------------------------------------------

const shim = join(TREE, "runner-shim.mjs");
const shimSource = readSafe(shim);
if (shimSource === undefined) {
  fail("runner-shim.mjs present", shim + " is missing");
} else if (!/function translate\(/.test(shimSource) || !/await import\(pathToFileURL\(RUNNER\)/.test(shimSource)) {
  fail("runner-shim.mjs looks like this repo's shim", "expected an in-process translate() + import()");
} else {
  pass("runner-shim.mjs present and complete", shimSource.length + " bytes");
}

function readSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

// --- runner closure ---------------------------------------------------------

const RUNNER = join(TREE, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl", "lib", "runner.js");
if (existsSync(RUNNER)) pass("acl runner present", statSync(RUNNER).size + " bytes");
else fail("acl runner present", RUNNER + " is missing");

const NATIVE = join(TREE, "node_modules", "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node");
if (existsSync(NATIVE)) pass("koffi native module present", statSync(NATIVE).size + " bytes");
else fail("koffi native module present", NATIVE + " is missing");

// --- native module loads under the host node --------------------------------

if (existsSync(nodeExe) && existsSync(NATIVE)) {
  const run = capture(nodeExe, ["-e", "require('koffi'); console.log('koffi-ok')"], undefined, TREE);
  if (/koffi-ok/.test(run.output)) pass("host node can load koffi", "ABI compatible");
  else fail("host node can load koffi", firstLine(run.output) || (run.error && run.error.code) || "no output");
}

// --- dialect translation ----------------------------------------------------

if (existsSync(nodeExe) && shimSource !== undefined) {
  const run = capture(
    nodeExe,
    [shim, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", "echo", "hi"],
    { ...process.env, DSH_SANDBOX_DEBUG: "1" }
  );
  if (/"--mode","read-only"/.test(run.output)) pass("shim translates the read-only dialect");
  else fail("shim translates the read-only dialect", firstLine(run.output) || "no output");

  const write = capture(
    nodeExe,
    [shim, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
     "--tmpfs", "/tmp", "--bind", TREE, TREE, "--", "echo", "hi"],
    { ...process.env, DSH_SANDBOX_DEBUG: "1" }
  );
  if (/"--mode","workspace-write"/.test(write.output)) pass("shim translates the workspace-write dialect");
  else fail("shim translates the workspace-write dialect", firstLine(write.output) || "no output");
}

// --- staleness vs the installed app.asar -----------------------------------

const checkRun = capture(process.execPath, [
  join(ROOT, "scripts", "extract.mjs"),
  "--out", TREE,
  "--check",
  "--quiet",
  ...(ASAR ? ["--asar", ASAR] : []),
]);
const summary = checkRun.output.split(/\r?\n/).find((line) => line.startsWith("checked")) ?? "";
if (checkRun.status === 0) {
  pass("tree matches the installed app.asar", summary);
} else {
  fail("tree matches the installed app.asar", "stale or unreadable -- re-run scripts/extract.mjs");
  for (const line of checkRun.output.split(/\r?\n/).filter(Boolean).slice(0, 6)) console.log("        " + line);
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/).filter(Boolean)[0];
}

console.log("");
if (failures === 0) {
  console.log("all checks passed.");
  process.exitCode = 0;
} else {
  console.log(failures + " check(s) failed.");
  process.exitCode = 1;
}
