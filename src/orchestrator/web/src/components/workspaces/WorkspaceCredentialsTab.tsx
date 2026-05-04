import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  ApiClientError,
  deleteCredentials,
  getCredentialsStatus,
  putCredentials,
} from '@/lib/api-client'
import type { CredentialsStatus } from '@/lib/types'

interface Props {
  workspaceId: string
}

export function WorkspaceCredentialsTab({ workspaceId }: Props): React.ReactElement {
  const [status, setStatus] = useState<CredentialsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const s = await getCredentialsStatus(workspaceId)
      setStatus(s)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function validate(): unknown | null {
    try {
      const parsed = JSON.parse(draft)
      setParseError(null)
      return parsed
    } catch (err) {
      setParseError((err as Error).message)
      return null
    }
  }

  async function save(): Promise<void> {
    const parsed = validate()
    if (parsed === null) {
      toast.error('Fix JSON parse errors before saving')
      return
    }
    try {
      await putCredentials(workspaceId, parsed)
      toast.success('Credentials saved')
      setDraft('')
      await refresh()
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  async function wipe(): Promise<void> {
    try {
      await deleteCredentials(workspaceId)
      toast.success('Credentials wiped')
      await refresh()
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load credentials</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (status === null) {
    return <Skeleton className="h-32 w-full" />
  }

  return (
    <div className="flex flex-col gap-4" data-testid="credentials-tab">
      <Alert variant={status.hasCredentials ? 'default' : 'destructive'}>
        <AlertTitle>
          {status.hasCredentials
            ? `Credentials set (${status.fieldsSet.length} field${status.fieldsSet.length === 1 ? '' : 's'})`
            : 'No credentials set'}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            Credentials are write-only. Values never leave the server. Field names below
            are surfaced for reference; the values are not.
          </span>
          {status.fieldsSet.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {status.fieldsSet.map((k) => (
                <Badge key={k} variant="secondary" className="font-mono text-xs">
                  {k}
                </Badge>
              ))}
            </div>
          )}
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Replace credentials</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            placeholder='{ "cookies": "session=...", "deviceId": "abc123" }'
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setParseError(null)
            }}
            rows={10}
            className="font-mono text-xs"
            data-testid="credentials-textarea"
          />
          {parseError && (
            <p className="text-xs text-destructive">JSON parse error: {parseError}</p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => validate()}
              data-testid="credentials-validate"
            >
              Validate JSON
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={draft.length === 0}
              data-testid="credentials-save"
            >
              Save
            </Button>
            {status.hasCredentials && (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" data-testid="credentials-wipe">
                    <Trash2 />
                    Wipe credentials
                  </Button>
                }
                title="Wipe credentials?"
                body="Removes all stored credential fields for this workspace."
                confirmLabel="Wipe"
                destructive
                onConfirm={wipe}
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
