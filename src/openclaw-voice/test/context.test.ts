import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_CONTEXT_DEFAULTS, buildAgentContext } from "../src/context.js";
import { fakeAgentContext, fakeWorkspace } from "./fakes.js";

const build = (config: Partial<typeof AGENT_CONTEXT_DEFAULTS> = {}) =>
  buildAgentContext(fakeAgentContext, {
    config: { ...AGENT_CONTEXT_DEFAULTS, enabled: true, ...config },
    cfg: {},
    agentId: "main",
    consultToolName: "openclaw_agent_consult",
  });

test("off unless enabled", async () => {
  assert.equal(await build({ enabled: false }), undefined);
});

test("the identity and the workspace files, in order, skipping missing ones", async () => {
  fakeWorkspace.identity = { name: "Eta", emoji: "⚡" };
  fakeWorkspace.files = { "SOUL.md": "Be brief.", "USER.md": "Nick Yu, in the Bay Area." };
  const text = (await build())!;
  // Joined with blank lines throughout, exactly as voice-call builds it.
  assert.match(text, /^OpenClaw agent voice context:\n\n- Agent id: main\n\n/);
  assert.match(text, /call openclaw_agent_consult when the caller needs the full agent brain/);
  assert.match(text, /Configured identity:\n- Name: Eta\n- Emoji: ⚡/);
  assert.match(text, /Workspace voice context:\n### SOUL\.md\nBe brief\.\n\n### USER\.md\nNick Yu, in the Bay Area\./);
  assert.doesNotMatch(text, /IDENTITY\.md/);
});

test("bounded by maxChars", async () => {
  fakeWorkspace.identity = {};
  fakeWorkspace.files = { "SOUL.md": "x".repeat(10_000), "USER.md": "never reached" };
  const text = (await build({ maxChars: 1000 }))!;
  assert.ok(text.length <= 1000, String(text.length));
  assert.match(text, /\[truncated\]$/);
  assert.doesNotMatch(text, /never reached/);
});
