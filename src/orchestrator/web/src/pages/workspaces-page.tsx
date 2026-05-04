import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Phone } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CreateWorkspaceDialog } from '@/components/workspaces/CreateWorkspaceDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { listWorkspaces, listPhones } from '@/lib/api-client'
import type { PhoneEntry, WorkspaceSummary } from '@/lib/types'
import { formatRelativeTime, lastN } from '@/lib/format'
import { cn } from '@/lib/utils'

export function WorkspacesPage(): React.ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [phones, setPhones] = useState<PhoneEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [ws, ph] = await Promise.all([
        listWorkspaces(),
        listPhones().catch(() => [] as PhoneEntry[]),
      ])
      setWorkspaces(ws)
      setPhones(ph)
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Failed to load workspaces: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex flex-col gap-4" data-testid="workspaces-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workspaces</h1>
        <CreateWorkspaceDialog onCreated={refresh} />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {workspaces === null ? (
        <SkeletonRows />
      ) : workspaces.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Click 'New workspace' to create one. Each workspace owns a persona, env files, and credentials."
        />
      ) : (
        <div className="rounded-md border">
          <Table data-testid="workspaces-table">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Display name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((ws) => (
                <TableRow key={ws.id} data-testid={`ws-row-${ws.id}`}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to={`/workspaces/${encodeURIComponent(ws.id)}`}
                      className="hover:underline"
                    >
                      {ws.id}
                    </Link>
                  </TableCell>
                  <TableCell>{ws.displayName}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{ws.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    <PhoneCell phoneNumber={ws.phoneNumber} phones={phones} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelativeTime(ws.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function PhoneCell({
  phoneNumber,
  phones,
}: {
  phoneNumber: string | undefined
  phones: PhoneEntry[]
}): React.ReactElement {
  if (!phoneNumber) {
    return <span className="text-sm text-muted-foreground">—</span>
  }
  const match = phones.find((p) => p.phoneNumber === phoneNumber)
  const status = match?.status ?? 'unreachable'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span
            className={cn(
              'inline-block size-2 rounded-full',
              status === 'online'
                ? 'bg-emerald-500'
                : status === 'offline'
                  ? 'bg-muted-foreground/40'
                  : 'bg-amber-500',
            )}
          />
          <Phone className="size-3 text-muted-foreground" />
          <span className="font-mono text-xs">···{lastN(phoneNumber, 4)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div className="font-mono">{phoneNumber}</div>
          {match && (
            <div className="text-muted-foreground">
              {match.displayLabel} · {match.status}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function SkeletonRows(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}
