# Fixtures

Static JSON / NDJSON files used for UI development before Phase B's API server lands.

When running `pnpm --filter orchestrator-web dev`, Vite serves any file in this
directory at `/fixtures/<path>`. Tests can swap `VITE_API_BASE` to `/fixtures`
to bypass the real API:

```bash
VITE_API_BASE=/fixtures pnpm --filter orchestrator-web dev
```

These files mirror the on-disk layout the API spec describes
(`docs/orchestrator-api.md`). Once the real server is up they can be deleted.
