# Releasing

Every component in this repo is versioned on one number line. A component
gets a new version only when it changes, and then it takes the next version
of the whole repo; components released together get the same version. So a
component's version names the release that last changed it, and
`v<version>`, the repo's latest release, is the highest version of them all.

| Package (`.changeset`) | Released as |
|---|---|
| `@otacon-fleet/otacon-cli` (`src/cli`) | npm |
| `@otacon-fleet/openclaw-otacon-voice` (`src/openclaw-voice`) | npm |
| `otacon-server` (`src/server`) | images `ghcr.io/thisnick/otacon/otacon` (`Dockerfile.otacon`, with the kiosk APK) and `.../voice` (`Dockerfile.voice`, modem and eSIM tools) |
| `otacon-registry` (`src/registry`) | image `.../registry` (`Dockerfile.registry`) |
| `orchestrator` (`src/orchestrator`) | image `.../orchestrator` (`Dockerfile.orchestrator`) |
| `orchestrator-web` (`src/orchestrator/web`) | part of the orchestrator image |

Images are linux/arm64 (the Pi and the orchestrator VPS) and are tagged with
their package's version. A release builds only the images whose package
moved, and moves only their `:latest`. Watchtower on the hosts deploys a new
`:latest` within minutes, so a container restarts only when its image
changed. The image–package map lives in `scripts/repo.mjs`.

For example, from everything at 2.1.0: a plugin fix releases v2.1.1 (only
the plugin moves, to 2.1.1; nothing on the Pi restarts). A server change after
it releases v2.2.0 (the server moves to 2.2.0, from the highest version; the
`otacon` and `voice` containers restart). A CLI change then moves the CLI and
the orchestrator, which bundles it, to the next version.

## Day to day

1. In a PR, add a changeset: `pnpm changeset`. Pick the package the change is
   about and patch/minor/major, then write one line for the changelog.
   Commit the generated `.changeset/*.md`. Dependents move too: a CLI
   changeset also releases the orchestrator.
2. When it merges, `.github/workflows/release.yml` opens or updates a
   **Version Packages** PR: new versions for the packages with changesets
   (a changesets "linked" group), changelogs, and `scripts/sync-versions.mjs`
   for what changesets doesn't know about. That's the repo root (the highest
   version), the plugin manifest and the Rust crates (their package's
   version).

   A change that reaches an image without a changeset still gets released:
   before building the PR, `scripts/auto-changesets.mjs` adds a patch
   changeset for any package whose images' inputs changed since its last
   release. The inputs are the Dockerfile and what it copies; edits that only
   move a version or a changelog don't count.
3. Merging the Version Packages PR releases it. On a push to main whose root
   version has no `v<version>` tag yet, the workflow:
   1. builds each image whose package version has no image tag yet, pushed
      as `<image>:<version>` (`.github/workflows/build.yml`, on GitHub's ARM
      runners), plus the APK with the otacon image;
   2. publishes the npm packages whose version isn't on npm yet;
   3. creates the `v<version>` tag and GitHub release, with every
      component's version, the changelogs (`scripts/release-notes.mjs`) and
      the APK when it was built;
   4. moves `:latest` of the images it built.

   Any failed step can be re-run from the Actions page; every step is safe
   to repeat.

`node scripts/sync-versions.mjs --check` (also run in CI) fails if a version
is out of step.

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
