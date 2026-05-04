import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { ApiClientError, createTeam } from '@/lib/api-client'

// Team names should be url-safe lowercase tokens. The server doesn't yet
// publish a regex, so we mirror common slugs ([a-z0-9-]+).
const TEAM_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const schema = z.object({
  name: z
    .string()
    .min(1, 'Required')
    .regex(TEAM_NAME_RE, 'Lowercase letters, digits, and dashes only'),
  description: z.string().min(1, 'Required'),
  expectedWorkspaceKind: z.enum(['social']),
})

type FormValues = z.infer<typeof schema>

interface Props {
  onCreated?: () => void
}

export function CreateTeamDialog({ onCreated }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      description: '',
      expectedWorkspaceKind: 'social',
    },
  })

  async function onSubmit(values: FormValues): Promise<void> {
    try {
      const team = await createTeam({
        name: values.name,
        description: values.description,
        expectedWorkspaceKind: values.expectedWorkspaceKind,
      })
      toast.success(`Team ${team.name} created`)
      setOpen(false)
      form.reset()
      onCreated?.()
      navigate(`/teams/${encodeURIComponent(team.name)}`)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="create-team-button">
          <Plus />
          New team
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>
            Teams are a set of agents with prompts. Add agents on the team detail page.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            data-testid="create-team-form"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="social-media-engagement"
                      {...field}
                      data-testid="team-name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="What does this team do?"
                      {...field}
                      data-testid="team-description"
                    />
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
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="team-kind">
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                data-testid="team-submit"
              >
                {form.formState.isSubmitting ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
