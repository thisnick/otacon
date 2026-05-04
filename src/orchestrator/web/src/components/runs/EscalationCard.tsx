import { useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ApiClientError, resolveEscalation } from '@/lib/api-client'
import type { EscalationCardState } from '@/lib/event-handler'

interface Props {
  state: EscalationCardState
}

export function EscalationCard({ state }: Props): React.ReactElement {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const resolved = state.status === 'resolved'

  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await resolveEscalation(state.token, { decision, message: message || undefined })
      toast.success(`Escalation ${decision}d`)
      // The SSE stream will deliver `escalation_resolved` and update the card.
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.code}: ${err.message}` : (err as Error).message
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="my-3 border-amber-500/50" data-testid="escalation-card">
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">Approval needed</span>
        {resolved ? (
          <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">
            {state.decision}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-amber-700 dark:text-amber-400">
            pending
          </Badge>
        )}
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{state.payload.prompt}</CardContent>
      {!resolved && (
        <CardFooter className="flex flex-col gap-2 items-stretch">
          <Textarea
            placeholder="Optional message to the agent (e.g. context for rejection)"
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="escalation-message"
          />
          <div className="flex gap-2 self-end">
            <Button
              variant="outline"
              onClick={() => decide('reject')}
              disabled={busy}
              data-testid="escalation-reject"
            >
              Reject
            </Button>
            <Button
              onClick={() => decide('approve')}
              disabled={busy}
              data-testid="escalation-approve"
            >
              Approve
            </Button>
          </div>
        </CardFooter>
      )}
      {resolved && state.resolutionMessage && (
        <CardFooter className="text-xs text-muted-foreground italic">
          “{state.resolutionMessage}”
        </CardFooter>
      )}
    </Card>
  )
}
