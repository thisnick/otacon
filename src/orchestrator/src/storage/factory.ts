/**
 * Factory for the FS-backed storage layer. Single entrypoint that callers
 * use during bootstrap to materialize all stores rooted at one data dir.
 */
import * as fs from 'node:fs/promises'
import { AccountStoreFs, type AccountStore } from './account-store.js'
import { BlobStoreFs, type BlobStore } from './blob-store.js'
import { IndexStoreFs, type IndexStore } from './index-store.js'
import { makePaths, type PathLayout } from './paths.js'
import { RunStoreFs, type RunStore } from './run-store.js'
import { SignalStoreFs, type SignalStore } from './signal-store.js'
import { TeamStoreFs, type TeamStore } from './team-store.js'

export interface Stores {
  layout: PathLayout
  accountStore: AccountStore
  teamStore: TeamStore
  runStore: RunStore
  blobStore: BlobStore
  signalStore: SignalStore
  indexStore: IndexStore
}

export interface MakeStoresOpts {
  dataDir: string
  /**
   * If true, mkdir the top-level data dir on construction. Defaults to true;
   * disable for read-only test setups.
   */
  ensureDir?: boolean
}

export async function makeStores(opts: MakeStoresOpts): Promise<Stores> {
  const layout = makePaths(opts.dataDir)
  if (opts.ensureDir !== false) {
    await fs.mkdir(layout.root, { recursive: true })
    await fs.mkdir(layout.accountsDir, { recursive: true })
    await fs.mkdir(layout.teamsDir, { recursive: true })
    await fs.mkdir(layout.runsDir, { recursive: true })
    await fs.mkdir(layout.indexDir, { recursive: true })
  }

  const indexStore = new IndexStoreFs(layout)
  const runStore = new RunStoreFs(layout, indexStore)
  const accountStore = new AccountStoreFs(layout)
  const teamStore = new TeamStoreFs(layout)
  const signalStore = new SignalStoreFs(layout)
  const blobStore = new BlobStoreFs(layout.root, layout)

  return { layout, accountStore, teamStore, runStore, blobStore, signalStore, indexStore }
}
