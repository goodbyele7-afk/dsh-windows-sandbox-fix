#!/usr/bin/env node
// One-shot installer: build the support tree, place the shim, optionally patch
// the DSH profile.
//
//   node scripts/install.mjs --out "D:\dsh-sandbox-support"
//
// Options:
//   --out <dir>        support tree destination (default %USERPROFILE%\dsh-sandbox-support)
//   --asar <file>      explicit app.asar path (default: autodetect)
//   --node <file>      node.exe to copy in (default: the running interpreter if it
//                      is a real console-subsystem node.exe, else the system Node.js)
//   --profile <file>   profile patch to edit
//                      (default %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml)
//   --no-profile       build the tree only; do not touch the profile
//   --force            overwrite an existing "- id: sandbox" block
//   --dry-run          print what would happen, change nothing
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const OUT = resolve(flag("out", join(homedir(), "dsh-sandbox-support")));
const ASAR = flag("asar", undefined);
const NODE_SRC = flag("node", undefined);
const PROFILE = resolve(flag("profile", join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml")));
const NO_PROFILE = argv.includes("--no-profile");
const FORCE = argv.includes("--force");
const DRY = argv.includes("--dry-run");

/** PE Subsystem of an executable: 2 = GUI, 3 = console. */
function peSubsystem(file) {
  try {
    const head = readFileSync(file);
    if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return undefined; // "MZ"
    const pe = head.readUInt32LE(0x3c);
    if (head.readUInt32LE(pe) !== 0x00004550) return undefined; // "PE\0\0"
    return head.readUInt16LE(pe + 0x5c);
  } catch {
    return undefined;
  }
}

/** Pick a console-subsystem node.exe to host the runner. */
function chooseNode() {
  const candidates = [];
  if (NODE_SRC) candidates.push(NODE_SRC);
  // The interpreter running this script is ideal when it is a real node.exe.
  if (process.execPath && /node\.exe$/i.test(process.execPath)) candidates.push(process.execPath);
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "nodejs", "node.exe"));
  if (process.env["ProgramFiles(x86)"]) candidates.push(join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe"));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (peSubsystem(candidate) === 3) return candidate;
  }
  return undefined;
}

function step(message) {
  console.log((DRY ? "[dry] " : "") + message);
}

// --- 1. support tree --------------------------------------------------------

step("extracting the runner dependency closure into " + OUT);
if (!DRY) {
  const args = [join(ROOT, "scripts", "extract.mjs"), "--out", OUT, "--quiet"];
  if (ASAR) args.push("--asar", ASAR);
  const run = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (run.status !== 0) {
    console.error("extract failed; fix the reported problem and re-run");
    process.exit(run.status ?? 1);
  }
}

// --- 2. host node -----------------------------------------------------------

const nodeSource = chooseNode();
if (!nodeSource) {
  console.error("");
  console.error("No console-subsystem node.exe found.");
  console.error("Install Node.js for Windows, or pass --node <path to node.exe>.");
  console.error("(DeepSeek Harness.exe cannot be used even with ELECTRON_RUN_AS_NODE=1:");
  console.error(" it is a GUI-subsystem binary.)");
  process.exit(1);
}
step("host node: " + nodeSource + " -> " + join(OUT, "node.exe"));
if (!DRY && resolve(nodeSource) !== resolve(join(OUT, "node.exe"))) {
  copyFileSync(nodeSource, join(OUT, "node.exe"));
}

// --- 3. shim ----------------------------------------------------------------

const shimTarget = join(OUT, "runner-shim.mjs");
step("shim: " + join(ROOT, "runner-shim.mjs") + " -> " + shimTarget);
if (!DRY) copyFileSync(join(ROOT, "runner-shim.mjs"), shimTarget);

// --- 4. profile -------------------------------------------------------------

if (NO_PROFILE) {
  step("profile untouched (--no-profile)");
} else if (!existsSync(PROFILE)) {
  console.log("");
  console.log("profile not found: " + PROFILE);
  console.log("Add this block by hand, then restart DSH:");
  console.log("");
  console.log(profileBlock(OUT));
} else {
  const text = readFileSync(PROFILE, "utf8");
  const block = profileBlock(OUT);
  const existing = /^- id: sandbox\s*$/m.test(text);
  if (existing && !FORCE) {
    step("profile already has an '- id: sandbox' block; leaving it alone (use --force to replace)");
  } else if (DRY) {
    step("would " + (existing ? "replace" : "append") + " the sandbox block in " + PROFILE);
  } else {
    const backup = PROFILE + ".bak-sandbox-fix-" + Date.now();
    writeFileSync(backup, text);
    const updated = existing ? replaceSandboxBlock(text, block) : text.replace(/\s*$/, "\n") + "\n" + block + "\n";
    writeFileSync(PROFILE, updated);
    step("profile updated (backup: " + backup + ")");
  }
}

console.log("");
console.log("done. Restart DeepSeek Harness, then set a session to workspace-write and run: echo hi");
if (!DRY) console.log("verify with: node " + join(ROOT, "scripts", "verify.mjs") + " --tree \"" + OUT + "\"");

/** The YAML block this fix adds. */
function profileBlock(tree) {
  const escape = (p) => p.replace(/\\/g, "\\\\");
  return [
    "# Windows ACL sandbox: host the runner under a console-subsystem node.exe.",
    "# Upstream uses process.execPath, which is the GUI-subsystem Electron binary.",
    "# https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix",
    "- id: sandbox",
    '  name: "@deepseek-ai/dsh-sandbox-local"',
    "  config:",
    "    runnerCommand:",
    '      - "' + escape(join(tree, "node.exe")) + '"',
    '      - "' + escape(join(tree, "runner-shim.mjs")) + '"',
    "    runnerFailureSignatures:",
    '      - "windows-acl-run"',
  ].join("\n");
}

/** Replace an existing "- id: sandbox" block (up to the next top-level entry). */
function replaceSandboxBlock(text, block) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^- id: sandbox\s*$/.test(line));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^- /.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)].join("\n");
}
