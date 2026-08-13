import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import type { TurnSummary } from '../../src/desktop/conversation-model'
import { MessageList } from '../../src/desktop/components/message-list'
import { CrewComposer } from '../../src/desktop/components/crew-composer'
import { PresentationContext } from '../../src/desktop/presentation'
import type { CrewChannel, CrewMessage, HermesProfile, MessageReceipt } from '../../src/desktop/types'
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

const agentMessage: CrewMessage = {
  ...rootMessage,
  id: 'message-agent',
  authorType: 'agent',
  authorProfileId: 'atlas',
  content: 'The agent reply is now visible.',
  mentions: [],
  createdAt: 3,
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
      getMember: vi.fn(async (name: string) => ({
        profileId: name,
        displayName: name,
        role: '',
        avatar: null,
        color: null,
        defaultProject: null,
        archived: false,
      })),
      listMessages: vi.fn(async () => [rootMessage]),
      listProjects: vi.fn(async () => [
        { id: 'p-web', name: 'Web', primaryPath: '/work/web', archived: false },
      ]),
      getThread: vi.fn(async () => [rootMessage]),
      events: vi.fn(async () => []),
      createChannel,
      createMessage,
      listMembers: vi.fn(async () => []),
      getMe: vi.fn(async () => ({ displayName: 'You', avatar: null, color: null })),
      imageGenerationStatus: vi.fn(async () => ({ available: false, provider: null })),
    } as unknown as CrewApi,
    createChannel,
    createMessage,
  }
}

describe('channel flow', () => {
  it('shows channel identity, resolved project, and participating agents in one header', async () => {
    const { api } = apiFixture()
    vi.mocked(api.listChannels).mockResolvedValue([{ ...channel, defaultProject: rootMessage.project }])

    render(<CrewPage api={api} initialView="channels" />)

    await screen.findByRole('region', { name: '#general' })
    const header = screen.getByRole('banner', { name: 'Channel header' })
    expect(within(header).getByText('#general')).not.toBeNull()
    expect(within(header).getByText('Web')).not.toBeNull()
    expect(within(header).getByLabelText('Atlas')).not.toBeNull()
  })

  it('opens members and summarized activity from channel details', async () => {
    const { api } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    await screen.findByRole('region', { name: '#general' })

    fireEvent.click(screen.getByRole('button', { name: 'Channel details' }))

    const details = await screen.findByRole('complementary', { name: 'Channel details' })
    expect(within(details).getByRole('region', { name: 'Crew members' })).not.toBeNull()
    expect(within(details).getByRole('region', { name: 'Activity' })).not.toBeNull()
  })

  it('shows a working indicator in the thread for turns it starts', async () => {
    const { api } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reply in thread' }))
    const thread = await screen.findByRole('complementary', { name: 'Thread' })

    fireEvent.change(within(thread).getByLabelText('Message'), { target: { value: 'Continue please' } })
    fireEvent.click(within(thread).getByRole('button', { name: 'Send' }))

    expect(await within(thread).findByText('is working…')).not.toBeNull()
  })

  it('sends once when Enter repeats faster than state commits', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    await screen.findByText(rootMessage.content)
    const composer = screen.getByRole('form', { name: 'Channel message' })
    const field = within(composer).getByLabelText('Message')

    fireEvent.change(field, { target: { value: 'Only once please' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(1))
  })

  it('resolves mentions with relaxed boundaries, including "(@Name" and trailing commas', async () => {
    const { api, createMessage } = apiFixture()
    render(
      <PresentationContext.Provider value={{ members: {}, me: { displayName: 'You', avatar: null, color: null } }}>
        <CrewComposer api={api} channelId={channel.id} onSent={vi.fn()} profiles={profiles} />
      </PresentationContext.Provider>,
    )

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '(@atlas please, and @critic, review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(createMessage).toHaveBeenCalledWith(
      channel.id,
      expect.objectContaining({ mentions: ['atlas', 'critic'] }),
    ))
  })

  it('resolves display-name handles to profile mentions', async () => {
    const { api, createMessage } = apiFixture()
    const seliel = {
      profileId: 'atlas', displayName: 'Seliel', role: '', avatar: null, color: null,
      defaultProject: null, archived: false,
    }
    render(
      <PresentationContext.Provider value={{ members: { atlas: seliel }, me: { displayName: 'You', avatar: null, color: null } }}>
        <CrewComposer api={api} channelId={channel.id} onSent={vi.fn()} profiles={profiles} />
      </PresentationContext.Provider>,
    )

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '@Seliel please review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(createMessage).toHaveBeenCalledWith(
      channel.id,
      expect.objectContaining({ content: '@Seliel please review', mentions: ['atlas'] }),
    ))
  })

  it('moves focus into the thread and restores it to the source message', async () => {
    const { api } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    const reply = await screen.findByRole('button', { name: 'Reply in thread' })

    fireEvent.click(reply)

    expect(document.activeElement).toBe(await screen.findByRole('heading', { name: 'Thread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close thread' }))
    expect(document.activeElement).toBe(reply)
  })

  it('marks the thread drawer as reduced-motion safe', async () => {
    const { api } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reply in thread' }))
    expect(screen.getByRole('complementary', { name: 'Thread' }).className).toContain('motion-reduce:transition-none')
  })

  it('renders flat grouped message rows with keyboard-reachable actions', () => {
    const second = { ...agentMessage, id: 'message-agent-2', content: 'A follow-up', createdAt: 4 }

    render(<MessageList messages={[agentMessage, second]} pendingTurns={[]} profiles={profiles} />)

    const items = screen.getAllByRole('listitem')
    expect(items[0].getAttribute('data-group-start')).toBe('true')
    expect(items[1].getAttribute('data-group-start')).toBe('false')
    expect(items[0].className).not.toContain('border')
    expect(within(items[0]).getByRole('button', { name: 'Copy message' })).not.toBeNull()
  })

  it('shows a thread summary without rendering replies in the channel timeline', () => {
    const onReply = vi.fn()
    const reply = { ...agentMessage, id: 'reply-1', rootMessageId: rootMessage.id }

    render(<MessageList messages={[rootMessage, reply]} onReply={onReply} pendingTurns={[]} profiles={profiles} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '1 reply' }))
    expect(onReply).toHaveBeenCalledWith(rootMessage)
  })

  it('keeps thread replies available to the channel summary', async () => {
    const { api } = apiFixture()
    const reply = { ...agentMessage, id: 'reply-1', rootMessageId: rootMessage.id }
    vi.mocked(api.listMessages).mockResolvedValue([rootMessage, reply])

    render(<CrewPage api={api} initialView="channels" />)

    expect(await screen.findByRole('button', { name: '1 reply' })).not.toBeNull()
    expect(screen.getAllByRole('listitem').filter((item) => item.getAttribute('data-group-start'))).toHaveLength(1)
  })

  it('shows one stable pending row and a useful empty state', () => {
    const pending: TurnSummary = {
      turnId: 'turn-atlas', profileId: 'atlas', state: 'streaming',
      events: [], messageId: null, terminal: false, sessionId: null,
      triggerMessageId: null, triggerExcerpt: null,
    }
    const { rerender } = render(<MessageList messages={[]} pendingTurns={[pending]} profiles={profiles} />)
    expect(screen.getAllByText('is working…')).toHaveLength(1)

    rerender(<MessageList messages={[]} pendingTurns={[]} profiles={profiles} />)
    expect(screen.getByText(/mention an agent/i)).not.toBeNull()
  })

  it('renders a dedicated route as a standalone channel and reports it visible', async () => {
    const { api } = apiFixture()
    const onChannelViewed = vi.fn()
    vi.mocked(api.listChannels).mockResolvedValue([
      channel,
      { ...channel, id: 'research', name: 'research' },
    ])

    render(
      <CrewPage api={api} initialChannelId="research" onChannelViewed={onChannelViewed} />,
    )

    expect(await screen.findByRole('region', { name: '#research' })).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Hermes Crew' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Crew channels' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Agent Lab' })).toBeNull()
    await waitFor(() => expect(onChannelViewed).toHaveBeenLastCalledWith('research'))
  })

  it('switches the standalone surface when Hermes reuses it for another channel route', async () => {
    const { api } = apiFixture()
    const testChannel = { ...channel, id: 'test-channel', name: 'test' }
    vi.mocked(api.listChannels).mockResolvedValue([channel, testChannel])
    const { rerender } = render(<CrewPage api={api} initialChannelId={channel.id} />)
    await screen.findByRole('region', { name: '#general' })

    rerender(<CrewPage api={api} initialChannelId={testChannel.id} />)

    expect(await screen.findByRole('region', { name: '#test' })).not.toBeNull()
    expect(screen.queryByRole('region', { name: '#general' })).toBeNull()
  })

  it('clears channel visibility in Search and returns native navigation to Crew root', async () => {
    const { api } = apiFixture()
    const onChannelViewed = vi.fn()
    const onNavigateChannel = vi.fn()
    render(
      <CrewPage
        api={api}
        initialView="channels"
        onChannelViewed={onChannelViewed}
        onNavigateChannel={onNavigateChannel}
      />,
    )
    await screen.findByText(rootMessage.content)

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))

    await waitFor(() => expect(onChannelViewed).toHaveBeenLastCalledWith(null))
    expect(onNavigateChannel).toHaveBeenCalledWith(null)
  })

  it('keeps channel selection inside the Crew surface without native navigation', async () => {
    const { api } = apiFixture()
    const onNavigateChannel = vi.fn()
    vi.mocked(api.listChannels).mockResolvedValue([
      channel,
      { ...channel, id: 'research', name: 'research' },
    ])
    render(<CrewPage api={api} initialView="channels" onNavigateChannel={onNavigateChannel} />)

    fireEvent.click(await screen.findByRole('button', { name: '#research' }))

    expect(await screen.findByRole('region', { name: '#research' })).not.toBeNull()
    expect(onNavigateChannel).not.toHaveBeenCalledWith('research')
  })

  it('publishes a created channel to the sidebar and opens it inside Crew', async () => {
    const { api } = apiFixture()
    const onChannelCreated = vi.fn()
    const onNavigateChannel = vi.fn()
    render(
      <CrewPage
        api={api}
        initialView="channels"
        onChannelCreated={onChannelCreated}
        onNavigateChannel={onNavigateChannel}
      />,
    )
    await screen.findByRole('button', { name: '#general' })
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'builds' } })
    fireEvent.change(screen.getByLabelText('Default responder'), { target: { value: 'atlas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    const created = { ...channel, id: 'channel-2', name: 'builds' }
    await waitFor(() => expect(onChannelCreated).toHaveBeenCalledWith(created))
    expect(await screen.findByRole('region', { name: '#builds' })).not.toBeNull()
    expect(onNavigateChannel).not.toHaveBeenCalledWith(created.id)
  })

  it('falls back to Crew root when a dedicated route channel is missing', async () => {
    const { api } = apiFixture()
    const onNavigateChannel = vi.fn()

    render(
      <CrewPage
        api={api}
        initialView="channels"
        initialChannelId="deleted-channel"
        onNavigateChannel={onNavigateChannel}
      />,
    )

    expect(await screen.findByRole('region', { name: '#general' })).not.toBeNull()
    expect(onNavigateChannel).toHaveBeenCalledWith(null)
  })

  it('shows an agent message after its completed turn reaches the event journal', async () => {
    const { api } = apiFixture()
    let resolveEvents!: (events: Awaited<ReturnType<CrewApi['events']>>) => void
    vi.mocked(api.listMessages)
      .mockResolvedValueOnce([rootMessage])
      .mockResolvedValue([rootMessage, agentMessage])
    vi.mocked(api.events).mockImplementation(() => new Promise((resolve) => {
      resolveEvents = resolve
    }))

    render(<CrewPage api={api} initialView="channels" />)
    await screen.findByText(rootMessage.content)
    await act(async () => resolveEvents([{
      sequence: 9,
      type: 'completed',
      channelId: channel.id,
      turnId: 'turn-1',
      payload: { messageId: agentMessage.id },
    }]))

    expect(await screen.findByText('The agent reply is now visible.')).not.toBeNull()
  })

  it('creates a channel with a default responder and all profiles as members', async () => {
    const { api, createChannel } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)

    await screen.findByRole('button', { name: '#general' })
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'builds' } })
    fireEvent.change(screen.getByLabelText('Default responder'), { target: { value: 'atlas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() =>
      expect(createChannel).toHaveBeenCalledWith({
        name: 'builds',
        purpose: '',
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
    render(<CrewPage api={api} initialView="channels" />)
    await screen.findByText('Please inspect the web app')

    const composer = screen.getByRole('form', { name: 'Channel message' })
    fireEvent.change(within(composer).getByLabelText('Message'), {
      target: { value: '@all Review this implementation' },
    })
    fireEvent.click(within(composer).getByRole('button', { name: 'Choose project scope' }))
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
          content: '@all Review this implementation',
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
    // Reset to inherit removes the scope chip from the footer.
    expect(within(composer).queryByTitle('Change project scope')).toBeNull()
    expect((within(composer).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('')
  })

  it('sends with Enter and keeps Shift+Enter available for multiline input', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    const composer = await screen.findByRole('form', { name: 'Channel message' })
    const textarea = within(composer).getByLabelText('Message') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Ship it' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce())

    fireEvent.change(textarea, { target: { value: 'Line one' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(createMessage).toHaveBeenCalledOnce()
    expect(textarea.value).toBe('Line one')
  })

  it('selects filtered mention suggestions with the keyboard', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    const textarea = await screen.findByLabelText('Message') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '@cr' } })
    expect(screen.getByRole('option', { name: '@critic' })).not.toBeNull()
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('@critic ')

    fireEvent.change(textarea, { target: { value: '@critic review this' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(createMessage).toHaveBeenCalledWith(channel.id, expect.objectContaining({ mentions: ['critic'] })))
  })

  it('restores drafts and timeline position when returning to a channel', async () => {
    const { api } = apiFixture()
    vi.mocked(api.listChannels).mockResolvedValue([channel, { ...channel, id: 'research', name: 'research' }])
    render(<CrewPage api={api} initialView="channels" />)
    const textarea = await screen.findByLabelText('Message') as HTMLTextAreaElement
    const timeline = screen.getByRole('list', { name: 'Messages' })

    fireEvent.change(textarea, { target: { value: 'general draft' } })
    timeline.scrollTop = 420
    fireEvent.scroll(timeline)
    fireEvent.click(screen.getByRole('button', { name: '#research' }))
    await screen.findByRole('region', { name: '#research' })
    fireEvent.click(screen.getByRole('button', { name: '#general' }))
    await screen.findByRole('region', { name: '#general' })

    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('general draft')
    expect(screen.getByRole('list', { name: 'Messages' }).scrollTop).toBe(420)
  })

  it('retries a failed message with its original idempotency key', async () => {
    const { api, createMessage } = apiFixture()
    createMessage.mockRejectedValueOnce(new Error('Offline'))
    render(<CrewPage api={api} initialView="channels" />)
    const composer = await screen.findByRole('form', { name: 'Channel message' })

    fireEvent.change(within(composer).getByLabelText('Message'), { target: { value: 'Retry me' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))
    fireEvent.click(await within(composer).findByRole('button', { name: 'Retry message' }))

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2))
    expect(createMessage.mock.calls[0][1].idempotencyKey).toBe(createMessage.mock.calls[1][1].idempotencyKey)
  })

  it('shows a user message before the backend receipt resolves', async () => {
    const { api, createMessage } = apiFixture()
    createMessage.mockImplementation(() => new Promise(() => undefined))
    render(<CrewPage api={api} initialView="channels" />)
    const composer = await screen.findByRole('form', { name: 'Channel message' })

    fireEvent.change(within(composer).getByLabelText('Message'), { target: { value: 'Visible immediately' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))

    const timeline = screen.getByRole('list', { name: 'Messages' })
    expect(within(timeline).getByText('Visible immediately')).not.toBeNull()
    expect(within(timeline).getByText('Sending…')).not.toBeNull()
  })

  it('shows one pending agent row from the receipt and removes it with the persisted response', async () => {
    const { api, createMessage } = apiFixture()
    let resolveReceipt!: (receipt: MessageReceipt) => void
    let resolveEvents!: (events: Awaited<ReturnType<CrewApi['events']>>) => void
    createMessage.mockImplementation(() => new Promise((resolve) => { resolveReceipt = resolve }))
    vi.mocked(api.events).mockImplementation(() => new Promise((resolve) => { resolveEvents = resolve }))
    vi.mocked(api.listMessages)
      .mockResolvedValueOnce([rootMessage])
      .mockResolvedValue([rootMessage, agentMessage])
    render(<CrewPage api={api} initialView="channels" />)
    const composer = await screen.findByRole('form', { name: 'Channel message' })

    fireEvent.change(within(composer).getByLabelText('Message'), { target: { value: 'Inspect this' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))
    await act(async () => resolveReceipt({ message: { ...rootMessage, id: 'sent-message', content: 'Inspect this' }, turnIds: ['turn-atlas'] }))
    expect(screen.getAllByText('is working…')).toHaveLength(1)

    await act(async () => resolveEvents([{
      sequence: 10,
      type: 'completed',
      channelId: channel.id,
      turnId: 'turn-atlas',
      payload: { profileId: 'atlas', messageId: agentMessage.id },
    }]))
    expect(await screen.findByText(agentMessage.content)).not.toBeNull()
    expect(screen.queryByText('is working…')).toBeNull()
  })

  it('reconciles a completion received before its delayed message receipt', async () => {
    const { api, createMessage } = apiFixture()
    let resolveReceipt!: (receipt: MessageReceipt) => void
    let resolveEvents!: (events: Awaited<ReturnType<CrewApi['events']>>) => void
    createMessage.mockImplementation(() => new Promise((resolve) => { resolveReceipt = resolve }))
    vi.mocked(api.events).mockImplementation(() => new Promise((resolve) => { resolveEvents = resolve }))
    vi.mocked(api.listMessages)
      .mockResolvedValueOnce([rootMessage])
      .mockResolvedValue([rootMessage, agentMessage])
    render(<CrewPage api={api} initialView="channels" />)
    const composer = await screen.findByRole('form', { name: 'Channel message' })
    fireEvent.change(within(composer).getByLabelText('Message'), { target: { value: 'Inspect this' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))

    await act(async () => resolveEvents([{
      sequence: 10,
      type: 'completed',
      channelId: channel.id,
      turnId: 'turn-atlas',
      payload: { profileId: 'atlas', messageId: agentMessage.id },
    }]))
    await act(async () => resolveReceipt({ message: { ...rootMessage, id: 'sent-message', content: 'Inspect this' }, turnIds: ['turn-atlas'] }))

    expect(await screen.findByText(agentMessage.content)).not.toBeNull()
    expect(screen.queryByText('is working…')).toBeNull()
  })

  it('opens a thread and keeps the root message project on replies', async () => {
    const { api, createMessage } = apiFixture()
    render(<CrewPage api={api} initialView="channels" />)
    await screen.findByText('Please inspect the web app')

    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }))
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
