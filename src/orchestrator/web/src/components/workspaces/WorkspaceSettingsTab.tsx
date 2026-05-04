import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Trash2 } from 'lucide-react'
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
import { PhoneCombobox } from '@/components/shared/PhoneCombobox'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  ApiClientError,
  deleteWorkspace,
  patchWorkspace,
} from '@/lib/api-client'
import type { Workspace } from '@/lib/types'

const E164_RE = /^\+[1-9]\d{6,14}$/

const schema = z.object({
  displayName: z.string().min(1, 'Required'),
  phoneNumber: z.string().regex(E164_RE, 'E.164 (e.g. +13415551234)'),
  externalRef: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  workspace: Workspace
  onUpdated: (next: Workspace) => void
}

export function WorkspaceSettingsTab({ workspace, onUpdated }: Props): React.ReactElement {
  const navigate = useNavigate()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      displayName: workspace.displayName,
      phoneNumber: workspace.phoneNumber ?? '',
      externalRef: workspace.externalRef ?? '',
    },
  })

  // Sync form when the workspace prop changes (e.g. after PATCH).
  useEffect(() => {
    form.reset({
      displayName: workspace.displayName,
      phoneNumber: workspace.phoneNumber ?? '',
      externalRef: workspace.externalRef ?? '',
    })
  }, [workspace, form])

  async function onSubmit(values: FormValues): Promise<void> {
    try {
      const next = await patchWorkspace(workspace.id, {
        displayName: values.displayName,
        phoneNumber: values.phoneNumber,
        externalRef: values.externalRef || undefined,
      })
      toast.success('Workspace updated')
      onUpdated(next)
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function onDelete(force: boolean): Promise<void> {
    try {
      await deleteWorkspace(workspace.id, force)
      toast.success(`Workspace ${workspace.id} deleted`)
      navigate('/workspaces')
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

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
              data-testid="workspace-settings-form"
            >
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display name</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="ws-settings-display-name" />
                    </FormControl>
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
                      <PhoneCombobox value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="externalRef"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>External ref</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="ws-settings-external-ref" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  disabled={!form.formState.isDirty || form.formState.isSubmitting}
                  data-testid="ws-settings-save"
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
            Delete this workspace. Without force, the request fails if any sessions exist.
            With force, the entire workspace directory (sessions, traces, env, credentials) is removed.
          </p>
          <div className="flex gap-2">
            <ConfirmDialog
              trigger={
                <Button variant="outline" data-testid="ws-delete-button">
                  <Trash2 />
                  Delete workspace
                </Button>
              }
              title="Delete workspace?"
              body={
                <span>
                  This will remove <code>{workspace.id}</code>. Sessions must be empty.
                </span>
              }
              confirmLabel="Delete"
              destructive
              typedConfirm={workspace.id}
              onConfirm={() => onDelete(false)}
            />
            <ConfirmDialog
              trigger={
                <Button variant="destructive" data-testid="ws-force-delete-button">
                  Force delete
                </Button>
              }
              title="Force-delete workspace?"
              body={
                <span>
                  Cascade-deletes <code>{workspace.id}</code> and all its sessions, traces,
                  env files, and credentials. Cannot be undone.
                </span>
              }
              confirmLabel="Force delete"
              destructive
              typedConfirm={workspace.id}
              onConfirm={() => onDelete(true)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
