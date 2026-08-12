import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { SearchView } from '../../src/desktop/components/search-view'
import type { CrewChannel, HermesProfile } from '../../src/desktop/types'

afterEach(cleanup)

const channel: CrewChannel = {
  id: 'channel-1', name: 'general', purpose: '', topic: '', defaultResponderProfile: 'atlas',
  defaultProject: null, allowedProjects: [], routingRules: {}, createdAt: 1, updatedAt: 1,
}
const profile: HermesProfile = {
  name: 'atlas', path: '/profiles/atlas', isDefault: false, gatewayRunning: true,
  provider: 'openai', model: 'gpt-5.6', hasEnv: true, skillCount: 1, description: '',
}

describe('SearchView', () => {
  it('submits text and facet filters and renders inspectable matches', async () => {
    const search = vi.fn(async () => [{
      kind: 'message', sourceId: 'message-1', channelId: 'channel-1', memberId: 'atlas',
      projectId: 'p-web', state: '', text: 'Audit web rendering', createdAt: 1,
    }])
    render(<SearchView api={{ search } as unknown as CrewApi} channels={[channel]} profiles={[profile]} />)

    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'rendering' } })
    fireEvent.change(screen.getByLabelText('Channel filter'), { target: { value: 'channel-1' } })
    fireEvent.change(screen.getByLabelText('Member filter'), { target: { value: 'atlas' } })
    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p-web' } })
    fireEvent.change(screen.getByLabelText('State filter'), { target: { value: 'completed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(search).toHaveBeenCalledWith({
      q: 'rendering', channelId: 'channel-1', member: 'atlas', project: 'p-web', state: 'completed',
    }))
    expect(await screen.findByText('Audit web rendering')).not.toBeNull()
    expect(screen.getByText('p-web')).not.toBeNull()
  })
})
