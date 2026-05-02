/**
 * `read_file` / `write_file` Pi tools.
 *
 * Both go through the same `Bash` instance's filesystem so the path is
 * sandbox-rooted (validated by `ReadWriteFs.resolveAndValidate`). This
 * means agent paths are interpreted relative to `cwd` or as absolute
 * within the workspace root, NOT as raw OS paths. Future virtualization
 * (real ACL via MountableFs) just swaps the fs.
 */
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { Bash } from 'just-bash'

const ReadFileSchema = Type.Object({
  path: Type.String({ description: 'Path within the sandbox (relative or absolute).' }),
})

export function makeReadFileTool(bash: Bash): AgentTool<typeof ReadFileSchema, { path: string }> {
  return {
    name: 'read_file',
    label: 'Read file',
    description: 'Read a text file from the workspace sandbox.',
    parameters: ReadFileSchema,
    async execute(_id, { path }): Promise<AgentToolResult<{ path: string }>> {
      try {
        const text = await bash.readFile(path)
        return {
          content: [{ type: 'text', text }],
          details: { path },
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text', text: `read_file error: ${msg}` }],
          details: { path },
        }
      }
    },
  }
}

const WriteFileSchema = Type.Object({
  path: Type.String({ description: 'Path within the sandbox (relative or absolute).' }),
  content: Type.String({ description: 'New file content.' }),
})

export function makeWriteFileTool(bash: Bash): AgentTool<typeof WriteFileSchema, { path: string; bytes: number }> {
  return {
    name: 'write_file',
    label: 'Write file',
    description: 'Write text to a file in the workspace sandbox. Creates the file if absent; overwrites if present.',
    parameters: WriteFileSchema,
    async execute(_id, { path, content }): Promise<AgentToolResult<{ path: string; bytes: number }>> {
      try {
        await bash.writeFile(path, content)
        return {
          content: [{ type: 'text', text: `wrote ${content.length} bytes to ${path}` }],
          details: { path, bytes: content.length },
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text', text: `write_file error: ${msg}` }],
          details: { path, bytes: 0 },
        }
      }
    },
  }
}
