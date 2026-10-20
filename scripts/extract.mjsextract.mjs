#!/usr/bin/env node
// Extract the ACL sandbox runner's dependency closure out of app.asar onto disk.
//
// The shim runs the runner under a plain console-subsystem node.exe, and plain
// node.exe cannot read paths inside app.asar (ENOENT). This script parses the
// asar header directly -- no Electron, no asar package -- and writes the files
// out, honouring the "unpacked" flag for native modules such as koffi.
//
//   node scripts/extract.mjs --out "D:\dsh-sandbox-support"
//
// Options:
//   --out <dir>     destination root (default: %USERPROFILE%\dsh-sandbox-support)
//   --asar <file>   explicit path to app.asar (default: autodetect)
//   --node <file>   host node.exe to copy into <out>\node.exe
//   --check         verify only: compare the tree in --out against the asar
//   --quiet         print nothing but errors and the final summary line
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const OUT = resolve(flag("out", join(homedir(), "dsh-sandbox-support")));
const CHECK_ONLY = argv.includes("--check");
const QUIET = argv.includes("--quiet");
const NODE_SRC = flag("node", undefined);

// The runner is these packages plus their dependency closure. Kept in sync with
// @deepseek-ai/dsh-sandbox-windows-acl's own imports.
const ROOTS = [
  "@deepseek-ai/dsh-sandbox-windows-acl",
  "@deepseek-ai/dsh-subprocess",
  "@deepseek-ai/dsh-win32-process",
  "@deepseek-ai/dsh-lazy-require",
  "@deepseek-ai/dsh-skill",
  "koffi",
  "yaml",
  "@koromix/koffi-win32-x64",
];

function log(...parts) {
  if (!QUIET) console.log(...parts);
}

/** Candidate app.asar locations, most specific first. */
function asarCandidates() {
  const out = [];
  out.push(process.env.DSH_ASAR);
  // Running under the packaged app: .../resources/app.asar
  if (process.resourcesPath) out.push(join(process.resourcesPath, "app.asar"));
  if (process.execPath) out.push(join(dirname(process.execPath), "resources", "app.asar"));
  if (process.env.LOCALAPPDATA) {
    out.push(join(process.env.LOCALAPPDATA, "Programs", "deepseek-harness", "resources", "app.asar"));
    out.push(join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar"));
  }
  if (process.env.ProgramFiles) {
    out.push(join(process.env.ProgramFiles, "DeepSeek Harness", "resources", "app.asar"));
  }
  return out.filter(Boolean);
}

function findAsar(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error("app.asar not found: " + explicit);
    return explicit;
  }
  for (const candidate of asarCandidates()) {
    if (!existsSync(candidate)) continue;
    if (hasAclPackage(candidate)) return candidate;
  }
  throw new Error(
    "cannot locate app.asar. Pass --asar <path to resources\\app.asar>.\nTried:\n  " +
      asarCandidates().join("\n  ")
  );
}

/** Cheap structural read used to score candidates before committing to one. */
function hasAclPackage(asar) {
  try {
    const header = readHeader(asar);
    return Boolean(header.files?.dsh?.files?.node_modules?.files?.["@deepseek-ai"]);
  } catch {
    return false;
  }
}

/**
 * Parse the asar header.
 *
 * Layout: u32 headerSize=4, u32 pickleSize, u32 payloadSize, u32 jsonLength,
 * then jsonLength bytes of JSON, then the file blobs. A blob at header offset
 * O lives at 16 + jsonLength + O.
 */
function readHeader(asar) {
  const SENTINEL = 16;
  const handle = openSync(asar, "r");
  const prefix = Buffer.alloc(SENTINEL);
  readSync(handle, prefix, 0, SENTINEL, 0);
  if (prefix.readUInt32LE(0) !== 4) {
    throw new Error("not an asar archive (unexpected header size): " + asar);
  }
  const jsonLength = prefix.readUInt32LE(12);
  const jsonBytes = Buffer.alloc(jsonLength);
  readSync(handle, jsonBytes, 0, jsonLength, SENTINEL);
  const header = JSON.parse(jsonBytes.toString("utf8"));
  return Object.assign(header, { __base: SENTINEL + jsonLength, __handle: handle, __path: asar });
}

/** Read one archived file's bytes. */
function blobBytes(header, entry) {
  const out = Buffer.alloc(entry.size);
  if (entry.size > 0) readSync(header.__handle, out, 0, entry.size, header.__base + Number(entry.offset));
  return out;
}

/** Split an asar file path into segments. */
function segments(p) {
  return p.split("/").filter(Boolean);
}

/** Follow a path through the header's file tree. */
function nodeAt(header, p) {
  let node = header;
  for (const segment of segments(p)) {
    if (!node.files || !node.files[segment]) return undefined;
    node = node.files[segment];
  }
  return node;
}

/** Walk the whole archive, yielding { path, entry, dir }. */
function walk(header) {
  const files = [];
  const dirs = [];
  (function descend(node, path) {
    if (node.files) {
      dirs.push(path || "/");
      for (const name of Object.keys(node.files)) {
        descend(node.files[name], path ? path + "/" + name : name);
      }
      return;
    }
    files.push({ path, entry: node });
  })(header, "");
  return { files, dirs };
}

const NM = "dsh/node_modules";
const header = readHeader(findAsar(flag("asar", undefined)));
const archive = walk(header);
const byPath = new Map(archive.files.map((f) => [f.path, f]));

/** Read a file out of the archive (or the .unpacked sibling). */
function readArchived(relPath) {
  const hit = byPath.get(relPath);
  if (!hit) return undefined;
  if (hit.entry.unpacked) {
    const disk = join(header.__path + ".unpacked", ...segments(relPath));
    return existsSync(disk) ? readFileSync(disk) : undefined;
  }
  return blobBytes(header, hit.entry);
}

/** package.json of a package that lives directly under dsh/node_modules. */
function readPackage(name) {
  const bytes = readArchived(NM + "/" + name + "/package.json");
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

const closure = new Map(); // name -> { files: [relPaths], packageJson }
const missing = [];
const pending = [...ROOTS];

while (pending.length > 0) {
  const name = pending.pop();
  if (closure.has(name)) continue;
  const pkg = readPackage(name);
  if (!pkg) {
    missing.push(name);
    continue;
  }
  const prefix = NM + "/" + name + "/";
  const files = archive.files.map((f) => f.path).filter((p) => p.startsWith(prefix));
  closure.set(name, { files, pkg });
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
  for (const dep of deps) if (!closure.has(dep)) pending.push(dep);
}

const allFiles = [];
for (const name of [...closure.keys()].sort()) {
  for (const rel of closure.get(name).files) allFiles.push(rel);
}
allFiles.sort();

// ---------------------------------------------------------------------------

if (CHECK_ONLY) {
  let ok = 0;
  const stale = [];
  const absent = [];
  for (const rel of allFiles) {
    const dest = join(OUT, "node_modules", ...segments(rel.slice(NM.length)));
    const entry = byPath.get(rel).entry;
    if (!existsSync(dest)) {
      absent.push(rel);
      continue;
    }
    if (!entry.integrity?.hash) {
      ok += 1;
      continue;
    }
    const digest = createHash("sha256").update(readFileSync(dest)).digest("hex");
    if (digest === entry.integrity.hash) ok += 1;
    else stale.push(rel);
  }
  console.log("checked  : " + allFiles.length + " files");
  console.log("identical: " + ok);
  console.log("modified : " + stale.length + (stale.length ? "\n  " + stale.slice(0, 10).join("\n  ") : ""));
  console.log("missing  : " + absent.length + (absent.length ? "\n  " + absent.slice(0, 10).join("\n  ") : ""));
  process.exitCode = stale.length || absent.length ? 1 : 0;
} else {
  const target = join(OUT, "node_modules");
  rmSync(target, { recursive: true, force: true });
  let written = 0;
  let unpacked = 0;
  for (const rel of allFiles) {
    const entry = byPath.get(rel).entry;
    const dest = join(OUT, "node_modules", ...segments(rel.slice(NM.length)));
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.unpacked) {
      const disk = join(header.__path + ".unpacked", ...segments(rel));
      if (!existsSync(disk)) continue;
      copyFileSync(disk, dest);
      unpacked += 1;
    } else {
      writeFileSync(dest, blobBytes(header, entry));
    }
    written += 1;
  }
  log("source        : " + header.__path);
  log("packages      : " + closure.size);
  log("files written : " + written + " (native/unpacked passed through: " + unpacked + ")");
  if (missing.length) log("unresolved    : " + missing.join(", "));

  if (NODE_SRC) {
    if (!existsSync(NODE_SRC)) throw new Error("--node target not found: " + NODE_SRC);
    copyFileSync(NODE_SRC, join(OUT, "node.exe"));
    log("host node     : " + NODE_SRC + " -> " + join(OUT, "node.exe"));
  } else if (!existsSync(join(OUT, "node.exe"))) {
    log("");
    log("!! " + join(OUT, "node.exe") + " is missing.");
    log("!! Copy a console-subsystem node.exe there, or re-run with --node <path>.");
  }

  const shimSource = join(dirname(fileURLToPath(import.meta.url)), "..", "runner-shim.mjs");
  const shimTarget = join(OUT, "runner-shim.mjs");
  if (existsSync(shimSource) && resolve(shimSource) !== resolve(shimTarget)) {
    copyFileSync(shimSource, shimTarget);
    log("shim          : " + shimTarget);
  }

  console.log("support tree ready: " + OUT);
}

closeSync(header.__handle);
