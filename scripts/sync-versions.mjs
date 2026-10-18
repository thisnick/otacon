#!/usr/bin/env node
// Versions in this repo share one number line (docs/releasing.md): the
// workspace packages are a changesets "linked" group, so a package moves only
// when it changes, and then to the group's next version. This keeps in step
// the places changesets doesn't know about:
//   - the repo root: the group's highest version (its v<version> tag is the
//     release)
//   - the plugin manifest: the plugin's version
//   - the Rust crates (src/server, src/registry): their package's version
//
//   node scripts/sync-versions.mjs           write them
//   node scripts/sync-versions.mjs --check   fail if anything is out of step
import fs from "node:fs";
import path from "node:path";
import { highestVersion, linkedGroup, rel, root, workspacePackages } from "./repo.mjs";

const check = process.argv.includes("--check");

const packages = workspacePackages();
const group = linkedGroup();
const names = packages.map((p) => p.name);
const problems = [];
for (const n of names) if (!group.includes(n)) problems.push(`${n} is a workspace package but not in .changeset/config.json "linked"`);
for (const n of group) if (!names.includes(n)) problems.push(`"linked" lists ${n}, which isn't a workspace package`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const versionOf = Object.fromEntries(packages.map((p) => [p.name, p.version]));

// [file, current version, wanted version, write(version)]
const targets = [];

function jsonVersion(file, wanted) {
  const text = fs.readFileSync(file, "utf8");
  const current = JSON.parse(text).version;
  targets.push([file, current, wanted, (v) => fs.writeFileSync(file, text.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`))]);
}
jsonVersion(path.join(root, "package.json"), highestVersion(Object.values(versionOf)));
jsonVersion(path.join(root, "src/openclaw-voice/openclaw.plugin.json"), versionOf["@otacon-fleet/openclaw-otacon-voice"]);

for (const [crate, pkgName] of [
  ["src/server", "otacon-server"],
  ["src/registry", "otacon-registry"],
]) {
  const wanted = versionOf[pkgName];
  const toml = path.join(root, crate, "Cargo.toml");
  const text = fs.readFileSync(toml, "utf8");
  const name = text.match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)[1];
  const pkgVersion = /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/ms;
  targets.push([toml, text.match(pkgVersion)[2], wanted, (v) => fs.writeFileSync(toml, text.replace(pkgVersion, `$1${v}$3`))]);

  const lock = path.join(root, crate, "Cargo.lock");
  const lockText = fs.readFileSync(lock, "utf8");
  const entry = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"]+)(")`);
  targets.push([lock, lockText.match(entry)[2], wanted, (v) => fs.writeFileSync(lock, lockText.replace(entry, `$1${v}$3`))]);
}

let bad = false;
for (const [file, current, wanted, write] of targets) {
  if (current === wanted) continue;
  if (check) {
    console.error(`${rel(file)}: ${current}, expected ${wanted}`);
    bad = true;
  } else {
    write(wanted);
    console.log(`${rel(file)} -> ${wanted}`);
  }
}
if (bad) {
  console.error("run: node scripts/sync-versions.mjs");
  process.exit(1);
}
if (check) console.log(`versions in step (${packages.map((p) => `${p.name} ${p.version}`).join(", ")})`);
