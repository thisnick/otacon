import { Link } from 'react-router-dom'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

interface Props {
  pathname: string
  params: Readonly<Record<string, string | undefined>>
}

interface Crumb {
  label: string
  to?: string
}

function buildCrumbs(pathname: string, params: Props['params']): Crumb[] {
  if (pathname === '/' || pathname === '') return [{ label: 'Runs' }]
  if (pathname.startsWith('/runs/')) {
    return [
      { label: 'Runs', to: '/' },
      { label: params.sid ?? 'run' },
    ]
  }
  if (pathname === '/workspaces') return [{ label: 'Workspaces' }]
  if (pathname.startsWith('/workspaces/')) {
    return [
      { label: 'Workspaces', to: '/workspaces' },
      { label: params.id ?? 'workspace' },
    ]
  }
  if (pathname === '/teams') return [{ label: 'Teams' }]
  if (pathname.startsWith('/teams/')) {
    return [
      { label: 'Teams', to: '/teams' },
      { label: params.name ?? 'team' },
    ]
  }
  return [{ label: 'otacon' }]
}

export function Breadcrumbs({ pathname, params }: Props): React.ReactElement {
  const crumbs = buildCrumbs(pathname, params)
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={`${c.label}-${i}`} className="contents">
              <BreadcrumbItem>
                {last || !c.to ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator />}
            </span>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
