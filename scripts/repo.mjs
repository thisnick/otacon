// What the release scripts share: the workspace packages, the changesets
// group they're versioned in, and which images each package is released as.
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const rel = (p) => path.relative(root, p);

/** The workspace packages (the `packages:` list of pnpm-workspace.yaml). */
export function workspacePackages() {
  const yaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const out = [];
  for (const line of yaml.slice(yaml.indexOf("packages:")).split("\n").slice(1)) {
    const m = line.match(/^\s+-\s+(\S+)/);
    if (!m) break;
    const dir = path.join(root, m[1]);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    out.push({ dir, name: pkg.name, version: pkg.version, pkg });
  }
  return out;
}

/** The changesets "linked" group every workspace package belongs to. */
export function linkedGroup() {
  return JSON.parse(fs.readFileSync(path.join(root, ".changeset/config.json"), "utf8")).linked[0];
}

/**
 * The images each package is released as. An image is built when its
 * package's version has no image tag yet, and tagged with that version.
 */
export const images = [
  { image: "otacon", file: "Dockerfile.otacon", package: "otacon-server" },
  { image: "voice", file: "Dockerfile.voice", package: "otacon-server" },
  { image: "registry", file: "Dockerfile.registry", package: "otacon-registry" },
  {
    image: "orchestrator",
    file: "Dockerfile.orchestrator",
    package: "orchestrator",
    // Copied only so `pnpm install --frozen-lockfile` sees the whole
    // workspace: only their dependencies can change the image.
    lockfileOnly: ["package.json", "src/openclaw-voice/package.json", "src/server/package.json", "src/registry/package.json"],
  },
];

/** The repo paths an image is built from: its Dockerfile and what it COPYs/ADDs. */
export function imageInputs(dockerfile) {
  const inputs = new Set([dockerfile]);
  const text = fs.readFileSync(path.join(root, dockerfile), "utf8").replace(/\\\n/g, " ");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
    if (!m) continue;
    const args = m[2].trim().split(/\s+/);
    if (args.some((a) => a.startsWith("--from="))) continue;
    const paths = args.filter((a) => !a.startsWith("--"));
    for (const src of paths.slice(0, -1)) {
      if (/^[a-z]+:\/\//i.test(src)) continue; // ADD <url>
      inputs.add(src.replace(/^\.\//, "").replace(/\/$/, ""));
    }
  }
  return [...inputs];
}

function parse(v) {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

/** a > b for plain x.y.z versions */
export function versionGt(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function highestVersion(versions) {
  return versions.reduce((hi, v) => (hi === undefined || versionGt(v, hi) ? v : hi), undefined);
}
