#!/usr/bin/env node
// Publish every public workspace package whose version isn't on npm yet,
// then tag the new versions with `changeset tag`. Its "New tag: name@version"
// lines are what changesets/action reads to push tags and create GitHub
// releases.
//
// In CI this runs with npm trusted publishing (OIDC; npm >= 11.5.1), so no
// token is involved. `--dry-run` only reports what would be published.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");

const workspace = JSON.parse(execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }));
const packages = workspace
  .map((p) => ({ dir: p.path, pkg: JSON.parse(fs.readFileSync(path.join(p.path, "package.json"), "utf8")) }))
  .filter(({ pkg }) => !pkg.private && pkg.publishConfig);

function published(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { cwd: root, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === version;
}

function exists(name) {
  return spawnSync("npm", ["view", name, "name"], { cwd: root, encoding: "utf8" }).status === 0;
}

const ci = process.env.CI === "true";
let failed = false;
let publishedAny = false;
for (const { dir, pkg } of packages) {
  const id = `${pkg.name}@${pkg.version}`;
  if (published(pkg.name, pkg.version)) {
    console.log(`${id} is already on npm`);
    continue;
  }
  const workspaceDeps = Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies }).filter(([, v]) => String(v).startsWith("workspace:"));
  if (workspaceDeps.length) {
    console.error(`${id}: workspace: dependencies can't be published with npm (${workspaceDeps.map(([n]) => n).join(", ")})`);
    failed = true;
    continue;
  }
  // Trusted publishing can only publish new versions of a package that
  // exists: a package's first version is published by hand (see
  // docs/releasing.md), then its trusted publisher is set up on npmjs.com.
  if (ci && !exists(pkg.name)) {
    console.log(`${pkg.name} isn't on npm yet: publish its first version by hand (docs/releasing.md); skipping`);
    continue;
  }
  if (dryRun) {
    console.log(`would publish ${id} from ${path.relative(root, dir)}`);
    continue;
  }
  console.log(`publishing ${id}`);
  execFileSync("pnpm", ["--filter", pkg.name, "run", "build"], { cwd: root, stdio: "inherit" });
  const r = spawnSync("npm", ["publish", "--provenance", "--access", "public"], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`publishing ${id} failed`);
    failed = true;
  } else {
    publishedAny = true;
  }
}

// Tag (and so release on GitHub) only when something was published.
if (publishedAny) execFileSync("pnpm", ["changeset", "tag"], { cwd: root, stdio: "inherit" });
process.exit(failed ? 1 : 0);
