// TEMPORARY proof for #43104: how many context reports Orca asks a Claude CLI for around a resume.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScriptedClaudeRuntime } from '../installation/structured-claude-scripted-runtime-test-support'
import { stopStructuredAgentSessionRuntime } from '../structured-agent-session-runtime'

const SESSION = 'claude-report-count'
const CALLER = { callerKey: 'client-1' }
let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

const reports = () =>
  claude.children(SESSION).map((child) => child.calls.filter((c) => c === 'get_context_usage').length)

function turn(n: number): void {
  const child = claude.child(SESSION)
  const providerSession = String(child.launch.options.sessionId ?? child.launch.options.resume)
  const message = child.handlers.onMessage
  message?.({
    type: 'assistant',
    uuid: `a-${n}`,
    session_id: providerSession,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: `reply ${n}` }],
      usage: { input_tokens: 40_000, output_tokens: 20 }
    }
  })
  message?.({
    type: 'result',
    subtype: 'success',
    uuid: `r-${n}`,
    session_id: providerSession,
    result: `reply ${n}`,
    is_error: false
  })
}

describe('context reports per resume', () => {
  it('counts', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    const afterAttach = reports()
    turn(1)
    await host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(reports()[0]).toBeGreaterThan(0))
    const afterTurn1 = reports()
    turn(2)
    await host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(reports()[0]).toBeGreaterThan(1))
    const afterTurn2 = reports()
    await stopStructuredAgentSessionRuntime({ trigger: 'quit' })
    const restarted = await claude.install()
    const record = restarted.deps.store.getRecord(SESSION)
    const resumed = await restarted.attach(
      CALLER,
      claude.attachParams(SESSION, record?.lease.runtimeFence ?? null)
    )
    await vi.waitFor(() => expect(claude.children(SESSION).length).toBe(2))
    await restarted.flushStreamedEvents(SESSION)
    await new Promise((r) => setTimeout(r, 200))
    const afterResume = reports()
    turn(3)
    await restarted.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(reports()[1]).toBeGreaterThan(0))
    const afterResumedTurn = reports()
    console.log(
      'REPORT-COUNT-PROOF',
      JSON.stringify({
        resumedOk: (resumed as { ok: boolean }).ok,
        resumeLaunch: { resume: claude.child(SESSION).launch.options.resume ?? null, sessionId: claude.child(SESSION).launch.options.sessionId ?? null },
        afterAttach,
        afterTurn1,
        afterTurn2,
        afterResume,
        afterResumedTurn
      })
    )
  })
})
