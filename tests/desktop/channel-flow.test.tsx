import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import type { CrewChannel, CrewMessage, HermesProfile } from '../../src/desktop/types'
import { CrewPage } from '../../src/desktop/views/crew-page'

const profiles: HermesProfile[] = [
  {
    name: 'atlas',
    path: '/profiles/atlas',
    isDefault: false,
    gatewayRunning: true,
    provider: 'openai',
    model: 'gpt-5.6',
    hasEnv: true,
    skillCount: 4,
    description: 'Software engineer',
  },
  {
    name: 'critic',
    path: '/profiles/critic',
    isDefault: false,
    gatewayRunning: true,
    provider: 'google',
    model: 'gemini-2.5-pro',
    hasEnv: true,
    skillCount: 2,
    description: 'Reviewer',
  },
]

const channel: CrewChannel = {
  id: 'channel-1',
  name: 'general',
  purpose: 'General work',
  topic: '',
  defaultResponderProfile: 'atlas',
  defaultProject: null,
  allowedProjects: [],
  routingRules: {},
  createdAt: 1,
  updatedAt: 1,
}

const rootMessage: CrewMessage = {
  id: 'message-1',
  channelId: channel.id,
  rootMessageId: null,
  authorType: 'user',
  authorProfileId: null,
  content: 'Please inspect the web app',
  mentions: ['atlas'],
  project: {
    mode: 'project',
    profile: 'atlas',
    projectId: 'p-web',
    label: 'Web',
    cwd: '/work/web',
  },
  modelLabel: null,
  createdAt: 2,
}

afterEach(cleanup)

function apiFixture() {
  const createChannel = vi.fn(async () => ({ ...channel, id: 'channel-2', name: 'builds' }))
  const createMessage = vi.fn(async (_channelId: string, body: Record<string, unknown>) => ({
    message: { ...rootMessage, id: 'message-new', content: String(body.content) },
    turnIds: ['turn-1'],
  }))
  return {
    api: {
      listChannels: vi.fn(async () => [channel]),
      listProfiles: vi.fn(async () => profiles),
      listMessages: vi.fn(async () => [rootMessage]),
      listProjects: vi.fn(async () => [
        { id: 'p-web', name: 'Web', primaryPath: '/work/web', archived: false },
      ]),
      getThread: vi.fn(async () => [rootMessage]),
      createChannel,
      createMessage,
    } as unknown as CrewApi,
    createChannel,
    createMessage,
  }
}

describe('channel flow', () => {
  it('creates a channel with a default responder and all profiles as members', async () => {
    const { api, createChannel } = apiFixture()
    render(<CrewPage api={api} />)

    await screen.findByRole('button', { name: '#general' })
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'builds' } })
    fireEvent.change(screen.getByLabelText('Default responder'), { target: { value: 'atlas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() =>
      expect(createChannel).toHaveBeenCalledWith({
        name: 'builds',
        defaultResponderProfile: 'atlas',
        members: [
          { profileId: 'atlas', activationPolicy: 'always' },
          { profileId: 'critic', activationPolicy: 'mentioned' },
        ],
      }),
    )
    expect(await screen.findByRole('button', { name: '#builds' })).not.toBeNull()
  })

  it('sends mentions with one-message project scope and resets the top-level picker', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} />)
    await screen.findByText('Please inspect the web app')

    const composer = screen.getByRole('form', { name: 'Channel message' })
    fireEvent.change(within(composer).getByLabelText('Message'), {
      target: { value: 'Review this implementation' },
    })
    fireEvent.click(within(composer).getByRole('button', { name: '@all' }))
    fireEvent.change(within(composer).getByLabelText('Project scope'), {
      target: { value: 'project' },
    })
    fireEvent.change(within(composer).getByLabelText('Project profile'), {
      target: { value: 'atlas' },
    })
    await within(composer).findByRole('option', { name: 'Web' })
    fireEvent.change(within(composer).getByLabelText('Hermes project'), {
      target: { value: 'p-web' },
    })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(createMessage).toHaveBeenCalledWith(
        channel.id,
        expect.objectContaining({
          content: 'Review this implementation',
          mentions: ['atlas', 'critic'],
          rootMessageId: null,
          project: {
            mode: 'project',
            profile: 'atlas',
            projectId: 'p-web',
            label: 'Web',
            cwd: '/work/web',
          },
        }),
      ),
    )
    expect((within(composer).getByLabelText('Project scope') as HTMLSelectElement).value).toBe('inherit')
    expect((within(composer).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('')
  })

  it('opens a thread and keeps the root message project on replies', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} />)
    await screen.findByText('Please inspect the web app')

    fireEvent.click(screen.getByRole('button', { name: 'Reply to message' }))
    const thread = await screen.findByRole('complementary', { name: 'Thread' })
    expect(within(thread).getAllByText('Web').length).toBeGreaterThan(0)
    fireEvent.change(within(thread).getByLabelText('Message'), {
      target: { value: 'I found the issue' },
    })
    fireEvent.click(within(thread).getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(createMessage).toHaveBeenCalledWith(
        channel.id,
        expect.objectContaining({
          content: 'I found the issue',
          rootMessageId: rootMessage.id,
          project: rootMessage.project,
        }),
      ),
    )
  })
})
