import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Send } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Transcript } from '@/components/runs/Transcript'
import {
  ApiClientError,
  getSession,
  startRun,
  streamSessionEvents,
} from '@/lib/api-client'
import { TranscriptStore, type TranscriptState } from '@/lib/event-handler'
import type { SessionSummary } from '@/lib/types'
import { formatRelativeTime } from '@/lib/format'

export function RunDetailPage(): React.ReactElement {
  const { sid: rawSid } = useParams()
  const sid = rawSid ?? ''
  const [params] = useSearchParams()
  const workspace = params.get('ws') ?? ''
  const team = params.get('team') ?? ''

  const [meta, setMeta] = useState<SessionSummary | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState('')
  const [sending, setSending] = useState(false)

  const store = useMemo(() => new TranscriptStore(), [])
  const [state, setState] = useState<TranscriptState>(() => store.getState())

  // Subscribe to the transcript store.
  useEffect(() => {
    const unsub = store.subscribe(setState)
    return unsub
  }, [store])

  // Fetch session metadata.
  useEffect(() => {
    if (!workspace || !team || !sid) return
    let cancelled = false
    void (async () => {
      try {
        const m = await getSession(workspace, team, sid)
        if (!cancelled) setMeta(m)
      } catch (err) {
        if (!cancelled) setMetaError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace, team, sid])

  // Open the SSE stream (replay + live tail).
  const handleRef = useRef<{ close: () => void } | null>(null)
  useEffect(() => {
    if (!workspace || !team || !sid) return
    store.reset()
    const handle = streamSessionEvents(workspace, team, sid, {
      onEvent: (ev) => store.ingest(ev),
      onError: (err) => setStreamError(err.message),
    })
    handleRef.current = handle
    return () => {
      handle.close()
      handleRef.current = null
    }
  }, [workspace, team, sid, store])

  async function sendFollowUp(): Promise<void> {
    if (!followUp.trim() || sending) return
    setSending(true)
    try {
      // Re-attach to the same session id with `resume`. The server starts a
      // new turn and continues streaming on the same session; SSE replay
      // here keeps the existing tail open.
      startRun(
        {
          workspace,
          team,
          userMessage: followUp,
          resume: sid,
        },
        {
          onEvent: () => {},
          onError: (err) => toast.error(`Send: ${err.message}`),
        },
      )
      toast.success('Follow-up message sent')
      setFollowUp('')
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    } finally {
      setSending(false)
    }
  }

  if (!workspace || !team) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Missing run context</AlertTitle>
        <AlertDescription>
          The URL needs `?ws=` and `?team=` query parameters to load this run.
        </AlertDescription>
      </Alert>
    )
  }

  if (metaError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load run</AlertTitle>
        <AlertDescription>{metaError}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="run-detail-page">
      {meta ? <RunHeader meta={meta} /> : <Skeleton className="h-32 w-full" />}

      {streamError && (
        <Alert variant="default" className="border-amber-500/50">
          <AlertTitle>Stream issue</AlertTitle>
          <AlertDescription>{streamError}</AlertDescription>
        </Alert>
      )}

      <Transcript state={state} />

      {meta && meta.status === 'running' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Send follow-up message</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Textarea
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              rows={3}
              placeholder="Add a follow-up to this run..."
              data-testid="followup-message"
            />
            <Button
              onClick={sendFollowUp}
              disabled={!followUp.trim() || sending}
              className="self-end"
              data-testid="followup-send"
            >
              <Send /> Send
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RunHeader({ meta }: { meta: SessionSummary }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <span className="font-mono text-sm">{meta.id}</span>
          <StatusBadge status={meta.status} />
          <Badge variant="secondary">{meta.team}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Workspace: <span className="font-mono">{meta.workspace}</span></span>
        <span>Agent: <span className="font-mono">{meta.agentRole}</span></span>
        <span>Model: <span className="font-mono">{meta.modelProvider}/{meta.modelId}</span></span>
        <span>Started: {formatRelativeTime(meta.startedAt)}</span>
        {meta.endedAt && <span>Ended: {formatRelativeTime(meta.endedAt)}</span>}
        {meta.error && (
          <span className="text-destructive">Error: {meta.error}</span>
        )}
      </CardContent>
    </Card>
  )
}
