#!/usr/bin/env node
// Everything in this repo shares one version: the npm packages, the private
// workspace packages, the Rust crates, the repo root (whose v<version> tag is
// the release) and the OpenClaw plugin's manifest. changesets keeps the
// workspace packages together (a "fixed" group); this copies their version to
// the places changesets doesn't know about.
//
//   node scripts/sync-versions.mjs           write the workspace version everywhere
//   node scripts/sync-versions.mjs --check   fail if anything differs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const rel = (p) => path.relative(root, p);

const config = JSON.parse(fs.readFileSync(path.join(root, ".changeset/config.json"), "utf8"));
const group = config.fixed[0];

// The `packages:` list of pnpm-workspace.yaml.
const workspaceYaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const workspace = [];
for (const line of workspaceYaml.slice(workspaceYaml.indexOf("packages:")).split("\n").slice(1)) {
  const m = line.match(/^\s+-\s+(\S+)/);
  if (!m) break;
  workspace.push(path.join(root, m[1], "package.json"));
}

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const versions = new Map(workspace.map((p) => [p, read(p).version]));
const names = workspace.map((p) => read(p).name);

const problems = [];
for (const n of names) if (!group.includes(n)) problems.push(`${n} is a workspace package but not in .changeset/config.json "fixed"`);
for (const n of group) if (!names.includes(n)) problems.push(`"fixed" lists ${n}, which isn't a workspace package`);
const distinct = [...new Set(versions.values())];
if (distinct.length !== 1) {
  for (const [p, v] of versions) problems.push(`${rel(p)}: ${v}`);
  problems.unshift(`workspace packages disagree on the version:`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const version = distinct[0];

// [file, current version, write(version)]
const targets = [];

function jsonVersion(p) {
  const text = fs.readFileSync(p, "utf8");
  const current = JSON.parse(text).version;
  targets.push([p, current, (v) => fs.writeFileSync(p, text.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`))]);
}
jsonVersion(path.join(root, "package.json"));
jsonVersion(path.join(root, "src/openclaw-voice/openclaw.plugin.json"));

for (const crate of ["src/server", "src/registry"]) {
  const toml = path.join(root, crate, "Cargo.toml");
  const text = fs.readFileSync(toml, "utf8");
  const name = text.match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)[1];
  const pkgVersion = /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/ms;
  targets.push([toml, text.match(pkgVersion)[2], (v) => fs.writeFileSync(toml, text.replace(pkgVersion, `$1${v}$3`))]);

  const lock = path.join(root, crate, "Cargo.lock");
  const lockText = fs.readFileSync(lock, "utf8");
  const entry = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"]+)(")`);
  targets.push([lock, lockText.match(entry)[2], (v) => fs.writeFileSync(lock, lockText.replace(entry, `$1${v}$3`))]);
}

let bad = false;
for (const [file, current, write] of targets) {
  if (current === version) continue;
  if (check) {
    console.error(`${rel(file)}: ${current}, expected ${version}`);
    bad = true;
  } else {
    write(version);
    console.log(`${rel(file)} -> ${version}`);
  }
}
if (bad) {
  console.error("run: node scripts/sync-versions.mjs");
  process.exit(1);
}
if (check) console.log(`all versions are ${version}`);
