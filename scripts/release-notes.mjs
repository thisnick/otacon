#!/usr/bin/env node
// Notes for the v<version> GitHub release: every component's version (the
// ones this release changed in bold), then each changed package's
// CHANGELOG.md section for that version.
//
//   node scripts/release-notes.mjs 2.2.0 > notes.md
import fs from "node:fs";
import path from "node:path";
import { workspacePackages } from "./repo.mjs";

const version = process.argv[2];
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const packages = workspacePackages();

// Per package: [heading, lines] blocks of its section for this version.
const sections = [];
for (const { dir, name } of packages) {
  const file = path.join(dir, "CHANGELOG.md");
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) continue;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const blocks = [];
  for (const l of lines.slice(start + 1, end)) {
    // Internal dependency bumps ("Updated dependencies", "- pkg@1.2.3") say
    // nothing a reader needs.
    if (/^\s*- (Updated dependencies\b.*|\S+@\d\S*)$/.test(l)) continue;
    if (l.startsWith("### ")) blocks.push([l.slice(4), []]);
    else if (l.trim()) {
      if (!blocks.length) blocks.push(["Changes", []]);
      blocks.at(-1)[1].push(l);
    }
  }
  sections.push({ name, blocks });
}

// A bullet that several packages share is listed once.
const count = new Map();
for (const { blocks } of sections)
  for (const [, ls] of blocks) for (const l of ls) if (l.startsWith("- ")) count.set(l, (count.get(l) ?? 0) + 1);
const shared = [...count].filter(([, n]) => n > 1).map(([l]) => l);

const out = [
  "## Versions\n\n| Component | Version |\n|---|---|\n" +
    packages.map((p) => `| ${p.name} | ${p.version === version ? `**${p.version}** (this release)` : p.version} |`).join("\n"),
];
if (shared.length) out.push(`## All packages\n\n${shared.join("\n")}`);
for (const { name, blocks } of sections) {
  const kept = blocks
    .map(([h, ls]) => [h, ls.filter((l) => !shared.includes(l))])
    .filter(([, ls]) => ls.some((l) => l.trim()));
  if (kept.length) out.push(`## ${name}\n\n${kept.map(([h, ls]) => `### ${h}\n\n${ls.join("\n")}`).join("\n\n")}`);
}

console.log(out.join("\n\n"));
