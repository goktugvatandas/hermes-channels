import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { StudioView } from '../../src/desktop/views/studio-view'
import type { CrewChannel, HermesProfile } from '../../src/desktop/types'

afterEach(cleanup)

const atlas: HermesProfile = {
  name: 'atlas', path: '/profiles/atlas', isDefault: false, gatewayRunning: true,
  provider: 'openai', model: 'gpt-5.6', hasEnv: true, skillCount: 2, description: 'Engineer',
}
const scout: HermesProfile = {
  name: 'scout', path: '/profiles/scout', isDefault: false, gatewayRunning: true,
  provider: 'google', model: 'gemini-2.5-pro', hasEnv: true, skillCount: 1, description: 'Researcher',
}
const channel: CrewChannel = {
  id: 'channel-1', name: 'general', purpose: '', topic: '', defaultResponderProfile: 'atlas',
  defaultProject: null, allowedProjects: [], routingRules: {}, createdAt: 1, updatedAt: 1,
}

function fixture() {
  const updateProfile = vi.fn(async (_name: string, body: { description: string }) => ({ ...atlas, description: body.description }))
  const updateSoul = vi.fn(async (_name: string, content: string) => ({ content }))
  const updateModel = vi.fn(async (name: string, provider: string, model: string) => ({ ...(name === 'atlas' ? atlas : scout), provider, model }))
  const updateSkills = vi.fn(async (_name: string, enabled: string[]) => enabled.map((name) => ({ name, enabled: true })))
  const updateToolsets = vi.fn(async (_name: string, enabled: string[]) => ({ enabled }))
  const updateMember = vi.fn(async (name: string, body: Record<string, unknown>) => ({ profileId: name, displayName: name, role: '', ...body }))
  const updateChannelMember = vi.fn(async (channelId: string, profileId: string, activationPolicy: string) => ({ channelId, profileId, activationPolicy }))
  const updateClassifier = vi.fn(async (_channelId: string, body: Record<string, unknown>) => body)
  const patchChannel = vi.fn(async (_channelId: string, body: Record<string, unknown>) => ({ ...channel, ...body }))
  const createProfile = vi.fn(async (body: Record<string, unknown>) => ({ ...scout, name: String(body.name) }))
  const api = {
    listProfiles: vi.fn(async () => [atlas, scout]),
    createProfile,
    updateProfile,
    getSoul: vi.fn(async () => ({ content: '# Atlas' })),
    updateSoul,
    updateModel,
    listSkills: vi.fn(async () => [{ name: 'react', enabled: true }, { name: 'browser', enabled: false }]),
    updateSkills,
    getToolsets: vi.fn(async () => ({ enabled: ['terminal'] })),
    updateToolsets,
    listProjects: vi.fn(async () => [{ id: 'p-web', name: 'Web', primaryPath: '/work/web', archived: false }]),
    listChannels: vi.fn(async () => [channel]),
    getMember: vi.fn(async (name: string) => ({ profileId: name, displayName: name, role: name === 'atlas' ? 'Engineer' : 'Researcher', color: null, avatar: null, defaultProject: null, archived: false })),
    updateMember,
    listChannelMembers: vi.fn(async () => [{ channelId: channel.id, profileId: 'atlas', activationPolicy: 'always' }]),
    updateChannelMember,
    getClassifier: vi.fn(async () => ({ enabled: false, provider: null, model: null, reasoningEffort: null, maxTokens: 300, confidenceThreshold: 0.65 })),
    updateClassifier,
    patchChannel,
  } as unknown as CrewApi
  return { api, createProfile, updateProfile, updateSoul, updateModel, updateSkills, updateToolsets, updateMember, updateChannelMember, updateClassifier, patchChannel }
}

describe('Crew Studio', () => {
  it('renders the native model catalog inside its required Hermes menu context', async () => {
    const { api } = fixture()
    render(<StudioView api={api} />)

    expect(await screen.findByLabelText('Hermes model catalog')).not.toBeNull()
  })

  it('creates a minimal Hermes profile without mixing clone options', async () => {
    const { api, createProfile } = fixture()
    render(<StudioView api={api} />)
    await screen.findByRole('button', { name: 'atlas' })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Hermes profile' })
    fireEvent.change(within(dialog).getByLabelText('Profile name'), { target: { value: 'critic' } })
    fireEvent.click(within(dialog).getByLabelText('Start without skills'))
    expect((within(dialog).getByLabelText('Copy skills from profile') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createProfile).toHaveBeenCalledWith({ name: 'critic', noSkills: true, cloneFrom: null, cloneConfig: false, cloneAll: false, description: '' }))
    expect(await screen.findByRole('button', { name: 'critic' })).not.toBeNull()
  })

  it('saves identity, SOUL, independent model, skills, and tools by profile', async () => {
    const calls = fixture()
    render(<StudioView api={calls.api} />)
    await waitFor(() => expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('Engineer'))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Lead engineer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save identity' }))
    fireEvent.change(screen.getByLabelText('SOUL'), { target: { value: '# Senior Atlas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save SOUL' }))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }))
    fireEvent.click(screen.getByLabelText('browser'))
    fireEvent.click(screen.getByRole('button', { name: 'Save skills' }))
    fireEvent.change(screen.getByLabelText('Toolsets'), { target: { value: 'terminal,browser' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save tools' }))

    await waitFor(() => expect(calls.updateMember).toHaveBeenCalledWith('atlas', expect.objectContaining({ role: 'Lead engineer' })))
    expect(calls.updateSoul).toHaveBeenCalledWith('atlas', '# Senior Atlas')
    expect(calls.updateModel).toHaveBeenCalledWith('atlas', 'openai', 'gpt-5.6-codex')
    expect(calls.updateSkills).toHaveBeenCalledWith('atlas', ['react', 'browser'])
    expect(calls.updateToolsets).toHaveBeenCalledWith('atlas', ['terminal', 'browser'])
  })

  it('keeps classifier off by default and saves per-channel activation', async () => {
    const calls = fixture()
    render(<StudioView api={calls.api} />)
    await waitFor(() => expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('Engineer'))
    expect((screen.getByLabelText('Use classifier') as HTMLInputElement).checked).toBe(false)
    fireEvent.change(screen.getByLabelText('Activation in #general'), { target: { value: 'mentioned' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save behavior' }))
    await waitFor(() => expect(calls.updateChannelMember).toHaveBeenCalledWith('channel-1', 'atlas', 'mentioned'))
    expect(calls.updateClassifier).toHaveBeenCalledWith('channel-1', expect.objectContaining({ enabled: false }))
  })

  it('keeps Scout on Gemini and narrows its channel project access independently', async () => {
    const calls = fixture()
    render(<StudioView api={calls.api} />)
    await screen.findByRole('button', { name: 'scout' })
    fireEvent.click(screen.getByRole('button', { name: 'scout' }))
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('google'))
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemini-2.5-pro')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-2.5-flash' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }))
    await waitFor(() => expect(calls.updateModel).toHaveBeenCalledWith('scout', 'google', 'gemini-2.5-flash'))
    await screen.findByRole('option', { name: 'Web' })
    fireEvent.change(screen.getByLabelText('Default project'), { target: { value: 'p-web' } })
    fireEvent.click(screen.getByLabelText('Allow Web in #general'))
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }))

    await waitFor(() => expect(calls.patchChannel).toHaveBeenCalledWith('channel-1', { allowedProjects: ['p-web'] }))
    expect(calls.updateMember).toHaveBeenCalledWith('scout', expect.objectContaining({ defaultProject: expect.objectContaining({ projectId: 'p-web' }) }))
  })

  it('keeps the selected member editor mounted when its model metadata changes', async () => {
    const calls = fixture()
    let scoutLoads = 0
    vi.mocked(calls.api.getMember).mockImplementation(async (name) => {
      if (name === 'scout' && ++scoutLoads > 1) {
        return new Promise(() => undefined)
      }
      return {
        profileId: name,
        displayName: name,
        role: name === 'atlas' ? 'Engineer' : 'Researcher',
        color: null,
        avatar: null,
        defaultProject: null,
        archived: false,
      }
    })
    type SavedProfile = Awaited<ReturnType<typeof calls.updateModel>>
    let resolveModel!: (profile: SavedProfile | PromiseLike<SavedProfile>) => void
    calls.updateModel.mockImplementation(
      () => new Promise((resolve) => { resolveModel = resolve }),
    )
    render(<StudioView api={calls.api} />)
    await screen.findByRole('button', { name: 'scout' })
    fireEvent.click(screen.getByRole('button', { name: 'scout' }))
    await screen.findByLabelText('Default project')
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gemini-2.5-flash' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }))
    await waitFor(() => expect(calls.updateModel).toHaveBeenCalledOnce())

    await act(async () => {
      resolveModel({ ...scout, provider: 'google', model: 'gemini-2.5-flash' })
      await Promise.resolve()
    })

    expect(screen.getByLabelText('Default project')).not.toBeNull()
    expect(scoutLoads).toBe(1)
  })

  it('shows readiness errors without rendering credential values', async () => {
    const calls = fixture()
    render(<StudioView api={calls.api} readiness={async () => ({ ready: false, reason: 'Provider is not configured', source: 'runtime_check', checksDisagree: false })} />)
    expect(await screen.findByText('Provider is not configured')).not.toBeNull()
    expect(screen.queryByText(/sk-[A-Za-z0-9]/)).toBeNull()
  })
})
