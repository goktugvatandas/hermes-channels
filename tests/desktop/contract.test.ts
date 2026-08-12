import contract from '../contracts/hermes-0.20.0.json'
import { describe, expect, it } from 'vitest'

describe('Hermes Agent 0.20.0 contract', () => {
  it('contains every RPC and event Crew depends on', () => {
    expect(contract.rpcs).toEqual([
      'approval.respond',
      'llm.oneshot',
      'model.options',
      'projects.list',
      'prompt.submit',
      'session.create',
      'session.interrupt',
      'session.resume',
    ])
    expect(contract.events).toContain('message.complete')
    expect(contract.events).toContain('tool.start')
  })
})
