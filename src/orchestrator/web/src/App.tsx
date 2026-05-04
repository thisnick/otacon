import { lazy, Suspense } from 'react'
import { ThemeProvider } from 'next-themes'
import { Toaster } from 'sonner'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { Skeleton } from '@/components/ui/skeleton'

// Static imports for the lightweight CRUD pages. RunDetail is code-split
// because it pulls pi-web-ui's MessageList web component which transitively
// drags ~300 KB gz of provider SDKs we'd otherwise eagerly load on /workspaces.
import { RunsPage } from '@/pages/runs-page'
import { WorkspacesPage } from '@/pages/workspaces-page'
import { WorkspaceDetailPage } from '@/pages/workspace-detail-page'
import { TeamsPage } from '@/pages/teams-page'
import { TeamDetailPage } from '@/pages/team-detail-page'

const RunDetailPage = lazy(() =>
  import('@/pages/run-detail-page').then((m) => ({ default: m.RunDetailPage })),
)

function PageFallback(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export function App(): React.ReactElement {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <HashRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<RunsPage />} />
            <Route
              path="runs/:sid"
              element={
                <Suspense fallback={<PageFallback />}>
                  <RunDetailPage />
                </Suspense>
              }
            />
            <Route path="workspaces" element={<WorkspacesPage />} />
            <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="teams/:name" element={<TeamDetailPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toaster richColors closeButton position="top-right" />
    </ThemeProvider>
  )
}
