#!/usr/bin/env node
// Notes for the v<version> GitHub release: each workspace package's
// CHANGELOG.md section for that version, under the package's name. Packages
// with nothing for it are left out.
//
//   node scripts/release-notes.mjs 2.0.1 > notes.md
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const workspaceYaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const dirs = [];
for (const line of workspaceYaml.slice(workspaceYaml.indexOf("packages:")).split("\n").slice(1)) {
  const m = line.match(/^\s+-\s+(\S+)/);
  if (!m) break;
  dirs.push(m[1]);
}

// Per package: [heading, lines] blocks of its section for this version.
const packages = [];
for (const dir of dirs) {
  const file = path.join(root, dir, "CHANGELOG.md");
  if (!fs.existsSync(file)) continue;
  const { name } = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8"));
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) continue;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const blocks = [];
  for (const l of lines.slice(start + 1, end)) {
    // Internal dependency bumps ("Updated dependencies", "- pkg@1.2.3"): with
    // one version for everything they say nothing.
    if (/^\s*- (Updated dependencies\b.*|\S+@\d\S*)$/.test(l)) continue;
    if (l.startsWith("### ")) blocks.push([l.slice(4), []]);
    else if (l.trim()) {
      if (!blocks.length) blocks.push(["Changes", []]);
      blocks.at(-1)[1].push(l);
    }
  }
  packages.push({ name, blocks });
}

// A bullet that several packages share (a fixed-group change) is listed once.
const count = new Map();
for (const { blocks } of packages)
  for (const [, ls] of blocks) for (const l of ls) if (l.startsWith("- ")) count.set(l, (count.get(l) ?? 0) + 1);
const shared = [...count].filter(([, n]) => n > 1).map(([l]) => l);

const out = [];
if (shared.length) out.push(`## All packages\n\n${shared.join("\n")}`);
for (const { name, blocks } of packages) {
  const kept = blocks
    .map(([h, ls]) => [h, ls.filter((l) => !shared.includes(l))])
    .filter(([, ls]) => ls.some((l) => l.trim()));
  if (kept.length) out.push(`## ${name}\n\n${kept.map(([h, ls]) => `### ${h}\n\n${ls.join("\n")}`).join("\n\n")}`);
}

console.log(out.length ? out.join("\n\n") : `Release ${version}.`);
