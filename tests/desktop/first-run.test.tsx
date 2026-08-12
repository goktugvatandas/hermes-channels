import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { FirstRun } from '../../src/desktop/components/first-run'
import type { HermesProfile } from '../../src/desktop/types'

afterEach(cleanup)

const atlas: HermesProfile = {
  name: 'atlas', path: '/profiles/atlas', isDefault: false, gatewayRunning: true,
  provider: 'openai', model: 'gpt-5.6', hasEnv: true, skillCount: 2, description: 'Engineer',
}

describe('FirstRun', () => {
  it('creates global #general with one always-on responder and classifier off', async () => {
    const createChannel = vi.fn(async () => ({ id: 'channel-1', name: 'general' }))
    const updateClassifier = vi.fn(async () => ({ enabled: false }))
    const onComplete = vi.fn()
    const api = { createChannel, updateClassifier } as unknown as CrewApi
    render(<FirstRun api={api} onComplete={onComplete} profiles={[atlas]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Create Crew' }))

    await waitFor(() => expect(createChannel).toHaveBeenCalledWith({
      name: 'general', purpose: 'Coordinate work with your Hermes crew',
      defaultResponderProfile: 'atlas', defaultProject: { mode: 'global' },
      members: [{ profileId: 'atlas', activationPolicy: 'always' }],
    }))
    expect(updateClassifier).toHaveBeenCalledWith('channel-1', {
      enabled: false, provider: null, model: null, reasoningEffort: null,
      maxTokens: 300, confidenceThreshold: 0.65,
    })
    expect(onComplete).toHaveBeenCalled()
  })
})
