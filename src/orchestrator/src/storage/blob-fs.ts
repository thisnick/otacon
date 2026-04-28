/**
 * BlobBackedFs: wraps a BlobStore to implement just-bash's IFileSystem interface.
 * Used to mount account workspace/config as virtual directories in the sandbox.
 */
import type {
  IFileSystem,
  FsStat,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
} from 'just-bash'
import type { BlobStore } from './blob.js'
import * as posixPath from 'node:path/posix'

export class BlobBackedFs implements IFileSystem {
  constructor(
    private store: BlobStore,
    private prefix: string = '',
  ) {}

  private toBlob(virtualPath: string): string {
    const clean = virtualPath.startsWith('/') ? virtualPath.slice(1) : virtualPath
    return this.prefix ? posixPath.join(this.prefix, clean) : clean
  }

  // Track directories implicitly created via writes
  private knownDirs = new Set<string>()

  async readFile(path: string, _options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const data = await this.store.read(this.toBlob(path))
    if (data === null) throw this.enoent(path)
    return data.toString('utf-8')
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const data = await this.store.read(this.toBlob(path))
    if (data === null) throw this.enoent(path)
    return new Uint8Array(data)
  }

  async writeFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const data = typeof content === 'string' ? content : Buffer.from(content)
    await this.store.write(this.toBlob(path), data)
    // Track parent directories
    this.trackParentDirs(path)
  }

  async appendFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const existing = await this.store.read(this.toBlob(path))
    const append = typeof content === 'string' ? content : Buffer.from(content).toString('utf-8')
    const newContent = (existing?.toString('utf-8') ?? '') + append
    await this.store.write(this.toBlob(path), newContent)
    this.trackParentDirs(path)
  }

  async exists(path: string): Promise<boolean> {
    const clean = path.startsWith('/') ? path.slice(1) : path
    if (clean === '' || this.knownDirs.has(clean)) return true
    return this.store.exists(this.toBlob(path))
  }

  async stat(path: string): Promise<FsStat> {
    const clean = path.startsWith('/') ? path.slice(1) : path
    if (clean === '' || this.knownDirs.has(clean)) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() }
    }
    const blobPath = this.toBlob(path)
    // Check if it exists as a file first
    const data = await this.store.read(blobPath)
    if (data !== null) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: data.length, mtime: new Date() }
    }
    // Check if any blob exists with this as prefix (directory)
    const files = await this.store.list(blobPath)
    if (files.length > 0) {
      this.knownDirs.add(clean)
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() }
    }
    throw this.enoent(path)
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path)
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    const clean = path.startsWith('/') ? path.slice(1) : path
    this.knownDirs.add(clean)
    this.trackParentDirs(path)
  }

  async readdir(path: string): Promise<string[]> {
    const blobPath = this.toBlob(path)
    const allFiles = await this.store.list(blobPath)
    const entries = new Set<string>()
    const prefixLen = blobPath.length > 0 ? blobPath.length + 1 : 0
    for (const f of allFiles) {
      const relative = f.slice(prefixLen)
      if (!relative) continue
      const firstSegment = relative.split('/')[0]
      entries.add(firstSegment)
    }
    // Also include known subdirs
    const cleanPath = path.startsWith('/') ? path.slice(1) : path
    for (const dir of this.knownDirs) {
      if (cleanPath === '') {
        const first = dir.split('/')[0]
        entries.add(first)
      } else if (dir.startsWith(cleanPath + '/')) {
        const rest = dir.slice(cleanPath.length + 1)
        const first = rest.split('/')[0]
        if (first) entries.add(first)
      }
    }
    return [...entries].sort()
  }

  async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const names = await this.readdir(path)
    const results: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] = []
    for (const name of names) {
      const full = path === '/' ? `/${name}` : `${path}/${name}`
      const st = await this.stat(full).catch(() => null)
      results.push({
        name,
        isFile: st?.isFile ?? false,
        isDirectory: st?.isDirectory ?? true,
        isSymbolicLink: false,
      })
    }
    return results
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    await this.store.delete(this.toBlob(path))
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const data = await this.store.read(this.toBlob(src))
    if (data === null) throw this.enoent(src)
    await this.store.write(this.toBlob(dest), data)
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest)
    await this.rm(src)
  }

  resolvePath(base: string, p: string): string {
    if (p.startsWith('/')) return posixPath.normalize(p)
    return posixPath.normalize(posixPath.join(base, p))
  }

  getAllPaths(): string[] {
    return []
  }

  async chmod(_path: string, _mode: number): Promise<void> {}

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw Object.assign(new Error('symlinks not supported on blob FS'), { code: 'EPERM' })
  }

  async link(_existing: string, _newPath: string): Promise<void> {
    throw Object.assign(new Error('hard links not supported on blob FS'), { code: 'EPERM' })
  }

  async readlink(_path: string): Promise<string> {
    throw Object.assign(new Error('no symlinks on blob FS'), { code: 'EINVAL' })
  }

  async realpath(path: string): Promise<string> {
    return posixPath.normalize(path.startsWith('/') ? path : `/${path}`)
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}

  private enoent(path: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' })
  }

  private trackParentDirs(filePath: string): void {
    const clean = filePath.startsWith('/') ? filePath.slice(1) : filePath
    const parts = clean.split('/')
    for (let i = 1; i < parts.length; i++) {
      this.knownDirs.add(parts.slice(0, i).join('/'))
    }
  }
}
