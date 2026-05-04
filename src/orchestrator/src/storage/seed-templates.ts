/**
 * Locate the on-disk seed-templates directory.
 *
 * Templates live in source at `src/orchestrator/scripts/seed-templates/`.
 * They are NOT compiled by tsc (markdown/yaml only); the build pipeline
 * copies the directory into the runtime image. At runtime we discover
 * the templates relative to this module's URL.
 *
 *   dev (tsx): /src/orchestrator/src/storage/seed-templates.ts
 *              → ../../scripts/seed-templates  ← exists
 *
 *   compiled:  /src/orchestrator/dist/src/storage/seed-templates.js
 *              → ../../../scripts/seed-templates  ← only if Dockerfile copies it
 *
 * `scripts/` is included in tsconfig's compile set so `seed.ts` itself
 * lands at `dist/scripts/seed.js`. We piggyback on that: the templates
 * directory is shipped next to the compiled `dist/scripts/` tree.
 *
 * Resolution: walk up from this file looking for the templates dir.
 * Tries the dev path first, then the compiled path. Throws if neither
 * exists — surfaces config errors loudly rather than silently seeding
 * an empty workspace.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | null = null

export function seedTemplatesRoot(): string {
  if (cached) return cached
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Candidates ordered from most-specific (production) to least:
  //   /app/src/orchestrator/dist/src/storage/seed-templates.js
  //     → /app/src/orchestrator/scripts/seed-templates  (5 ups)
  //   /repo/src/orchestrator/src/storage/seed-templates.ts
  //     → /repo/src/orchestrator/scripts/seed-templates (3 ups)
  //
  // Walk up to 6 levels looking for `<base>/scripts/seed-templates`.
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'scripts', 'seed-templates')
    try {
      if (fs.statSync(candidate).isDirectory()) {
        cached = candidate
        return candidate
      }
    } catch {
      // try next parent
    }
    dir = path.dirname(dir)
  }
  throw new Error(
    `seed-templates directory not found (started from ${here}); ` +
    `expected at <orchestrator-root>/scripts/seed-templates`,
  )
}
