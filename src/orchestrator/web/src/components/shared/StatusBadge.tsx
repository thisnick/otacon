import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StatusKind =
  | 'online'
  | 'offline'
  | 'unreachable'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'

interface Props {
  status: StatusKind | string
  className?: string
}

const STATUS_CLASSES: Record<string, string> = {
  online: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  offline: 'bg-muted text-muted-foreground',
  unreachable: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  aborted: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  error: 'bg-destructive/15 text-destructive',
}

export function StatusBadge({ status, className }: Props): React.ReactElement {
  const cls = STATUS_CLASSES[status] ?? 'bg-muted text-muted-foreground'
  return (
    <Badge variant="secondary" className={cn(cls, className)}>
      {status}
    </Badge>
  )
}
