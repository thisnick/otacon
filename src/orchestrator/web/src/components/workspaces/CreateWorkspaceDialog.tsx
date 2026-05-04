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
  FormDescription,
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
import { PhoneCombobox } from '@/components/shared/PhoneCombobox'
import { ApiClientError, createWorkspace } from '@/lib/api-client'

// Mirror server-side WORKSPACE_ID_PATTERN from
// src/orchestrator/src/server/routes/workspaces.ts to avoid a roundtrip on
// obviously-bad ids.
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9._-]+$/
const E164_RE = /^\+[1-9]\d{6,14}$/

const schema = z.object({
  id: z
    .string()
    .min(1, 'Required')
    .regex(WORKSPACE_ID_RE, 'Format: kind:identifier (e.g. xhs:nick)'),
  displayName: z.string().min(1, 'Required'),
  kind: z.literal('social'),
  phoneNumber: z.string().regex(E164_RE, 'E.164 (e.g. +13415551234)'),
  externalRef: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  /** Called after a successful create so the parent can refresh its list. */
  onCreated?: () => void
}

export function CreateWorkspaceDialog({ onCreated }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      id: '',
      displayName: '',
      kind: 'social',
      phoneNumber: '',
      externalRef: '',
    },
  })

  async function onSubmit(values: FormValues): Promise<void> {
    try {
      const ws = await createWorkspace({
        id: values.id,
        displayName: values.displayName,
        kind: 'social',
        phoneNumber: values.phoneNumber,
        externalRef: values.externalRef || undefined,
      })
      toast.success(`Workspace ${ws.id} created`)
      setOpen(false)
      form.reset()
      onCreated?.()
      navigate(`/workspaces/${encodeURIComponent(ws.id)}`)
    } catch (err) {
      if (err instanceof ApiClientError) {
        toast.error(`${err.code}: ${err.message}`)
      } else {
        toast.error((err as Error).message)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="create-workspace-button">
          <Plus />
          New workspace
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            Workspaces own a social-account persona, env files, and credentials.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            data-testid="create-workspace-form"
          >
            <FormField
              control={form.control}
              name="id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>ID</FormLabel>
                  <FormControl>
                    <Input placeholder="xhs:nick" {...field} data-testid="ws-id" />
                  </FormControl>
                  <FormDescription>
                    Format: kind:identifier (URL-safe, lowercase recommended)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="My XHS account"
                      {...field}
                      data-testid="ws-display-name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="ws-kind">
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
              name="phoneNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone number</FormLabel>
                  <FormControl>
                    <PhoneCombobox
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormDescription>
                    Pick a registry phone or type a free-form E.164 number.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="externalRef"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>External ref (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="xhs:nick123"
                      {...field}
                      data-testid="ws-external-ref"
                    />
                  </FormControl>
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
                data-testid="ws-submit"
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
