import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { AvatarEditor } from '../../src/desktop/components/avatar-editor'
import { MessageList } from '../../src/desktop/components/message-list'
import { ModelSelect } from '../../src/desktop/components/model-select'
import { GenerateAvatarDialog } from '../../src/desktop/components/generate-avatar-dialog'
import { ProfileView } from '../../src/desktop/views/profile-view'
import { PresentationContext } from '../../src/desktop/presentation'
import type { CrewMember, CrewMessage, HermesProfile } from '../../src/desktop/types'

afterEach(cleanup)

describe('AvatarEditor', () => {
  it('reports color picks and hides generation when unavailable', () => {
    const onChange = vi.fn()
    render(<AvatarEditor avatar={null} color={null} name="Atlas" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Use color #5b4a9e' }))
    expect(onChange).toHaveBeenCalledWith({ color: '#5b4a9e' })
    expect(screen.queryByRole('button', { name: /Generate from profile/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull()
  })

  it('offers generation and image removal when applicable', () => {
    const onChange = vi.fn()
    const onGenerate = vi.fn()
    render(<AvatarEditor avatar="data:image/webp;base64,x" canGenerate color="#22639e" name="Atlas" onChange={onChange} onGenerate={onGenerate} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate from profile' }))
    expect(onGenerate).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(onChange).toHaveBeenCalledWith({ avatar: null })
    // Picking the active swatch again clears the custom color.
    fireEvent.click(screen.getByRole('button', { name: 'Use color #22639e' }))
    expect(onChange).toHaveBeenCalledWith({ color: null })
  })
})

describe('ModelSelect', () => {
  const catalog = [
    { provider: 'anthropic', providerName: 'Anthropic', model: 'claude-sonnet-5', reasoning: true, fast: false },
    { provider: 'anthropic', providerName: 'Anthropic', model: 'claude-haiku-4-5', reasoning: true, fast: true },
    { provider: 'openai-codex', providerName: 'OpenAI Codex', model: 'gpt-5.6', reasoning: true, fast: false },
  ]

  it('switches provider to its first catalog model', () => {
    const onChange = vi.fn()
    render(<ModelSelect catalog={catalog} model="claude-sonnet-5" onChange={onChange} provider="anthropic" />)

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-codex' } })
    expect(onChange).toHaveBeenCalledWith({ provider: 'openai-codex', model: 'gpt-5.6' })
  })

  it('keeps off-catalog values selectable as current', () => {
    render(<ModelSelect catalog={catalog} model="custom-model" onChange={vi.fn()} provider="anthropic" />)
    expect(screen.getByRole('option', { name: 'custom-model (current)' })).not.toBeNull()
  })
})

describe('ProfileView', () => {
  const identity = { displayName: 'You', avatar: null, color: null }

  function apiFixture() {
    const updateMe = vi.fn(async (body: Record<string, unknown>) => ({ ...identity, ...body }))
    const generateMyAvatar = vi.fn(async () => ({ ...identity, avatar: 'data:image/webp;base64,me' }))
    const imageGenerationStatus = vi.fn(async () => ({
      available: true, provider: 'test-images', defaultModel: 'img-high',
      models: [{ id: 'img-high', display: 'High' }, { id: 'img-low', display: 'Low', speed: 'fast' }],
    }))
    return { api: { updateMe, generateMyAvatar, imageGenerationStatus } as unknown as CrewApi, updateMe, generateMyAvatar }
  }

  it('saves the identity through the API and reports it back', async () => {
    const { api, updateMe } = apiFixture()
    const onIdentityChange = vi.fn()
    render(<ProfileView api={api} identity={identity} onIdentityChange={onIdentityChange} />)

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Morgan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(onIdentityChange).toHaveBeenCalled())
    expect(updateMe).toHaveBeenCalledWith({ displayName: 'Morgan', avatar: null, color: null })
  })

  it('generates an avatar for the user through the modal', async () => {
    const { api, generateMyAvatar } = apiFixture()
    const onIdentityChange = vi.fn()
    render(<ProfileView api={api} identity={identity} onIdentityChange={onIdentityChange} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Generate from profile' }))
    const dialog = await screen.findByRole('dialog', { name: 'Generate avatar' })
    expect(dialog).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Image model'), { target: { value: 'img-low' } })
    fireEvent.change(screen.getByLabelText(/Custom prompt/), { target: { value: 'a fox with headphones' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => expect(generateMyAvatar).toHaveBeenCalledWith({ model: 'img-low', prompt: 'a fox with headphones' }))
    await waitFor(() => expect(onIdentityChange).toHaveBeenCalled())
  })
})

describe('GenerateAvatarDialog', () => {
  it('preselects the configured default model and passes null for an empty prompt', () => {
    const onGenerate = vi.fn()
    render(<GenerateAvatarDialog
      name="Atlas"
      onClose={vi.fn()}
      onGenerate={onGenerate}
      status={{ available: true, provider: 'test', defaultModel: 'img-high', models: [{ id: 'img-low', display: 'Low' }, { id: 'img-high', display: 'High' }] }}
    />)

    expect((screen.getByLabelText('Image model') as HTMLSelectElement).value).toBe('img-high')
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onGenerate).toHaveBeenCalledWith({ model: 'img-high', prompt: null })
  })
})

describe('message presentation', () => {
  const profiles: HermesProfile[] = [{
    name: 'atlas', path: '/p/atlas', isDefault: false, gatewayRunning: true,
    provider: 'anthropic', model: 'claude-sonnet-5', hasEnv: true, skillCount: 0, description: '',
  }]
  const atlasMember: CrewMember = {
    profileId: 'atlas', displayName: 'Atlas Prime', role: 'Engineer',
    avatar: 'data:image/webp;base64,x', color: '#22639e', defaultProject: null, archived: false,
  }
  const base: CrewMessage = {
    id: 'm1', channelId: 'c1', rootMessageId: null, authorType: 'user', authorProfileId: null,
    content: 'Hello crew', mentions: [], project: { mode: 'inherit' }, modelLabel: null, createdAt: 10,
  }
  const agentMessage: CrewMessage = { ...base, id: 'm2', authorType: 'agent', authorProfileId: 'atlas', content: 'On it.', createdAt: 20_000_000 }

  it('renders stored display names and avatar images for authors', () => {
    render(
      <PresentationContext.Provider value={{ members: { atlas: atlasMember }, me: { displayName: 'Morgan', avatar: null, color: null } }}>
        <MessageList messages={[base, agentMessage]} pendingTurns={[]} profiles={profiles} />
      </PresentationContext.Provider>,
    )

    expect(screen.getByText('Morgan')).not.toBeNull()
    expect(screen.getByText('Atlas Prime')).not.toBeNull()
    expect(screen.getByLabelText('Atlas Prime').querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,x')
  })
})

describe('name generator', () => {
  it('produces capitalized names and avoids repeating the current one', async () => {
    const { generateMythicalName } = await import('../../src/desktop/name-generator')
    for (let i = 0; i < 40; i += 1) {
      const name = generateMythicalName('Athena')
      expect(name.length).toBeGreaterThan(2)
      expect(name[0]).toBe(name[0].toUpperCase())
      expect(name).not.toBe('Athena')
    }
  })
})

describe('MemberRoster', () => {
  it('shows presented names with activity presence instead of model info', async () => {
    const { MemberRoster } = await import('../../src/desktop/components/member-roster')
    render(
      <PresentationContext.Provider value={{
        members: { atlas: { ...atlasFixture(), displayName: 'Seliel', role: 'Engineer' } },
        me: { displayName: 'You', avatar: null, color: null },
      }}>
        <MemberRoster activeProfileIds={['atlas']} profiles={rosterProfiles()} />
      </PresentationContext.Provider>,
    )

    expect(screen.getByText('Seliel')).not.toBeNull()
    expect(screen.getByText('Working now')).not.toBeNull()
    expect(screen.queryByText(/claude-sonnet-5|anthropic/)).toBeNull()
  })
})

function atlasFixture(): CrewMember {
  return { profileId: 'atlas', displayName: 'atlas', role: '', avatar: null, color: null, defaultProject: null, archived: false }
}

function rosterProfiles(): HermesProfile[] {
  return [{
    name: 'atlas', path: '/p/atlas', isDefault: false, gatewayRunning: false,
    provider: 'anthropic', model: 'claude-sonnet-5', hasEnv: true, skillCount: 0, description: '',
  }]
}
