import { useCallback, useEffect, useState } from 'react'
import { Plus, RotateCcw, Trash2, Crown } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  ApiClientError,
  getTeamPrompt,
  patchTeam,
  putTeamPrompt,
  resetTeamPrompt,
} from '@/lib/api-client'
import type { Team, TeamAgent } from '@/lib/types'

interface Props {
  team: Team
  onUpdated: (next: Team) => void
}

interface AgentEditorState {
  /** Agent fields the user is currently editing. */
  buffer: { model: string; prompt: string }
  saved: { model: string; prompt: string }
  loading: boolean
}

export function TeamAgentsTab({ team, onUpdated }: Props): React.ReactElement {
  const [editors, setEditors] = useState<Record<string, AgentEditorState>>({})

  const loadAll = useCallback(async () => {
    const next: Record<string, AgentEditorState> = {}
    await Promise.all(
      team.agents.map(async (a) => {
        try {
          const prompt = await getTeamPrompt(team.name, a.role)
          next[a.role] = {
            buffer: { model: a.model, prompt },
            saved: { model: a.model, prompt },
            loading: false,
          }
        } catch (err) {
          next[a.role] = {
            buffer: { model: a.model, prompt: '' },
            saved: { model: a.model, prompt: '' },
            loading: false,
          }
          console.error(`Failed to load prompt for ${a.role}:`, err)
        }
      }),
    )
    setEditors(next)
  }, [team])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  function patchBuffer(role: string, patch: Partial<AgentEditorState['buffer']>): void {
    setEditors((prev) => {
      const cur = prev[role]
      if (!cur) return prev
      return { ...prev, [role]: { ...cur, buffer: { ...cur.buffer, ...patch } } }
    })
  }

  async function save(role: string): Promise<void> {
    const ed = editors[role]
    if (!ed) return
    try {
      // Save model via PATCH on the team (server creates/keeps prompt files
      // when the agents array changes).
      const wantModelChange = ed.buffer.model !== ed.saved.model
      const wantPromptChange = ed.buffer.prompt !== ed.saved.prompt
      if (wantModelChange) {
        const nextAgents = team.agents.map((a) =>
          a.role === role ? { role: a.role, model: ed.buffer.model } : { role: a.role, model: a.model },
        )
        const next = await patchTeam(team.name, { agents: nextAgents })
        onUpdated(next)
      }
      if (wantPromptChange) {
        const updated = await putTeamPrompt(team.name, role, ed.buffer.prompt)
        setEditors((prev) => {
          const cur = prev[role]
          if (!cur) return prev
          return {
            ...prev,
            [role]: {
              ...cur,
              buffer: { model: cur.buffer.model, prompt: updated },
              saved: { model: cur.buffer.model, prompt: updated },
            },
          }
        })
      } else if (wantModelChange) {
        // Sync saved model field even if prompt didn't change.
        setEditors((prev) => {
          const cur = prev[role]
          if (!cur) return prev
          return {
            ...prev,
            [role]: { ...cur, saved: { ...cur.saved, model: ed.buffer.model } },
          }
        })
      }
      toast.success(`Saved ${role}`)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function resetPrompt(role: string): Promise<void> {
    try {
      const updated = await resetTeamPrompt(team.name, role)
      setEditors((prev) => {
        const cur = prev[role]
        if (!cur) return prev
        return {
          ...prev,
          [role]: {
            ...cur,
            buffer: { ...cur.buffer, prompt: updated },
            saved: { ...cur.saved, prompt: updated },
          },
        }
      })
      toast.success(`Reset ${role} prompt to default`)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function removeAgent(role: string): Promise<void> {
    try {
      const nextAgents = team.agents
        .filter((a) => a.role !== role)
        .map((a) => ({ role: a.role, model: a.model }))
      const next = await patchTeam(team.name, { agents: nextAgents })
      toast.success(`Removed ${role}`)
      onUpdated(next)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="agents-tab">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Each agent has a role, a model, and a markdown prompt loaded into the system message.
        </p>
        <AddAgentButton team={team} onAdded={onUpdated} />
      </div>

      {team.agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No agents on this team yet. Click "Add agent" to create one.
          </CardContent>
        </Card>
      ) : (
        team.agents.map((a) => {
          const ed = editors[a.role]
          return (
            <AgentCard
              key={a.role}
              agent={a}
              isLead={team.lead === a.role}
              ed={ed}
              onModelChange={(v) => patchBuffer(a.role, { model: v })}
              onPromptChange={(v) => patchBuffer(a.role, { prompt: v })}
              onSave={() => save(a.role)}
              onReset={() => resetPrompt(a.role)}
              onRemove={() => removeAgent(a.role)}
            />
          )
        })
      )}
    </div>
  )
}

function AgentCard({
  agent,
  isLead,
  ed,
  onModelChange,
  onPromptChange,
  onSave,
  onReset,
  onRemove,
}: {
  agent: TeamAgent
  isLead: boolean
  ed: AgentEditorState | undefined
  onModelChange: (v: string) => void
  onPromptChange: (v: string) => void
  onSave: () => void
  onReset: () => void
  onRemove: () => void
}): React.ReactElement {
  if (!ed) {
    return (
      <Card>
        <CardContent className="py-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    )
  }
  const dirty =
    ed.buffer.model !== ed.saved.model || ed.buffer.prompt !== ed.saved.prompt
  return (
    <Card data-testid={`agent-card-${agent.role}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="font-mono">{agent.role}</span>
          {isLead && (
            <Badge variant="secondary" className="text-amber-700 dark:text-amber-400">
              <Crown className="size-3" /> lead
            </Badge>
          )}
          {dirty && <span className="text-xs text-amber-600">unsaved</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Model</span>
          <Input
            value={ed.buffer.model}
            onChange={(e) => onModelChange(e.target.value)}
            className="font-mono text-xs"
            data-testid={`agent-model-${agent.role}`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Prompt (prompts/{agent.promptFile})</span>
          <Textarea
            value={ed.buffer.prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            rows={Math.max(8, Math.min(20, ed.buffer.prompt.split('\n').length + 1))}
            className="font-mono text-xs"
            data-testid={`agent-prompt-${agent.role}`}
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={onSave}
            disabled={!dirty}
            data-testid={`agent-save-${agent.role}`}
          >
            Save
          </Button>
          <ConfirmDialog
            trigger={
              <Button variant="outline" data-testid={`agent-reset-${agent.role}`}>
                <RotateCcw />
                Reset prompt
              </Button>
            }
            title={`Reset ${agent.role} prompt?`}
            body="Replaces the current prompt with the seed default. Unsaved edits are lost."
            confirmLabel="Reset"
            onConfirm={onReset}
          />
          <ConfirmDialog
            trigger={
              <Button variant="ghost" data-testid={`agent-remove-${agent.role}`}>
                <Trash2 />
                Remove agent
              </Button>
            }
            title={`Remove ${agent.role}?`}
            body="Removes the agent from the team and deletes its prompt file."
            confirmLabel="Remove"
            destructive
            typedConfirm={agent.role}
            onConfirm={onRemove}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function AddAgentButton({
  team,
  onAdded,
}: {
  team: Team
  onAdded: (t: Team) => void
}): React.ReactElement {
  const [role, setRole] = useState('')
  const [model, setModel] = useState('anthropic/claude-sonnet-4.6')
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" data-testid="add-agent-button">
          <Plus />
          Add agent
        </Button>
      }
      title="Add agent"
      body={
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Role</span>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="research-assistant"
              className="rounded-md border px-3 py-1.5 text-sm"
              data-testid="add-agent-role"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border px-3 py-1.5 font-mono text-xs"
              data-testid="add-agent-model"
            />
          </label>
        </div>
      }
      confirmLabel="Add"
      onConfirm={async () => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(role)) {
          toast.error('Role must be lowercase letters, digits, and dashes')
          throw new Error('invalid role')
        }
        if (team.agents.some((a) => a.role === role)) {
          toast.error(`Agent ${role} already exists`)
          throw new Error('duplicate role')
        }
        try {
          const nextAgents = [
            ...team.agents.map((a) => ({ role: a.role, model: a.model })),
            { role, model },
          ]
          const next = await patchTeam(team.name, { agents: nextAgents })
          toast.success(`Added ${role}`)
          setRole('')
          onAdded(next)
        } catch (err) {
          const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
          toast.error(msg)
          throw err
        }
      }}
    />
  )
}
