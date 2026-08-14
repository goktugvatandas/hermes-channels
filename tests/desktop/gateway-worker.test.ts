import type { PluginRest } from '@hermes/plugin-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayWorker } from '../../src/desktop/gateway-worker'
import type { DispatchClaim, EventFrame, RpcEvent } from '../../src/desktop/types'

const AGENT_CLAIM: DispatchClaim = {
  id: 'turn-1',
  kind: 'agent',
  channelId: 'channel-1',
  profileId: 'atlas',
  context: 'Build the requested change.',
  instructions: null,
  input: null,
  cwd: '/work/web',
  provider: 'openai',
  model: 'gpt-5.6',
  reasoningEffort: 'high',
  maxTokens: 300,
  temperature: 0,
  createdAt: 1,
}

function setup(
  claim: DispatchClaim | undefined = AGENT_CLAIM,
  settle: { completeSettleMs?: number; fallbackSettleMs?: number } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = []
  let nextClaim: DispatchClaim | undefined = claim
  const rest = vi.fn(async (path: string) => {
    if (path === '/dispatch/claim') {
      const result = nextClaim
      nextClaim = undefined
      return result
    }
    return {}
  }) as unknown as PluginRest
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push([method, params])
      if (method === 'session.create') {
        return { session_id: 'runtime-1', stored_session_id: 'stored-1' }
      }
      return {}
    },
  )
  const worker = new GatewayWorker({
    completeSettleMs: settle.completeSettleMs ?? 0,
    fallbackSettleMs: settle.fallbackSettleMs,
    gatewayState: { get: () => 'open' },
    onEvent: () => () => undefined,
    request,
    rest,
    socket: () => () => undefined,
    workerId: 'window-1',
  })

  return { calls, request, rest, worker }
}

describe('GatewayWorker', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('claims an agent turn, binds its Hermes session, then submits context', async () => {
    const { calls, rest, worker } = setup()

    await worker.claimOnce()

    expect(calls).toEqual([
      [
        'session.create',
        {
          cols: 96,
          source: 'tool',
          cwd: '/work/web',
          profile: 'atlas',
          model: 'gpt-5.6',
          provider: 'openai',
          reasoning_effort: 'high',
          fast: false,
        },
      ],
      [
        'prompt.submit',
        { session_id: 'runtime-1', text: AGENT_CLAIM.context },
      ],
    ])
    expect(rest).toHaveBeenCalledWith('/dispatch/turn-1/session', {
      method: 'POST',
      body: {
        runtimeSessionId: 'runtime-1',
        storedSessionId: 'stored-1',
      },
    })
  })

  it('completes only the turn correlated to the emitting Hermes session', async () => {
    const { rest, worker } = setup()
    await worker.claimOnce()

    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'someone-else',
      payload: { text: 'Wrong session' },
    })
    await worker.handleGatewayEvent({
      type: 'message.delta',
      session_id: 'runtime-1',
      payload: { text: 'Done.' },
    })
    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: {
        text: 'Done.\n<!-- hermes-channels:intent {"schemaVersion":1,"intent":"result"} -->',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rest).not.toHaveBeenCalledWith(
      '/dispatch/turn-1/complete',
      expect.objectContaining({
        body: expect.objectContaining({ visibleText: 'Wrong session' }),
      }),
    )
    expect(rest).toHaveBeenCalledWith('/dispatch/turn-1/complete', {
      method: 'POST',
      body: {
        visibleText: 'Done.',
        envelope: expect.objectContaining({ intent: 'result' }),
      },
    })
  })

  it('waits for the trailing marker message before completing the turn', async () => {
    const { rest, worker } = setup()
    await worker.claimOnce()

    // Reply arrives as TWO assistant messages: the content first…
    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Plan: split /flip into three pieces. @freya please analyze edge cases.' },
    })
    // …then a short message carrying only the envelope marker.
    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: '[[hermes-channels:intent {"schemaVersion":1,"intent":"handoff","recipients":["freya"],"replyExpected":true,"replyBudget":1}]]' },
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    const restMock = vi.mocked(rest)
    const completion = restMock.mock.calls.find(([path]) => path === '/dispatch/turn-1/complete')
    const body = (completion?.[1] as { body: { envelope: unknown; visibleText: string } }).body
    expect(body.envelope).toMatchObject({ intent: 'handoff', recipients: ['freya'] })
    expect(body.visibleText).toContain('Plan: split /flip')
    expect(body.visibleText).not.toContain('hermes-channels:intent')
    // Exactly one completion despite two message.complete frames.
    expect(restMock.mock.calls.filter(([path]) => path === '/dispatch/turn-1/complete')).toHaveLength(1)
  })

  it('recovers the intent marker from deltas when the complete frame drops it', async () => {
    const { rest, worker } = setup()
    await worker.claimOnce()

    // Streamed deltas carry the full text including the trailing marker…
    await worker.handleGatewayEvent({
      type: 'message.delta',
      session_id: 'runtime-1',
      payload: { text: 'Handing off.\n<!-- hermes-channels:intent {"schemaVersion":1,"intent":"handoff","recipients":["freya"],"replyExpected":true,"replyBudget":1} -->' },
    })
    // …but the complete frame delivers a rendered variant without it.
    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Handing off.' },
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rest).toHaveBeenCalledWith('/dispatch/turn-1/complete', {
      method: 'POST',
      body: {
        visibleText: 'Handing off.',
        envelope: expect.objectContaining({ intent: 'handoff', recipients: ['freya'] }),
      },
    })
  })

  it('never finalizes on stream quiet before a message.complete arrives', async () => {
    // The "I'll load the skill" truncation: the model streams an opening
    // sentence, then goes silent while a tool (skill load) runs. Quiet alone
    // must not complete the turn — only message.complete banks a reply.
    const { rest, worker } = setup()
    await worker.claimOnce()

    await worker.handleGatewayEvent({
      type: 'message.delta',
      session_id: 'runtime-1',
      payload: { text: "I'll load the channel-collaboration skill first." },
    })
    await worker.handleGatewayEvent({
      type: 'tool.start',
      session_id: 'runtime-1',
      payload: { name: 'skill' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const restMock = vi.mocked(rest)
    expect(restMock.mock.calls.some(([path]) => path === '/dispatch/turn-1/complete')).toBe(false)

    // The real completion (with the actual answer) still finalizes normally.
    await worker.handleGatewayEvent({
      type: 'message.delta',
      session_id: 'runtime-1',
      payload: { text: ' Loaded. Here is the answer.' },
    })
    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Loaded. Here is the answer.' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const completion = restMock.mock.calls.find(([path]) => path === '/dispatch/turn-1/complete')
    const body = (completion?.[1] as { body: { visibleText: string } }).body
    expect(body.visibleText).toContain('Here is the answer')
  })

  it('interrupts only the runtime session bound to a cancelled turn', async () => {
    const { request, worker } = setup()
    await worker.claimOnce()

    await worker.handleCrewFrame({
      sequence: 3,
      type: 'cancelled',
      channelId: 'channel-1',
      turnId: 'another-turn',
      payload: {},
    } satisfies EventFrame)
    await worker.handleCrewFrame({
      sequence: 4,
      type: 'cancelled',
      channelId: 'channel-1',
      turnId: 'turn-1',
      payload: {},
    } satisfies EventFrame)

    expect(request).toHaveBeenCalledWith('session.interrupt', {
      session_id: 'runtime-1',
    })
    expect(request.mock.calls.filter(([method]) => method === 'session.interrupt')).toHaveLength(1)
  })

  it('runs classification through llm.oneshot and never submits a prompt', async () => {
    const claim: DispatchClaim = {
      ...AGENT_CLAIM,
      id: 'turn-classify',
      kind: 'classification',
      profileId: null,
      context: '',
      instructions: 'Return JSON only.',
      input: 'Which member should respond?',
      cwd: null,
      provider: 'google',
      model: 'gemini-2.5-flash',
      reasoningEffort: 'low',
    }
    const { calls, request, rest, worker } = setup(claim)
    request.mockImplementation(async (method, params) => {
      calls.push([method, params])
      if (method === 'session.create') {
        return { session_id: 'runtime-1', stored_session_id: null }
      }
      if (method === 'llm.oneshot') {
        return { text: '{"intent":"question","recipients":["atlas"]}' }
      }
      return {}
    })

    await worker.claimOnce()

    expect(calls).toEqual([
      [
        'session.create',
        {
          cols: 96,
          source: 'tool',
          model: 'gemini-2.5-flash',
          provider: 'google',
          reasoning_effort: 'low',
          fast: false,
        },
      ],
      [
        'llm.oneshot',
        {
          session_id: 'runtime-1',
          instructions: 'Return JSON only.',
          input: 'Which member should respond?',
          task: 'hermes_channels_classifier',
          max_tokens: 300,
          temperature: 0,
        },
      ],
    ])
    expect(calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    expect(rest).toHaveBeenCalledWith('/dispatch/turn-classify/classification', {
      method: 'POST',
      body: { rawResult: '{"intent":"question","recipients":["atlas"]}' },
    })
  })

  it('marks a claimed turn failed when Hermes cannot create its session', async () => {
    const { request, rest, worker } = setup()
    request.mockRejectedValueOnce(new Error('profile atlas has no configured model'))

    await expect(worker.claimOnce()).resolves.toBe(true)

    expect(rest).toHaveBeenCalledWith('/dispatch/turn-1/fail', {
      method: 'POST',
      body: { error: 'profile atlas has no configured model' },
    })
    expect(request).not.toHaveBeenCalledWith('prompt.submit', expect.anything())
  })

  it('flushes matched activity after 100ms and ignores other sessions', async () => {
    vi.useFakeTimers()
    const { rest, worker } = setup()
    await worker.claimOnce()

    void worker.handleGatewayEvent({
      type: 'tool.start',
      session_id: 'someone-else',
      payload: { name: 'browser' },
    } satisfies RpcEvent)
    void worker.handleGatewayEvent({
      type: 'tool.start',
      session_id: 'runtime-1',
      payload: { name: 'shell', tool_id: 'tool-1' },
    } satisfies RpcEvent)
    await vi.advanceTimersByTimeAsync(100)

    expect(rest).toHaveBeenCalledWith('/dispatch/turn-1/events', {
      method: 'POST',
      body: {
        type: 'tool_started',
        payload: {
          gatewayType: 'tool.start',
          name: 'shell',
          toolId: 'tool-1',
        },
      },
    })
  })
})

describe('sloppy marker stripping', () => {
  it('hides marker lines with truncated closers from visible text', async () => {
    const { parseIntentMarker, stripIntentMarkers } = await import('../../src/desktop/intent-marker')
    const text = 'Done.\n\n[[hermes-channels:intent {"schemaVersion":1,"intent":"inform","summary":"x"}]'
    expect(stripIntentMarkers(text)).toBe('Done.')
    expect(parseIntentMarker(text).visibleText).toBe('Done.')
    const legacy = 'Done.\n\n[[hermes-crew:intent {"schemaVersion":1,"intent":"inform"}]'
    expect(stripIntentMarkers(legacy)).toBe('Done.')
    const multiline = 'Done.\n\n[[hermes-channels:intent {\n"schemaVersion": 1,\n"intent": "inform"\n}]]'
    expect(stripIntentMarkers(multiline)).toBe('Done.')
  })
})

describe('post-complete tool activity', () => {
  it('does not finalize while a tool runs after a banked complete', async () => {
    vi.useRealTimers()
    // Real settle windows: short must NOT fire while the tool gap is open.
    const { rest, worker } = setup(AGENT_CLAIM, { completeSettleMs: 40, fallbackSettleMs: 10_000 })
    await worker.claimOnce()

    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Let me check the skill first.' },
    })
    await worker.handleGatewayEvent({
      type: 'tool.start',
      session_id: 'runtime-1',
      payload: { name: 'skill' },
    })
    // Well past the 40ms short settle — the tool gap must hold finalize open.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const restMock = vi.mocked(rest)
    expect(restMock.mock.calls.some(([path]) => path === '/dispatch/turn-1/complete')).toBe(false)

    await worker.handleGatewayEvent({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Checked. Final answer here.' },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const completion = restMock.mock.calls.find(([path]) => path === '/dispatch/turn-1/complete')
    const body = (completion?.[1] as { body: { visibleText: string } }).body
    expect(body.visibleText).toContain('Final answer here')
  })

  it('does not finalize while a new assistant message streams after a completion', async () => {
    vi.useRealTimers()
    const { rest, worker } = setup(AGENT_CLAIM, { completeSettleMs: 40, fallbackSettleMs: 10_000 })
    await worker.claimOnce()
    await worker.handleGatewayEvent({
      type: 'message.complete', session_id: 'runtime-1', payload: { text: 'First part.' },
    })
    await worker.handleGatewayEvent({
      type: 'message.delta', session_id: 'runtime-1', payload: { text: 'Second part starts' },
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(vi.mocked(rest).mock.calls.some(([path]) => path === '/dispatch/turn-1/complete')).toBe(false)

    await worker.handleGatewayEvent({
      type: 'message.complete', session_id: 'runtime-1', payload: { text: 'Second part finished.' },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const completion = vi.mocked(rest).mock.calls.find(([path]) => path === '/dispatch/turn-1/complete')
    expect((completion?.[1] as { body: { visibleText: string } }).body.visibleText)
      .toContain('Second part finished')
  })

  it('cancels pending finalization when the worker is disposed', async () => {
    vi.useFakeTimers()
    const { rest, worker } = setup(AGENT_CLAIM, { completeSettleMs: 100 })
    await worker.claimOnce()
    await worker.handleGatewayEvent({
      type: 'message.complete', session_id: 'runtime-1', payload: { text: 'Done.' },
    })
    worker.dispose()
    await vi.advanceTimersByTimeAsync(200)
    expect(vi.mocked(rest).mock.calls.some(([path]) => path === '/dispatch/turn-1/complete')).toBe(false)
    vi.useRealTimers()
  })
})
