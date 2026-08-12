import type { PluginRest, PluginRestOptions } from '@hermes/plugin-sdk'

import type {
  CrewChannel,
  CrewMember,
  CrewMessage,
  ChannelMember,
  ClassifierConfig,
  EventFrame,
  HermesProfile,
  MessageReceipt,
  ProjectRef,
  SkillState,
} from './types'

const MUTATION_TIMEOUT_MS = 30_000

export class CrewApi {
  constructor(private readonly rest: PluginRest) {}

  private request<T>(path: string, options?: PluginRestOptions): Promise<T> {
    return this.rest<T>(path, options)
  }

  private mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method, body, timeoutMs: MUTATION_TIMEOUT_MS })
  }

  health(): Promise<{ ok: boolean; service: string }> {
    return this.request('/health')
  }

  listChannels(): Promise<CrewChannel[]> {
    return this.request('/channels')
  }

  createChannel(body: Record<string, unknown>): Promise<CrewChannel> {
    return this.mutate('/channels', 'POST', body)
  }

  patchChannel(id: string, body: Record<string, unknown>): Promise<CrewChannel> {
    return this.mutate(`/channels/${encodeURIComponent(id)}`, 'PATCH', body)
  }

  listMessages(channelId: string): Promise<CrewMessage[]> {
    return this.request(`/channels/${encodeURIComponent(channelId)}/messages`)
  }

  createMessage(
    channelId: string,
    body: {
      content: string
      idempotencyKey: string
      mentions?: string[]
      rootMessageId?: string | null
      project?: ProjectRef
      attachments?: Array<Record<string, unknown>>
    },
  ): Promise<MessageReceipt> {
    return this.mutate(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      'POST',
      body,
    )
  }

  getThread(rootMessageId: string): Promise<CrewMessage[]> {
    return this.request(`/threads/${encodeURIComponent(rootMessageId)}`)
  }

  listProfiles(): Promise<HermesProfile[]> {
    return this.request('/profiles')
  }

  createProfile(body: Record<string, unknown>): Promise<HermesProfile> {
    return this.mutate('/profiles', 'POST', body)
  }

  updateProfile(name: string, body: { description: string }): Promise<HermesProfile> {
    return this.mutate(`/profiles/${encodeURIComponent(name)}`, 'PATCH', body)
  }

  getSoul(name: string): Promise<{ content: string }> {
    return this.request(`/profiles/${encodeURIComponent(name)}/soul`)
  }

  updateSoul(name: string, content: string): Promise<{ content: string }> {
    return this.mutate(`/profiles/${encodeURIComponent(name)}/soul`, 'PUT', { content })
  }

  updateModel(name: string, provider: string, model: string): Promise<HermesProfile> {
    return this.mutate(`/profiles/${encodeURIComponent(name)}/model`, 'PUT', { provider, model })
  }

  listSkills(name: string): Promise<SkillState[]> {
    return this.request(`/profiles/${encodeURIComponent(name)}/skills`)
  }

  updateSkills(name: string, enabled: string[]): Promise<SkillState[]> {
    return this.mutate(`/profiles/${encodeURIComponent(name)}/skills`, 'PUT', { enabled })
  }

  getToolsets(name: string): Promise<{ enabled: string[] }> {
    return this.request(`/profiles/${encodeURIComponent(name)}/toolsets`)
  }

  updateToolsets(name: string, enabled: string[]): Promise<{ enabled: string[] }> {
    return this.mutate(`/profiles/${encodeURIComponent(name)}/toolsets`, 'PUT', { enabled })
  }

  getMember(name: string): Promise<CrewMember> {
    return this.request(`/members/${encodeURIComponent(name)}`)
  }

  updateMember(name: string, body: Record<string, unknown>): Promise<CrewMember> {
    return this.mutate(`/members/${encodeURIComponent(name)}`, 'PATCH', body)
  }

  listChannelMembers(channelId: string): Promise<ChannelMember[]> {
    return this.request(`/channels/${encodeURIComponent(channelId)}/members`)
  }

  updateChannelMember(
    channelId: string,
    profileId: string,
    activationPolicy: ChannelMember['activationPolicy'],
  ): Promise<ChannelMember> {
    return this.mutate(
      `/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(profileId)}`,
      'PUT',
      { activationPolicy },
    )
  }

  getClassifier(channelId: string): Promise<ClassifierConfig> {
    return this.request(`/channels/${encodeURIComponent(channelId)}/classifier`)
  }

  updateClassifier(channelId: string, body: ClassifierConfig): Promise<ClassifierConfig> {
    return this.mutate(`/channels/${encodeURIComponent(channelId)}/classifier`, 'PUT', body)
  }

  listProjects(profile: string): Promise<Array<Record<string, unknown>>> {
    return this.request(`/projects?profile=${encodeURIComponent(profile)}`)
  }

  events(after = 0): Promise<EventFrame[]> {
    return this.request(`/events?after=${after}`)
  }

  cancelTurn(turnId: string): Promise<Record<string, unknown>> {
    return this.mutate(`/turns/${encodeURIComponent(turnId)}/cancel`, 'POST')
  }

  retryTurn(turnId: string): Promise<Record<string, unknown>> {
    return this.mutate(`/turns/${encodeURIComponent(turnId)}/retry`, 'POST')
  }

  resolveApproval(
    approvalId: string,
    body: { decision: 'approve' | 'reject'; note: string },
  ): Promise<Record<string, unknown>> {
    return this.mutate(
      `/approvals/${encodeURIComponent(approvalId)}/resolve`,
      'POST',
      body,
    )
  }
}
