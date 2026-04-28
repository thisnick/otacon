import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export interface BlobStore {
  read(blobPath: string): Promise<Buffer | null>
  write(blobPath: string, data: Buffer | string): Promise<void>
  list(prefix: string): Promise<string[]>
  delete(blobPath: string): Promise<void>
  exists(blobPath: string): Promise<boolean>
}

export class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}

  private resolve(blobPath: string): string {
    const resolved = path.resolve(this.root, blobPath)
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`path traversal blocked: ${blobPath}`)
    }
    return resolved
  }

  async read(blobPath: string): Promise<Buffer | null> {
    const full = this.resolve(blobPath)
    try {
      return await fsp.readFile(full)
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async write(blobPath: string, data: Buffer | string): Promise<void> {
    const full = this.resolve(blobPath)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, data)
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix)
    try {
      // Check if the path is actually a directory
      const stat = await fsp.stat(dir)
      if (!stat.isDirectory()) return []
      const entries: string[] = await fsp.readdir(dir, { recursive: true }) as string[]
      const results: string[] = []
      for (const entry of entries) {
        const entryStr = String(entry)
        const full = path.join(dir, entryStr)
        const entryStat = await fsp.stat(full).catch(() => null)
        if (entryStat?.isFile()) {
          results.push(path.join(prefix, entryStr))
        }
      }
      return results.sort()
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
      throw e
    }
  }

  async delete(blobPath: string): Promise<void> {
    const full = this.resolve(blobPath)
    await fsp.rm(full, { force: true })
  }

  async exists(blobPath: string): Promise<boolean> {
    const full = this.resolve(blobPath)
    return fs.existsSync(full)
  }

  sub(prefix: string): LocalBlobStore {
    return new LocalBlobStore(path.join(this.root, prefix))
  }
}
