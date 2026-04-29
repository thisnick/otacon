/**
 * TeamStore: read team configuration + prompt files from the data dir.
 *
 * On disk:
 *   teams/{name}/team.json           — TeamConfig
 *   teams/{name}/prompts/{relPath}   — markdown prompt files referenced by promptFile
 *
 * Read-only for the runtime. Bootstrapping (copying the in-tree
 * `social-media-engagement` team into the data dir) happens at startup.
 */
import * as fs from 'node:fs/promises'
import type { PathLayout } from './paths.js'
import { teamDir, teamFile, teamPromptFile } from './paths.js'
import type { TeamConfig, TeamMeta } from './types.js'

export interface TeamStore {
  list(): Promise<TeamMeta[]>
  get(name: string): Promise<TeamConfig | null>
  readPromptFile(teamName: string, relPath: string): Promise<string | null>
  has(name: string): Promise<boolean>
}

export class TeamStoreFs implements TeamStore {
  constructor(private layout: PathLayout) {}

  async list(): Promise<TeamMeta[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.layout.teamsDir, { withFileTypes: true })
    } catch (e: any) {
      if (e.code === 'ENOENT') return []
      throw e
    }
    const out: TeamMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const cfg = await this.get(entry.name)
      if (cfg) out.push({ name: cfg.name, description: cfg.description, lead: cfg.lead })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  async get(name: string): Promise<TeamConfig | null> {
    try {
      const raw = await fs.readFile(teamFile(this.layout, name), 'utf-8')
      return JSON.parse(raw) as TeamConfig
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async has(name: string): Promise<boolean> {
    try {
      await fs.access(teamFile(this.layout, name))
      return true
    } catch {
      return false
    }
  }

  async readPromptFile(teamName: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(teamPromptFile(this.layout, teamName, relPath), 'utf-8')
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  /**
   * Helper: resolve the directory for a team — useful for bootstrapping
   * when the runtime needs to seed the data dir.
   */
  dirFor(name: string): string {
    return teamDir(this.layout, name)
  }
}
