import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { EmptyState } from '@/components/shared/EmptyState'
import { listWorkspaceSessions } from '@/lib/api-client'
import type { SessionSummary } from '@/lib/types'
import { formatRelativeTime } from '@/lib/format'

interface Props {
  workspaceId: string
}

export function WorkspaceSessionsTab({ workspaceId }: Props): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const list = await listWorkspaceSessions(workspaceId)
      setSessions(list)
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Failed to load sessions: ${(err as Error).message}`)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (sessions === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No runs for this workspace yet"
        description="Start one from the Runs tab in the sidebar."
      />
    )
  }
  return (
    <div className="rounded-md border" data-testid="sessions-tab">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Ended</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-mono text-xs">
                <Link
                  to={`/runs/${encodeURIComponent(s.id)}?ws=${encodeURIComponent(s.workspace)}&team=${encodeURIComponent(s.team)}`}
                  className="hover:underline"
                >
                  {s.id.slice(0, 12)}...
                </Link>
              </TableCell>
              <TableCell className="text-sm">{s.team}</TableCell>
              <TableCell>
                <StatusBadge status={s.status} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatRelativeTime(s.startedAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {s.endedAt ? formatRelativeTime(s.endedAt) : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
