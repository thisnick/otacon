// Trivial hash-router: '#/' → RunsList, '#/runs/:sid?ws=&team=' → SessionDetail.

export type Route =
  | { name: 'runs-list' }
  | { name: 'session-detail'; sid: string; workspace: string; team: string }
  | { name: 'unknown' }

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/'
  const [pathRaw, queryRaw = ''] = raw.split('?')
  const path = pathRaw.replace(/\/+$/, '') || '/'
  if (path === '/' || path === '') return { name: 'runs-list' }
  const m = path.match(/^\/runs\/([^/]+)$/)
  if (m) {
    const params = new URLSearchParams(queryRaw)
    const ws = params.get('ws') ?? ''
    const team = params.get('team') ?? ''
    if (!ws || !team) return { name: 'unknown' }
    return {
      name: 'session-detail',
      sid: decodeURIComponent(m[1]!),
      workspace: ws,
      team,
    }
  }
  return { name: 'unknown' }
}

export function sessionDetailHash(sid: string, workspace: string, team: string): string {
  const params = new URLSearchParams({ ws: workspace, team })
  return `#/runs/${encodeURIComponent(sid)}?${params.toString()}`
}

export function navigate(hash: string): void {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = hash
  }
}

export function onRouteChange(handler: (r: Route) => void): () => void {
  const fire = () => handler(parseHash(window.location.hash))
  window.addEventListener('hashchange', fire)
  fire()
  return () => window.removeEventListener('hashchange', fire)
}
