import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-client'

type Health = 'unknown' | 'ok' | 'down'

const POLL_INTERVAL_MS = 15_000

export function ServerHealthIndicator(): React.ReactElement {
  const [health, setHealth] = useState<Health>('unknown')

  useEffect(() => {
    let cancelled = false
    async function ping(): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/api/v1/workspaces`, { method: 'GET' })
        if (!cancelled) setHealth(res.ok ? 'ok' : 'down')
      } catch {
        if (!cancelled) setHealth('down')
      }
    }
    void ping()
    const id = window.setInterval(ping, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const label = health === 'ok' ? 'healthy' : health === 'down' ? 'down' : '...'
  const dotClass =
    health === 'ok'
      ? 'bg-emerald-500'
      : health === 'down'
        ? 'bg-destructive'
        : 'bg-muted-foreground/40'

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="server-health"
      data-state={health}
    >
      <span className={cn('inline-block size-2 rounded-full', dotClass)} />
      <span>{label}</span>
    </div>
  )
}
