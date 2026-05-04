import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiClientError,
  listAllTeams,
  listWorkspaces,
  startRun,
} from '@/lib/api-client'
import type { TeamSummary, WorkspaceSummary } from '@/lib/types'

// `phone` field is intentionally absent (plan §5.4): the server resolves
// it from the workspace's phoneNumber.
const schema = z.object({
  workspace: z.string().min(1, 'Required'),
  team: z.string().min(1, 'Required'),
  userMessage: z.string().min(1, 'Required'),
  autoApprove: z.boolean().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  /** Called after a successful run start. */
  onStarted?: (sessionId: string, workspace: string, team: string) => void
}

export function StartRunDialog({ onStarted }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const navigate = useNavigate()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      workspace: '',
      team: '',
      userMessage: '',
      autoApprove: false,
    },
  })

  const selectedWorkspace = form.watch('workspace')

  useEffect(() => {
    if (!open) return
    void listWorkspaces()
      .then(setWorkspaces)
      .catch((err: Error) => toast.error(`Workspaces: ${err.message}`))
  }, [open])

  useEffect(() => {
    if (!selectedWorkspace) {
      setTeams([])
      return
    }
    const ws = workspaces.find((w) => w.id === selectedWorkspace)
    if (!ws) return
    void listAllTeams(ws.kind)
      .then((list) => {
        setTeams(list)
        // Reset team if currently selected one isn't in the new list.
        const cur = form.getValues('team')
        if (cur && !list.some((t) => t.name === cur)) {
          form.setValue('team', '')
        }
      })
      .catch((err: Error) => toast.error(`Teams: ${err.message}`))
  }, [selectedWorkspace, workspaces, form])

  async function onSubmit(values: FormValues): Promise<void> {
    try {
      const handle = startRun(
        {
          workspace: values.workspace,
          team: values.team,
          userMessage: values.userMessage,
          autoApprove: values.autoApprove,
        },
        {
          onEvent: () => {},
          onError: (err) => toast.error(`Stream: ${err.message}`),
          onDone: () => {},
        },
      )
      const sid = await handle.sessionId
      toast.success(`Run started: ${sid.slice(0, 8)}...`)
      setOpen(false)
      form.reset()
      onStarted?.(sid, values.workspace, values.team)
      navigate(
        `/runs/${encodeURIComponent(sid)}?ws=${encodeURIComponent(values.workspace)}&team=${encodeURIComponent(values.team)}`,
      )
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="start-run-button">
          <Plus />
          Start new run
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start new run</DialogTitle>
          <DialogDescription>
            The phone is resolved from the workspace's phone number; no manual entry needed.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            data-testid="start-run-form"
          >
            <FormField
              control={form.control}
              name="workspace"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Workspace</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="run-workspace">
                        <SelectValue placeholder="Pick a workspace" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {workspaces.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          <span className="font-mono text-xs">{w.id}</span>
                          <span className="text-muted-foreground"> · {w.displayName}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="team"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Team</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!selectedWorkspace || teams.length === 0}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="run-team">
                        <SelectValue
                          placeholder={
                            selectedWorkspace ? 'Pick a team' : 'Pick a workspace first'
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {teams.map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Filtered to teams matching the selected workspace's kind.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="userMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={5}
                      placeholder="What should the agent do?"
                      {...field}
                      data-testid="run-message"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="autoApprove"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="run-auto-approve"
                    />
                  </FormControl>
                  <Label
                    htmlFor="auto-approve"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Auto-approve mutating commands (skip approval gate)
                  </Label>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                data-testid="run-submit"
              >
                {form.formState.isSubmitting ? 'Starting...' : 'Start'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
