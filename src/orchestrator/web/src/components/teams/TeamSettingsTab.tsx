import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  ApiClientError,
  deleteTeam,
  patchTeam,
  resetTeam,
} from '@/lib/api-client'
import type { Team } from '@/lib/types'

const schema = z.object({
  description: z.string().min(1, 'Required'),
  expectedWorkspaceKind: z.enum(['social']),
  lead: z.string().min(1, 'Required'),
})

type FormValues = z.infer<typeof schema>

interface Props {
  team: Team
  onUpdated: (next: Team) => void
}

export function TeamSettingsTab({ team, onUpdated }: Props): React.ReactElement {
  const navigate = useNavigate()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: team.description,
      expectedWorkspaceKind: (team.expectedWorkspaceKind as 'social') ?? 'social',
      lead: team.lead,
    },
  })

  useEffect(() => {
    form.reset({
      description: team.description,
      expectedWorkspaceKind: (team.expectedWorkspaceKind as 'social') ?? 'social',
      lead: team.lead,
    })
  }, [team, form])

  async function onSubmit(values: FormValues): Promise<void> {
    try {
      const next = await patchTeam(team.name, values)
      toast.success('Team updated')
      onUpdated(next)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function onReset(): Promise<void> {
    try {
      const next = await resetTeam(team.name)
      toast.success(`Team ${team.name} reset to default`)
      onUpdated(next)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function onDelete(force: boolean): Promise<void> {
    try {
      await deleteTeam(team.name, force)
      toast.success(`Team ${team.name} deleted`)
      navigate('/teams')
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  // Lead must be one of the team's current agent roles (no point picking
  // a non-existent role; the UI also wouldn't have a prompt for it).
  const leadOptions = team.agents.map((a) => a.role)

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
              data-testid="team-settings-form"
            >
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="team-settings-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expectedWorkspaceKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Workspace kind</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="team-settings-kind">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="social">social</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lead"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lead</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={leadOptions.length === 0}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="team-settings-lead">
                          <SelectValue placeholder="Add an agent first" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {leadOptions.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  disabled={!form.formState.isDirty || form.formState.isSubmitting}
                  data-testid="team-settings-save"
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!form.formState.isDirty}
                >
                  Discard
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="ghost" data-testid="team-settings-reset">
                      <RotateCcw />
                      Reset to default
                    </Button>
                  }
                  title="Reset team to default?"
                  body="Replaces this team's settings with the seed default for that name. Agents and prompt files revert."
                  confirmLabel="Reset"
                  onConfirm={onReset}
                />
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Delete this team. Without force, the request fails if any sessions exist
            under any workspace using this team. With force, the team and its prompts
            are removed.
          </p>
          <div className="flex gap-2">
            <ConfirmDialog
              trigger={
                <Button variant="outline" data-testid="team-delete-button">
                  <Trash2 />
                  Delete team
                </Button>
              }
              title="Delete team?"
              body={
                <span>
                  This removes <code>{team.name}</code> if no sessions exist.
                </span>
              }
              confirmLabel="Delete"
              destructive
              typedConfirm={team.name}
              onConfirm={() => onDelete(false)}
            />
            <ConfirmDialog
              trigger={
                <Button variant="destructive" data-testid="team-force-delete-button">
                  Force delete
                </Button>
              }
              title="Force-delete team?"
              body={
                <span>
                  Cascade-deletes <code>{team.name}</code> and all its sessions across
                  workspaces. Cannot be undone.
                </span>
              }
              confirmLabel="Force delete"
              destructive
              typedConfirm={team.name}
              onConfirm={() => onDelete(true)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
