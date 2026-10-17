# Releasing

Versions are managed with [changesets](https://github.com/changesets/changesets).
Two workspace packages are published to npm under the `otacon-fleet` org:

| Package | Directory | What |
|---|---|---|
| `@otacon-fleet/otacon-cli` | `src/cli` | the `otacon` command-line client |
| `@otacon-fleet/openclaw-otacon-voice` | `src/openclaw-voice` | the OpenClaw phone-call plugin |

The other workspace packages are private and never published.

## Day to day

1. In a PR that changes a published package, add a changeset:
   `pnpm changeset` (pick the packages and patch/minor/major, write one line
   for the changelog). Commit the generated `.changeset/*.md`.
2. When it merges, `.github/workflows/release.yml` opens or updates a
   **Version Packages** PR: versions bumped, CHANGELOGs written, the plugin's
   `openclaw.plugin.json` version kept in sync (`scripts/version-packages.mjs`).
3. Merging the Version Packages PR publishes every package whose new version
   isn't on npm yet (`scripts/publish-packages.mjs`), with provenance, then tags
   `<name>@<version>` and creates a GitHub release for each.

Publishing uses npm **trusted publishing**: the workflow authenticates to npm
with GitHub's OIDC token, so no npm token is stored anywhere. Each package has
a trusted publisher on npmjs.com (package → Settings → Trusted Publisher →
GitHub Actions): user `thisnick`, repository `otacon`, workflow `release.yml`,
no environment.

Package releases don't build Docker images; `build-docker.yml` runs only for
the repo's own `v<version>` releases.

## A new package

Trusted publishing can't create a package, so a new package's first version is
published by hand by an `otacon-fleet` member, then its trusted publisher is
added as above:

```sh
pnpm --filter <name> run build
cd <dir> && npm publish --access public
```

Until then, the release workflow skips that package.
