import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StartRunDialog } from '@/components/runs/StartRunDialog'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  listAllTeams,
  listSessions,
  listWorkspaces,
} from '@/lib/api-client'
import type { SessionSummary, TeamSummary, WorkspaceSummary } from '@/lib/types'
import { formatRelativeTime } from '@/lib/format'

const ALL = '__all__'

interface RunRow extends SessionSummary {
  // SessionSummary already has workspace + team fields.
}

export function RunsPage(): React.ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [rows, setRows] = useState<RunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Filters.
  const [workspaceFilter, setWorkspaceFilter] = useState<string>(ALL)
  const [teamFilter, setTeamFilter] = useState<string>(ALL)
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    setError(null)
    setRows(null)
    try {
      const [ws, tt] = await Promise.all([listWorkspaces(), listAllTeams()])
      setWorkspaces(ws)
      setTeams(tt)
      // Aggregate sessions across the cross-product of workspaces × teams.
      // Small data set in practice; if this ever grows we'll switch to a
      // server-side `/api/v1/runs` endpoint.
      const all: RunRow[] = []
      const errors: string[] = []
      await Promise.all(
        ws.flatMap((w) =>
          tt
            .filter((t) => t.expectedWorkspaceKind === w.kind)
            .map(async (t) => {
              try {
                const list = await listSessions(w.id, t.name)
                all.push(...list)
              } catch (err) {
                errors.push(`${w.id}/${t.name}: ${(err as Error).message}`)
              }
            }),
        ),
      )
      all.sort((a, b) => b.startedAt - a.startedAt)
      setRows(all)
      if (errors.length > 0) {
        // Soft-fail: surface to console + toast, but still render whatever loaded.
        console.warn('Some session lists failed:', errors)
      }
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Failed to load runs: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    if (!rows) return []
    return rows.filter((r) => {
      if (workspaceFilter !== ALL && r.workspace !== workspaceFilter) return false
      if (teamFilter !== ALL && r.team !== teamFilter) return false
      if (statusFilter !== ALL && r.status !== statusFilter) return false
      if (search && !r.id.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [rows, workspaceFilter, teamFilter, statusFilter, search])

  return (
    <div className="flex flex-col gap-4" data-testid="runs-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Runs</h1>
        <StartRunDialog onStarted={() => refresh()} />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={workspaceFilter} onValueChange={setWorkspaceFilter}>
          <SelectTrigger className="w-[180px]" data-testid="filter-workspace">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All workspaces</SelectItem>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={teamFilter} onValueChange={setTeamFilter}>
          <SelectTrigger className="w-[200px]" data-testid="filter-team">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All teams</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]" data-testid="filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            <SelectItem value="running">running</SelectItem>
            <SelectItem value="completed">completed</SelectItem>
            <SelectItem value="aborted">aborted</SelectItem>
            <SelectItem value="error">error</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="search id..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-[220px]"
          data-testid="filter-search"
        />
      </div>

      {rows === null ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'No runs yet' : 'No runs match these filters'}
          description={
            rows.length === 0
              ? 'Click "Start new run" to launch one.'
              : 'Adjust the filters to see runs.'
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table data-testid="runs-table">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id} data-testid={`run-row-${r.id}`}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to={`/runs/${encodeURIComponent(r.id)}?ws=${encodeURIComponent(r.workspace)}&team=${encodeURIComponent(r.team)}`}
                      className="hover:underline"
                    >
                      {r.id.slice(0, 12)}...
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.workspace}</TableCell>
                  <TableCell className="text-sm">{r.team}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelativeTime(r.startedAt)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {durationLabel(r)}
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

function durationLabel(r: SessionSummary): string {
  if (!r.endedAt) return r.status === 'running' ? '...' : '—'
  const sec = Math.max(0, Math.floor((r.endedAt - r.startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}m ${rem}s`
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
