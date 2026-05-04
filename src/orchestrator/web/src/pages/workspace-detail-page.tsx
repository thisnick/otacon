import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { WorkspaceSettingsTab } from '@/components/workspaces/WorkspaceSettingsTab'
import { WorkspaceEnvTab } from '@/components/workspaces/WorkspaceEnvTab'
import { WorkspaceCredentialsTab } from '@/components/workspaces/WorkspaceCredentialsTab'
import { WorkspaceSessionsTab } from '@/components/workspaces/WorkspaceSessionsTab'
import { getWorkspace } from '@/lib/api-client'
import type { Workspace } from '@/lib/types'

const TABS = ['settings', 'env', 'credentials', 'sessions'] as const
type TabId = (typeof TABS)[number]

function isTab(s: string | null): s is TabId {
  return TABS.includes((s ?? '') as TabId)
}

export function WorkspaceDetailPage(): React.ReactElement {
  const { id: rawId } = useParams()
  const id = rawId ?? ''
  const [params, setParams] = useSearchParams()
  const tab: TabId = isTab(params.get('tab')) ? (params.get('tab') as TabId) : 'settings'

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const ws = await getWorkspace(id)
      setWorkspace(ws)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [id])

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
      <Alert variant="destructive" data-testid="workspace-detail-error">
        <AlertTitle>Couldn't load workspace</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!workspace) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="workspace-detail-page">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span className="font-mono">{workspace.id}</span>
            <Badge variant="secondary">{workspace.kind}</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{workspace.displayName}</p>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {workspace.phoneNumber && (
            <div>
              Phone: <span className="font-mono">{workspace.phoneNumber}</span>
            </div>
          )}
          {workspace.externalRef && (
            <div>
              External ref: <span className="font-mono">{workspace.externalRef}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="settings" data-testid="tab-settings">
            Settings
          </TabsTrigger>
          <TabsTrigger value="env" data-testid="tab-env">
            Env files
          </TabsTrigger>
          <TabsTrigger value="credentials" data-testid="tab-credentials">
            Credentials
          </TabsTrigger>
          <TabsTrigger value="sessions" data-testid="tab-sessions">
            Sessions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-6">
          <WorkspaceSettingsTab
            workspace={workspace}
            onUpdated={(next) => setWorkspace(next)}
          />
        </TabsContent>
        <TabsContent value="env" className="mt-6">
          <WorkspaceEnvTab workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="credentials" className="mt-6">
          <WorkspaceCredentialsTab workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="sessions" className="mt-6">
          <WorkspaceSessionsTab workspaceId={workspace.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
