# Releasing

Everything in this repo shares one version and is released together. A
release `v<version>` is:

| What | Where |
|---|---|
| `@otacon-fleet/otacon-cli` (`src/cli`) | npm |
| `@otacon-fleet/openclaw-otacon-voice` (`src/openclaw-voice`) | npm |
| host server image (`Dockerfile.otacon`) | `ghcr.io/thisnick/otacon/otacon:<version>` |
| call audio image (`Dockerfile.voice`) | `ghcr.io/thisnick/otacon/voice:<version>` |
| registry image (`Dockerfile.registry`) | `ghcr.io/thisnick/otacon/registry:<version>` |
| orchestrator image (`Dockerfile.orchestrator`) | `ghcr.io/thisnick/otacon/orchestrator:<version>` |
| kiosk APK | asset on the `v<version>` GitHub release |

Images are linux/arm64 (the Pi and the orchestrator VPS). Once a release has
finished, each image's `:latest` points at it, and Watchtower on the hosts
deploys it within minutes.

## Day to day

1. In a PR, add a changeset: `pnpm changeset`. Pick the package the change
   is about (`otacon-server` for the host server, `otacon-registry`,
   `orchestrator`, the CLI or the plugin) and patch/minor/major, then write
   one line for the changelog. Commit the generated `.changeset/*.md`.
2. When it merges, `.github/workflows/release.yml` opens or updates a
   **Version Packages** PR. Every package moves to the same new version (a
   changesets "fixed" group), changelogs are written, and
   `scripts/sync-versions.mjs` copies the version to the repo root, the
   plugin manifest and the Rust crates.
3. Merging the Version Packages PR releases that version. On a push to main
   whose version has no `v<version>` tag yet, the workflow:
   1. builds every image (pushed as `<image>:<version>`) and the APK
      (`.github/workflows/build.yml`, on GitHub's ARM runners);
   2. publishes the npm packages that aren't on npm yet;
   3. creates the `v<version>` tag and GitHub release (notes from the
      changelogs, `scripts/release-notes.mjs`) with the APK;
   4. moves each image's `:latest` to the new version.

   Any failed step can be re-run from the Actions page; every step is safe
   to repeat.

`node scripts/sync-versions.mjs --check` (also run in CI) fails if any
version differs.

## Hosts

The Pi (`~/otacon`, `~/otacon-registry`) and the orchestrator VPS run
`ghcr.io/thisnick/${OTACON_REPO}/<image>:latest` with `OTACON_REPO=otacon`
in their `.env`, so releases deploy themselves.

For a dev build, `make push` / `make builder-build-otacon
BUILDER_OUTPUT=--push`, `make orchestrator-build` and
`scripts/deploy-registry.sh` push to `ghcr.io/thisnick/otacon-dev/...`
instead. To run one, set `OTACON_REPO=otacon-dev` on that host and
`docker compose up -d`; set it back to `otacon` to return to releases.

The kiosk APK inside the host image is installed on phones only when its
`versionCode` (`android/device-owner/app/build.gradle.kts`) changes. That
number is separate from the release version: bump it when the app changes.

## npm trusted publishing

The workflow authenticates to npm with GitHub's OIDC token, so no npm token is
stored anywhere. Each npm package has a trusted publisher on npmjs.com
(package → Settings → Trusted Publisher → GitHub Actions): user `thisnick`,
repository `otacon`, workflow `release.yml`, no environment.

Trusted publishing can't create a package, so a new npm package's first
version is published by hand by an `otacon-fleet` member, then its trusted
publisher is added as above:

```sh
pnpm --filter <name> run build
cd <dir> && npm publish --access public
```

Until then, the release workflow skips that package.

## Not in releases

`build-pigen.yml` (a Raspberry Pi OS image for provisioning a new host) runs
by hand only.
