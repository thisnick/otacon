# orchestrator e2e tests

End-to-end tests for the orchestrator. Each test spawns the runtime it needs
and asserts against the resulting state. These tests are slow (multi-second
warmup) and **require process spawn + fs writes**, so they live outside the
unit suite.

## Running

From the orchestrator package:

```sh
cd src/orchestrator
pnpm test:e2e:smoke         # workflow + nitro + world-local pipeline
pnpm test                   # unit + e2e:smoke
```

Each test spawns its own server. Other tests that require live phone hardware
(e.g. `test-phase1-chrome-search.ts`, added by the evaluator) require
`phone-3` to be reachable and will be tagged accordingly in their own files.

## Test list

| File | What it asserts | Hardware required |
|---|---|---|
| `test-workflow-smoke.ts` | Nitro builds + workflow/nitro transforms `"use workflow"`/`"use step"` + world-local persists chunks + `run.getReadable({startIndex:0})` replays them. | None — pure software. |

## Authoring guidelines

- Each test spawns + tears down its own server. Use a unique `PORT` env var
  per test file (e.g. 9095, 9096, ...) so tests can run in parallel later.
- Use `fs.mkdtempSync(...)` for `ORCHESTRATOR_DATA_DIR` so the test starts
  from a clean slate. Tear it down in `finally`.
- Print PASS/FAIL one-liners and exit non-zero on any failure. The evaluator
  CI runner just checks exit code + final summary line.
- Don't depend on the order of tests. Each file is self-contained.
