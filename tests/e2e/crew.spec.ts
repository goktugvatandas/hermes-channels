import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginRest } from '@hermes/plugin-sdk'
import { CrewApi } from '../../src/desktop/api'
import type { CrewChannel, CrewMessage, HermesProfile, ProjectRef } from '../../src/desktop/types'
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
    skillCount: 2,
    description: 'Engineer',
  },
  {
    name: 'scout',
    path: '/profiles/scout',
    isDefault: false,
    gatewayRunning: true,
    provider: 'google',
    model: 'gemini-2.5-pro',
    hasEnv: true,
    skillCount: 1,
    description: 'Researcher',
  },
]

const channel: CrewChannel = {
  id: 'channel-general',
  name: 'general',
  purpose: 'General work',
  topic: '',
  defaultResponderProfile: 'atlas',
  defaultProject: { mode: 'global' },
  allowedProjects: [],
  routingRules: {},
  createdAt: 1,
  updatedAt: 1,
}

afterEach(cleanup)

describe('Hermes Crew user journey', () => {
  it('loads a channel and sends a project-scoped message to a tagged specialist', async () => {
    const messages: CrewMessage[] = []
    const requests: Array<{ path: string; body?: unknown }> = []
    const rest = vi.fn(async (path: string, options?: { body?: unknown }) => {
      requests.push({ path, body: options?.body })
      if (path === '/channels') return [channel]
      if (path === '/profiles') return profiles
      if (path === '/events?after=0') return []
      if (path === `/channels/${channel.id}/members`) {
        return profiles.map((profile) => ({
          channelId: channel.id,
          profileId: profile.name,
          activationPolicy: profile.name === 'atlas' ? 'always' : 'mentioned',
        }))
      }
      if (path === `/channels/${channel.id}/messages` && !options?.body) return [...messages]
      if (path === '/projects?profile=atlas') {
        return [{ id: 'p-web', name: 'Web', primaryPath: '/work/web', archived: false }]
      }
      if (path === `/channels/${channel.id}/messages` && options?.body) {
        const body = options.body as {
          content: string
          mentions: string[]
          project: ProjectRef
        }
        const message: CrewMessage = {
          id: 'message-web',
          channelId: channel.id,
          rootMessageId: null,
          authorType: 'user',
          authorProfileId: null,
          content: body.content,
          mentions: body.mentions,
          project: body.project,
          modelLabel: null,
          createdAt: 2,
        }
        messages.push(message)
        return { message, turnIds: ['turn-atlas', 'turn-scout'] }
      }
      if (path === '/threads/message-web') return messages
      throw new Error(`Unexpected Crew API request: ${path}`)
    }) as unknown as PluginRest
    const api = new CrewApi(rest)

    render(createElement(CrewPage, { api }))
    // The Crew page lands on the Home operational center; open the #general workspace.
    fireEvent.click(await screen.findByRole('button', { name: /#general/ }))
    await screen.findByRole('heading', { name: '#general' })
    const composer = screen.getByRole('form', { name: 'Channel message' })
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
    fireEvent.change(within(composer).getByLabelText('Message'), {
      target: { value: '@scout Inspect the failing web flow' },
    })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))

    await screen.findByText(/Inspect the failing web flow/)
    expect(screen.getAllByText('Web').length).toBeGreaterThan(0)
    await waitFor(() => {
      const sent = requests.find(
        (request) => request.path === `/channels/${channel.id}/messages` && request.body,
      )
      expect(sent?.body).toEqual(
        expect.objectContaining({
          content: '@scout Inspect the failing web flow',
          mentions: ['scout'],
          rootMessageId: null,
          project: {
            mode: 'project',
            profile: 'atlas',
            projectId: 'p-web',
            label: 'Web',
            cwd: '/work/web',
          },
        }),
      )
    })
    expect(within(composer).queryByTitle('Change project scope')).toBeNull()
  })
})
