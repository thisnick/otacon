import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
import { CreateTeamDialog } from '@/components/teams/CreateTeamDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { listAllTeams } from '@/lib/api-client'
import type { TeamSummary } from '@/lib/types'

export function TeamsPage(): React.ReactElement {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const list = await listAllTeams()
      setTeams(list)
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Failed to load teams: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex flex-col gap-4" data-testid="teams-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Teams</h1>
        <CreateTeamDialog onCreated={refresh} />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {teams === null ? (
        <SkeletonRows />
      ) : teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          description="Click 'New team' to create one. Add agents (and their prompts) on the detail page."
        />
      ) : (
        <div className="rounded-md border">
          <Table data-testid="teams-table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Workspace kind</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead className="text-right"># agents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.name} data-testid={`team-row-${t.name}`}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to={`/teams/${encodeURIComponent(t.name)}`}
                      className="hover:underline"
                    >
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-sm text-muted-foreground">
                    {t.description}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t.expectedWorkspaceKind}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{t.lead || '—'}</TableCell>
                  <TableCell className="text-right text-sm">
                    {t.agents.length}
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

function SkeletonRows(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}
