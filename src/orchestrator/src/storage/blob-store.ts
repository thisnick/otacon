/**
 * BlobStore — generic byte storage rooted at the orchestrator data dir, plus
 * specialized helpers for run trace artifacts.
 *
 * This is the renamed successor to `LocalBlobStore` (in `blob.ts`). The
 * generic `read`/`write`/`list`/`delete`/`exists` API is preserved so
 * existing callers (sandbox FS adapter, conversation persistence) keep
 * working unchanged. New helpers handle the trace dir layout that the
 * plan describes (Phase 2).
 *
 * On disk:
 *   <root>/<arbitrary blob path>          — generic put/get
 *   <root>/runs/{runId}/traces/{tcid}/{kind}.png   — screenshots
 *   <root>/runs/{runId}/traces/{tcid}/result.json  — bash result
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { PathLayout } from './paths.js'
import { runTraceDir, runTraceFile } from './paths.js'

export type ScreenshotKind = 'before' | 'annotated' | 'after'

export interface BlobStore {
  // Generic byte ops (kept for compat with sandbox FS adapter etc.)
  read(blobPath: string): Promise<Buffer | null>
  write(blobPath: string, data: Buffer | string): Promise<void>
  list(prefix: string): Promise<string[]>
  delete(blobPath: string): Promise<void>
  exists(blobPath: string): Promise<boolean>

  // Specialized helpers — what new callers should reach for.
  putScreenshot(runId: string, toolCallId: string, kind: ScreenshotKind, bytes: Buffer): Promise<string>
  getScreenshot(runId: string, toolCallId: string, kind: ScreenshotKind): Promise<Buffer | null>
  putToolResult(runId: string, toolCallId: string, result: unknown): Promise<string>
  getToolResult(runId: string, toolCallId: string): Promise<unknown | null>

  /** Absolute root for callers (e.g. sandbox env vars) that need a path. */
  readonly root: string
  /** Resolve a relative blob path to an absolute filesystem path. */
  toAbsolute(blobPath: string): string
  /** Return a sub-store rooted at `<root>/<prefix>`. */
  sub(prefix: string): BlobStore
}

export class BlobStoreFs implements BlobStore {
  readonly root: string

  /**
   * Construct a blob store rooted at `root`.
   *
   * `layout` is optional because some callers (sandbox FS adapter) need a
   * scoped sub-store rooted at e.g. `accounts/{id}/workspace`. When `layout`
   * is provided the run-trace helpers (`putScreenshot`, `getScreenshot`,
   * `putToolResult`, `getToolResult`) can compute their absolute paths via
   * `paths.ts` constants.
   *
   * Calling a trace helper on a layout-less instance throws:
   *   `BlobStoreFs.{method}() requires a PathLayout — construct via
   *    factory.makeStores() or pass layout into the constructor.`
   *
   * Generic ops (`read`/`write`/`list`/`delete`/`exists`) work with or
   * without a layout. The factory builds the main store with `layout`;
   * sub-stores created via `.sub(prefix)` inherit the same `layout`
   * reference even though they're rooted lower.
   */
  constructor(root: string, private layout?: PathLayout) {
    this.root = path.resolve(root)
  }

  toAbsolute(blobPath: string): string {
    const resolved = path.resolve(this.root, blobPath)
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`path traversal blocked: ${blobPath}`)
    }
    return resolved
  }

  async read(blobPath: string): Promise<Buffer | null> {
    const full = this.toAbsolute(blobPath)
    try {
      return await fsp.readFile(full)
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async write(blobPath: string, data: Buffer | string): Promise<void> {
    const full = this.toAbsolute(blobPath)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, data)
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.toAbsolute(prefix)
    try {
      const stat = await fsp.stat(dir)
      if (!stat.isDirectory()) return []
      const entries: string[] = (await fsp.readdir(dir, { recursive: true })) as string[]
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
    await fsp.rm(this.toAbsolute(blobPath), { force: true })
  }

  async exists(blobPath: string): Promise<boolean> {
    return fs.existsSync(this.toAbsolute(blobPath))
  }

  sub(prefix: string): BlobStore {
    return new BlobStoreFs(path.join(this.root, prefix), this.layout)
  }

  async putScreenshot(
    runId: string,
    toolCallId: string,
    kind: ScreenshotKind,
    bytes: Buffer,
  ): Promise<string> {
    const layout = this.requireLayout('putScreenshot')
    const dir = runTraceDir(layout, runId, toolCallId)
    await fsp.mkdir(dir, { recursive: true })
    const file = runTraceFile(layout, runId, toolCallId, `${kind}.png`)
    await fsp.writeFile(file, bytes)
    return path.relative(layout.root, file)
  }

  async getScreenshot(
    runId: string,
    toolCallId: string,
    kind: ScreenshotKind,
  ): Promise<Buffer | null> {
    const layout = this.requireLayout('getScreenshot')
    try {
      return await fsp.readFile(runTraceFile(layout, runId, toolCallId, `${kind}.png`))
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async putToolResult(runId: string, toolCallId: string, result: unknown): Promise<string> {
    const layout = this.requireLayout('putToolResult')
    const dir = runTraceDir(layout, runId, toolCallId)
    await fsp.mkdir(dir, { recursive: true })
    const file = runTraceFile(layout, runId, toolCallId, 'result.json')
    await fsp.writeFile(file, JSON.stringify(result, null, 2), 'utf-8')
    return path.relative(layout.root, file)
  }

  async getToolResult(runId: string, toolCallId: string): Promise<unknown | null> {
    const layout = this.requireLayout('getToolResult')
    try {
      const raw = await fsp.readFile(runTraceFile(layout, runId, toolCallId, 'result.json'), 'utf-8')
      return JSON.parse(raw)
    } catch (e: any) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  private requireLayout(method: string): PathLayout {
    if (!this.layout) {
      throw new Error(
        `BlobStoreFs.${method}() requires a PathLayout — construct via factory.makeStores() or pass layout into the constructor.`,
      )
    }
    return this.layout
  }
}
