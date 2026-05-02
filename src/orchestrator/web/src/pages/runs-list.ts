// RunsList page — workspace × team × session browser plus a "start run" form.

import { html, render, type TemplateResult } from 'lit'
import {
  ApiClientError,
  listSessions,
  listTeams,
  listWorkspaces,
  startRun,
} from '../api-client.js'
import { navigate, sessionDetailHash } from '../router.js'
import type { SessionSummary, TeamSummary, WorkspaceSummary } from '../types.js'

interface State {
  workspaces: WorkspaceSummary[]
  teams: TeamSummary[]
  sessions: SessionSummary[]
  selectedWorkspace: string | null
  selectedTeam: string | null
  loadingWorkspaces: boolean
  loadingTeams: boolean
  loadingSessions: boolean
  error: string | null
  // Start-run form state.
  formPhone: string
  formMessage: string
  formAutoApprove: boolean
  startInFlight: boolean
}

const state: State = {
  workspaces: [],
  teams: [],
  sessions: [],
  selectedWorkspace: null,
  selectedTeam: null,
  loadingWorkspaces: false,
  loadingTeams: false,
  loadingSessions: false,
  error: null,
  formPhone: '',
  formMessage: '',
  formAutoApprove: false,
  startInFlight: false,
}

let mountTarget: HTMLElement | null = null

function rerender(): void {
  if (mountTarget) render(view(), mountTarget)
}

function setError(err: unknown): void {
  state.error = err instanceof Error ? err.message : String(err)
  rerender()
}

async function loadWorkspaces(): Promise<void> {
  state.loadingWorkspaces = true
  state.error = null
  rerender()
  try {
    state.workspaces = await listWorkspaces()
    if (!state.selectedWorkspace && state.workspaces[0]) {
      state.selectedWorkspace = state.workspaces[0].id
      void loadTeams(state.selectedWorkspace)
    }
  } catch (err) {
    setError(err)
  } finally {
    state.loadingWorkspaces = false
    rerender()
  }
}

async function loadTeams(ws: string): Promise<void> {
  state.loadingTeams = true
  state.teams = []
  state.selectedTeam = null
  state.sessions = []
  rerender()
  try {
    state.teams = await listTeams(ws)
    if (state.teams[0]) {
      state.selectedTeam = state.teams[0].name
      void loadSessions(ws, state.selectedTeam)
    }
  } catch (err) {
    setError(err)
  } finally {
    state.loadingTeams = false
    rerender()
  }
}

async function loadSessions(ws: string, team: string): Promise<void> {
  state.loadingSessions = true
  state.sessions = []
  rerender()
  try {
    state.sessions = await listSessions(ws, team)
  } catch (err) {
    setError(err)
  } finally {
    state.loadingSessions = false
    rerender()
  }
}

function onWorkspaceChange(id: string): void {
  state.selectedWorkspace = id
  void loadTeams(id)
}

function onTeamChange(name: string): void {
  state.selectedTeam = name
  if (state.selectedWorkspace) void loadSessions(state.selectedWorkspace, name)
}

async function onStartRun(): Promise<void> {
  if (!state.selectedWorkspace || !state.selectedTeam) return
  if (!state.formPhone || !state.formMessage) {
    state.error = 'Phone URL and message are required.'
    rerender()
    return
  }
  state.startInFlight = true
  state.error = null
  rerender()
  const ws = state.selectedWorkspace
  const team = state.selectedTeam
  try {
    const handle = startRun(
      {
        workspace: ws,
        team,
        phone: state.formPhone,
        userMessage: state.formMessage,
        autoApprove: state.formAutoApprove,
      },
      {
        onEvent: () => {
          // Stream consumed by SessionDetail page after we navigate; we just
          // need the session id from headers here.
        },
        onError: (err) => {
          state.error = err.message
          state.startInFlight = false
          rerender()
        },
      },
    )
    const sid = await handle.sessionId
    handle.close()
    if (sid) {
      navigate(sessionDetailHash(sid, ws, team))
    } else {
      state.error = 'Server did not return x-orchestrator-session-id'
    }
  } catch (err) {
    if (err instanceof ApiClientError) {
      state.error = `${err.code}: ${err.message}`
    } else {
      setError(err)
    }
  } finally {
    state.startInFlight = false
    rerender()
  }
}

function fmtTs(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function sessionRow(s: SessionSummary): TemplateResult {
  return html`
    <li class="session-row">
      <a
        href=${sessionDetailHash(s.id, s.workspace, s.team)}
        class="session-link"
      >
        <span class="session-id">${s.id}</span>
        <span class="session-status session-status-${s.status}">${s.status}</span>
        <span class="session-meta">${s.modelProvider}/${s.modelId}</span>
        <span class="session-time">${fmtTs(s.startedAt)}</span>
      </a>
    </li>
  `
}

function view(): TemplateResult {
  return html`
    <div class="runs-list-page">
      <header class="page-header">
        <h1>Orchestrator</h1>
      </header>
      ${state.error
        ? html`<div class="banner banner-error">${state.error}</div>`
        : null}

      <section class="picker">
        <label>
          Workspace
          <select
            ?disabled=${state.loadingWorkspaces}
            @change=${(e: Event) =>
              onWorkspaceChange((e.target as HTMLSelectElement).value)}
          >
            ${state.workspaces.map(
              (w) => html`
                <option
                  value=${w.id}
                  ?selected=${w.id === state.selectedWorkspace}
                >
                  ${w.displayName} (${w.kind})
                </option>
              `,
            )}
          </select>
        </label>
        <label>
          Team
          <select
            ?disabled=${state.loadingTeams || state.teams.length === 0}
            @change=${(e: Event) => onTeamChange((e.target as HTMLSelectElement).value)}
          >
            ${state.teams.map(
              (t) => html`
                <option value=${t.name} ?selected=${t.name === state.selectedTeam}>
                  ${t.name}
                </option>
              `,
            )}
          </select>
        </label>
      </section>

      <section class="start-run">
        <h2>Start new run</h2>
        <form
          @submit=${(e: Event) => {
            e.preventDefault()
            void onStartRun()
          }}
        >
          <label>
            Phone URL
            <input
              type="url"
              required
              placeholder="https://phone-2.tail0437b8.ts.net/"
              .value=${state.formPhone}
              @input=${(e: Event) => {
                state.formPhone = (e.target as HTMLInputElement).value
              }}
            />
          </label>
          <label>
            Message
            <textarea
              required
              rows="3"
              .value=${state.formMessage}
              @input=${(e: Event) => {
                state.formMessage = (e.target as HTMLTextAreaElement).value
              }}
            ></textarea>
          </label>
          <label class="checkbox">
            <input
              type="checkbox"
              .checked=${state.formAutoApprove}
              @change=${(e: Event) => {
                state.formAutoApprove = (e.target as HTMLInputElement).checked
              }}
            />
            auto-approve mutating commands
          </label>
          <button type="submit" ?disabled=${state.startInFlight || !state.selectedTeam}>
            ${state.startInFlight ? 'Starting…' : 'Start run'}
          </button>
        </form>
      </section>

      <section class="sessions">
        <h2>Sessions</h2>
        ${state.loadingSessions
          ? html`<p>Loading…</p>`
          : state.sessions.length === 0
            ? html`<p class="empty">No sessions yet.</p>`
            : html`<ul class="session-list">${state.sessions.map(sessionRow)}</ul>`}
      </section>
    </div>
  `
}

export function mount(el: HTMLElement): () => void {
  mountTarget = el
  rerender()
  void loadWorkspaces()
  return () => {
    if (mountTarget === el) mountTarget = null
  }
}
