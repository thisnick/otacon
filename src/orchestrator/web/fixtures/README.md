# Fixtures

Static JSON used for UI development before the Phase I server endpoints land
on `phase-i`. The fixture mode is opt-in via the `VITE_FIXTURES=1` env var:

```bash
VITE_FIXTURES=1 pnpm --filter orchestrator-web dev
```

Vite's `fixturesPlugin` (in `vite.config.ts`) intercepts `/api/v1/*` requests
and resolves them against this directory. Mapping:

- `GET /api/v1/workspaces`   → `workspaces.json`
- `GET /api/v1/teams`        → `teams.json`
- `GET /api/v1/phones`       → `phones.json`
- everything else            → `404 (fixture not implemented)` so it's
  obvious what the UI still expects

When `VITE_FIXTURES` is unset, Vite proxies `/api/*` to `ORCHESTRATOR_API_URL`
(default `http://localhost:9090`) — i.e. the real Phase B+I server. Tests can
also ignore fixtures entirely by setting `VITE_API_BASE` to a deployed VPS.

Once server-implementer's Phase I endpoints land on `phase-i`, switch to real
mode via `pnpm dev` (without the `VITE_FIXTURES` env var).
