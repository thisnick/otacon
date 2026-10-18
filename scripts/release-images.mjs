#!/usr/bin/env node
// The images a release builds: each one whose package's version has no
// <registry>/<image>:<version> tag yet (repo.mjs maps packages to images).
// Prints a JSON array for build.yml's matrix: [{ image, file, version }].
//
//   node scripts/release-images.mjs ghcr.io/thisnick/otacon
import { spawnSync } from "node:child_process";
import { images, workspacePackages } from "./repo.mjs";

const registry = process.argv[2];
if (!registry) {
  console.error("usage: release-images.mjs <registry/repo>");
  process.exit(2);
}
const versionOf = Object.fromEntries(workspacePackages().map((p) => [p.name, p.version]));

const build = [];
for (const { image, file, package: pkg } of images) {
  const version = versionOf[pkg];
  const ref = `${registry}/${image}:${version}`;
  const exists = spawnSync("docker", ["buildx", "imagetools", "inspect", ref], { stdio: "ignore" }).status === 0;
  console.error(`${ref}: ${exists ? "exists" : "to build"}`);
  if (!exists) build.push({ image, file, version });
}
console.log(JSON.stringify(build));
