#!/usr/bin/env node
// `changeset version` (all workspace packages move together, see the "fixed"
// group in .changeset/config.json), then the same version everywhere else:
// the repo root, the plugin manifest and the Rust crates
// (scripts/sync-versions.mjs). Run by the release workflow to build the
// "Version Packages" PR.
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

run("pnpm", ["changeset", "version"]);
run("node", ["scripts/sync-versions.mjs"]);
run("pnpm", ["install", "--lockfile-only"]);
