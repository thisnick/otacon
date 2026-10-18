#!/usr/bin/env node
// Run by release.yml before it builds the Version Packages PR. A package
// whose images' inputs changed since its last release, with no changeset that
// will bump it, gets a patch changeset, so a change that reaches an image is
// always released (and deployed) even if it was pushed without a changeset.
//
// An image's inputs are its Dockerfile and what it copies (repo.mjs).
// Edits that only move versions don't count: a `version` in package.json or
// the plugin manifest, a crate's own version in Cargo.toml / Cargo.lock, a
// CHANGELOG.md. For a package.json an image copies only for the lockfile
// (`lockfileOnly` in repo.mjs), only its dependencies count.
//
//   node scripts/auto-changesets.mjs [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { imageInputs, images, root, workspacePackages } from "./repo.mjs";

const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const packages = workspacePackages();
const byName = new Map(packages.map((p) => [p.name, p]));

// Package names the pending changesets bump.
const pending = new Set();
const csDir = path.join(root, ".changeset");
for (const f of fs.readdirSync(csDir)) {
  if (!f.endsWith(".md") || f === "README.md") continue;
  const front = fs.readFileSync(path.join(csDir, f), "utf8").match(/^---\n([\s\S]*?)\n---/);
  for (const m of front?.[1].matchAll(/^\s*["']?([^"':]+)["']?\s*:/gm) ?? []) pending.add(m[1].trim());
}

// Released anyway: a changeset names it, or one of its workspace
// dependencies (changesets bumps dependents too).
function covered(name, seen = new Set()) {
  if (pending.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const pkg = byName.get(name)?.pkg ?? {};
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => byName.has(d));
  return deps.some((d) => covered(d, seen));
}

const crateNames = ["otacon-server", "otacon-registry"];
const DEPENDENCY_FIELDS = ["name", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "pnpm"];
function withoutVersions(file, text, lockfileOnly) {
  const base = path.basename(file);
  if (lockfileOnly.has(file)) {
    const j = JSON.parse(text);
    return JSON.stringify(DEPENDENCY_FIELDS.map((k) => j[k]));
  }
  if (base === "CHANGELOG.md") return "";
  if (base === "package.json" || base === "openclaw.plugin.json") {
    const j = JSON.parse(text);
    delete j.version;
    return JSON.stringify(j);
  }
  if (base === "Cargo.toml") return text.replace(/^(\[package\][^[]*?)^version\s*=\s*"[^"]*"\n/ms, "$1");
  if (base === "Cargo.lock") {
    for (const n of crateNames) text = text.replace(new RegExp(`(\\[\\[package\\]\\]\\nname = "${n}"\\n)version = "[^"]*"\\n`), "$1");
    return text;
  }
  return text;
}

function realChange(base, file, lockfileOnly) {
  const before = spawnSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8" });
  const nowPath = path.join(root, file);
  if (before.status !== 0 || !fs.existsSync(nowPath)) return true; // added or removed
  return withoutVersions(file, before.stdout, lockfileOnly) !== withoutVersions(file, fs.readFileSync(nowPath, "utf8"), lockfileOnly);
}

const owners = [...new Set(images.map((i) => i.package))];
for (const name of owners) {
  const pkg = byName.get(name);
  if (covered(name)) {
    console.log(`${name}: a pending changeset releases it`);
    continue;
  }
  const base = `v${pkg.version}`;
  if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${base}`], { cwd: root }).status !== 0) {
    console.log(`${name}: no ${base} tag to compare with; skipping`);
    continue;
  }
  const own = images.filter((i) => i.package === name);
  const inputs = [...new Set(own.flatMap((i) => imageInputs(i.file)))];
  const lockfileOnly = new Set(own.flatMap((i) => i.lockfileOnly ?? []));
  const changed = git("diff", "--name-only", `${base}..HEAD`, "--", ...inputs).split("\n").filter(Boolean);
  const real = changed.filter((f) => realChange(base, f, lockfileOnly));
  if (!real.length) {
    console.log(`${name}: its images are unchanged since ${base}`);
    continue;
  }
  const shown = real.slice(0, 5).join(", ") + (real.length > 5 ? ` and ${real.length - 5} more` : "");
  const body = `---\n"${name}": patch\n---\n\nChanges since ${pkg.version} with no changeset of their own: ${shown}.\n`;
  const file = path.join(csDir, `auto-${name.replace(/[^a-z0-9-]/gi, "-")}.md`);
  console.log(`${name}: ${real.length} changed input(s) since ${base}; ${dryRun ? "would add" : "adding"} ${path.relative(root, file)}`);
  if (!dryRun) fs.writeFileSync(file, body);
}
