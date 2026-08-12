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

function setup(claim: DispatchClaim | undefined = AGENT_CLAIM) {
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
          source: 'desktop',
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
        text: 'Done.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"result"} -->',
      },
    })

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
          source: 'desktop',
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
          task: 'hermes_crew_classifier',
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
