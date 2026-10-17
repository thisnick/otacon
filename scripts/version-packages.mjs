#!/usr/bin/env node
// `changeset version`, plus what changesets doesn't know about: the OpenClaw
// plugin's manifest carries its own version, which must match package.json.
// Run by the release workflow to build the "Version Packages" PR.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

run("pnpm", ["changeset", "version"]);

const dir = path.join(root, "src/openclaw-voice");
const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const manifestPath = path.join(dir, "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`openclaw.plugin.json -> ${version}`);
}

run("pnpm", ["install", "--lockfile-only"]);
