import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { TeamSettingsTab } from '@/components/teams/TeamSettingsTab'
import { TeamAgentsTab } from '@/components/teams/TeamAgentsTab'
import { getTeam } from '@/lib/api-client'
import type { Team } from '@/lib/types'

const TABS = ['settings', 'agents'] as const
type TabId = (typeof TABS)[number]

function isTab(s: string | null): s is TabId {
  return TABS.includes((s ?? '') as TabId)
}

export function TeamDetailPage(): React.ReactElement {
  const { name: rawName } = useParams()
  const name = rawName ?? ''
  const [params, setParams] = useSearchParams()
  const tab: TabId = isTab(params.get('tab')) ? (params.get('tab') as TabId) : 'settings'

  const [team, setTeam] = useState<Team | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const t = await getTeam(name)
      setTeam(t)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [name])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function setTab(next: TabId): void {
    const p = new URLSearchParams(params)
    p.set('tab', next)
    setParams(p, { replace: true })
  }

  if (error) {
    return (
      <Alert variant="destructive" data-testid="team-detail-error">
        <AlertTitle>Couldn't load team</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!team) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="team-detail-page">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span className="font-mono">{team.name}</span>
            <Badge variant="secondary">{team.expectedWorkspaceKind}</Badge>
            {team.lead && (
              <span className="text-xs text-muted-foreground">
                lead: <span className="font-mono">{team.lead}</span>
              </span>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{team.description}</p>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {team.agents.length} agent{team.agents.length === 1 ? '' : 's'}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="settings" data-testid="tab-settings">
            Settings
          </TabsTrigger>
          <TabsTrigger value="agents" data-testid="tab-agents">
            Agents
          </TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-6">
          <TeamSettingsTab team={team} onUpdated={(t) => setTeam(t)} />
        </TabsContent>
        <TabsContent value="agents" className="mt-6">
          <TeamAgentsTab team={team} onUpdated={(t) => setTeam(t)} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
