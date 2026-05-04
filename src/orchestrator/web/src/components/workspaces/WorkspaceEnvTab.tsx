import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  ApiClientError,
  deleteEnvFile,
  getEnvFile,
  listEnvFiles,
  putEnvFile,
  resetEnvFile,
} from '@/lib/api-client'
import type { EnvFileMeta } from '@/lib/types'
import { formatBytes, formatRelativeTime } from '@/lib/format'

interface Props {
  workspaceId: string
}

interface EditorState {
  /** Server's last-known content (for dirty detection). */
  saved: string
  /** Current edit buffer. */
  buffer: string
  loading: boolean
}

export function WorkspaceEnvTab({ workspaceId }: Props): React.ReactElement {
  const [files, setFiles] = useState<EnvFileMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editors, setEditors] = useState<Record<string, EditorState>>({})

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const list = await listEnvFiles(workspaceId)
      setFiles(list)
      // Eagerly load each file so the editors render with content.
      // Workspaces typically have 3-5 small env files; the cost is fine.
      const next: Record<string, EditorState> = {}
      await Promise.all(
        list.map(async (f) => {
          try {
            const text = await getEnvFile(workspaceId, f.name)
            next[f.name] = { saved: text, buffer: text, loading: false }
          } catch (err) {
            next[f.name] = {
              saved: '',
              buffer: '',
              loading: false,
            }
            console.error(`Failed to load ${f.name}:`, err)
          }
        }),
      )
      setEditors(next)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function patchBuffer(name: string, buffer: string): void {
    setEditors((prev) => {
      const cur = prev[name]
      if (!cur) return prev
      return { ...prev, [name]: { ...cur, buffer } }
    })
  }

  async function save(name: string): Promise<void> {
    const cur = editors[name]
    if (!cur) return
    try {
      const updated = await putEnvFile(workspaceId, name, cur.buffer)
      setEditors((prev) => ({
        ...prev,
        [name]: { saved: updated, buffer: updated, loading: false },
      }))
      toast.success(`Saved ${name}`)
      // Refresh meta (size, modifiedAt) without reloading bodies.
      try {
        const list = await listEnvFiles(workspaceId)
        setFiles(list)
      } catch {
        // ignore
      }
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function reset(name: string): Promise<void> {
    try {
      const next = await resetEnvFile(workspaceId, name)
      setEditors((prev) => ({
        ...prev,
        [name]: { saved: next, buffer: next, loading: false },
      }))
      toast.success(`Reset ${name} to default`)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      await deleteEnvFile(workspaceId, name)
      toast.success(`Deleted ${name}`)
      await refresh()
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load env files</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (files === null) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="env-tab">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Markdown files concatenated alphabetically into the agent's system prompt at run-start.
        </p>
        <NewEnvFileButton workspaceId={workspaceId} onCreated={refresh} />
      </div>
      {files.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No env files. Create persona.md, soul.md, memory.md from the templates,
            or click "New env file".
          </CardContent>
        </Card>
      ) : (
        files.map((f) => {
          const ed = editors[f.name]
          const dirty = ed && ed.buffer !== ed.saved
          return (
            <Card key={f.name} data-testid={`env-card-${f.name}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className="font-mono">{f.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatBytes(f.size)} · modified {formatRelativeTime(f.modifiedAt)}
                  </span>
                  {dirty && (
                    <span className="text-xs text-amber-600">unsaved</span>
                  )}
                </CardTitle>
                {f.name === 'memory.md' && (
                  <CardDescription className="text-amber-700 dark:text-amber-400">
                    Agent-managed: the lead agent may rewrite this between sessions.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Textarea
                  value={ed?.buffer ?? ''}
                  onChange={(e) => patchBuffer(f.name, e.target.value)}
                  rows={Math.max(8, Math.min(20, (ed?.buffer ?? '').split('\n').length + 1))}
                  className="font-mono text-xs"
                  data-testid={`env-textarea-${f.name}`}
                  spellCheck={false}
                />
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => save(f.name)}
                    disabled={!dirty}
                    data-testid={`env-save-${f.name}`}
                  >
                    Save
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" data-testid={`env-reset-${f.name}`}>
                        <RefreshCw />
                        Reset to default
                      </Button>
                    }
                    title={`Reset ${f.name}?`}
                    body="Replaces the current content with the seed default. Unsaved edits are lost."
                    confirmLabel="Reset"
                    onConfirm={() => reset(f.name)}
                  />
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" data-testid={`env-delete-${f.name}`}>
                        <Trash2 />
                        Delete
                      </Button>
                    }
                    title={`Delete ${f.name}?`}
                    body="The agent will no longer read this file at run-start."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={() => remove(f.name)}
                  />
                </div>
              </CardContent>
            </Card>
          )
        })
      )}
    </div>
  )
}

function NewEnvFileButton({
  workspaceId,
  onCreated,
}: {
  workspaceId: string
  onCreated: () => void
}): React.ReactElement {
  const [name, setName] = useState('')
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" data-testid="new-env-file-button">
          <Plus />
          New env file
        </Button>
      }
      title="Create env file"
      body={
        <div className="flex flex-col gap-2">
          <p>Filename must end in <code>.md</code>.</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="extra-context.md"
            className="rounded-md border px-3 py-1.5 text-sm"
            data-testid="new-env-file-input"
          />
        </div>
      }
      confirmLabel="Create"
      onConfirm={async () => {
        if (!/\.md$/i.test(name)) {
          toast.error('Filename must end in .md')
          throw new Error('invalid name')
        }
        try {
          await putEnvFile(workspaceId, name, `# ${name}\n\n`)
          toast.success(`Created ${name}`)
          setName('')
          onCreated()
        } catch (err) {
          const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
          toast.error(msg)
          throw err
        }
      }}
    />
  )
}
