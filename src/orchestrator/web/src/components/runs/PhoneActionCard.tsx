import { useState } from 'react'
import type { PhoneActionPayload } from '@/lib/types'
import { traceUrl } from '@/lib/api-client'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface Props {
  payload: PhoneActionPayload
}

function summary(p: PhoneActionPayload): string {
  return [p.command, p.subcommand, p.target].filter(Boolean).join(' ')
}

export function PhoneActionCard({ payload }: Props): React.ReactElement {
  const [zoom, setZoom] = useState<{ url: string; label: string } | null>(null)
  const before = traceUrl(payload.screenshots.before)
  const annotated = traceUrl(payload.screenshots.annotated)
  const after = traceUrl(payload.screenshots.after)
  const ok = payload.exitCode === 0
  return (
    <Card
      className={cn('my-3', !ok && 'border-destructive/50')}
      data-testid="phone-action-card"
    >
      <CardHeader className="flex-row items-center justify-between gap-2 py-2">
        <code className="font-mono text-xs">{summary(payload)}</code>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-destructive/15 text-destructive',
          )}
        >
          {ok ? 'ok' : `exit ${payload.exitCode}`}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {payload.rationale && (
          <p className="text-xs text-muted-foreground italic">{payload.rationale}</p>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Thumbnail label="before" url={before} onClick={(u) => setZoom({ url: u, label: 'before' })} />
          <Thumbnail label="annotated" url={annotated} onClick={(u) => setZoom({ url: u, label: 'annotated' })} />
          <Thumbnail label="after" url={after} onClick={(u) => setZoom({ url: u, label: 'after' })} />
        </div>
        {payload.stderr && (
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
            {payload.stderr}
          </pre>
        )}
      </CardContent>
      {zoom && (
        <button
          type="button"
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
        >
          <img
            src={zoom.url}
            alt={zoom.label}
            className="max-h-full max-w-full rounded-md"
          />
        </button>
      )}
    </Card>
  )
}

function Thumbnail({
  label,
  url,
  onClick,
}: {
  label: string
  url: string | null
  onClick: (url: string) => void
}): React.ReactElement {
  if (!url) {
    return (
      <div className="flex aspect-[3/4] flex-col items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
        <span>{label}</span>
        <span>—</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onClick(url)}
      className="flex flex-col gap-1 rounded-md border p-1 hover:bg-accent"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <img src={url} alt={label} loading="lazy" className="rounded-sm" />
    </button>
  )
}
