import type { PluginRest, PluginRestOptions } from '@hermes/plugin-sdk'

import type {
  AvatarGenerateOptions,
  ChannelSections,
  CrewChannel,
  CrewMember,
  CrewMessage,
  ChannelMember,
  ClassifierConfig,
  EventFrame,
  HermesProfile,
  ImageGenerationStatus,
  MessageReceipt,
  ProjectRef,
  SessionTranscript,
  SkillState,
  RoutingRulesConfig,
  SearchResult,
  UserIdentity,
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

  onboard(body: {
    defaultResponderProfile: string
    profiles: string[]
  }): Promise<CrewChannel> {
    return this.mutate('/onboarding', 'POST', body)
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

  getSessionTranscript(sessionId: string): Promise<SessionTranscript> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/transcript`)
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

  listMembers(): Promise<CrewMember[]> {
    return this.request('/members')
  }

  imageGenerationStatus(): Promise<ImageGenerationStatus> {
    return this.request('/image-generation')
  }

  generateMemberAvatar(name: string, options?: AvatarGenerateOptions): Promise<CrewMember> {
    // Image backends routinely take a minute; give them room.
    return this.request(`/members/${encodeURIComponent(name)}/avatar/generate`, {
      method: 'POST',
      body: options || {},
      timeoutMs: 180_000,
    })
  }

  generateMyAvatar(options?: AvatarGenerateOptions): Promise<UserIdentity> {
    return this.request('/me/avatar/generate', {
      method: 'POST',
      body: options || {},
      timeoutMs: 180_000,
    })
  }

  getChannelSections(): Promise<ChannelSections> {
    return this.request('/channel-sections')
  }

  putChannelSections(body: ChannelSections): Promise<ChannelSections> {
    return this.mutate('/channel-sections', 'PUT', body)
  }

  getRoutingDefaults(): Promise<RoutingRulesConfig> {
    return this.request('/routing-defaults')
  }

  updateRoutingDefaults(body: Partial<RoutingRulesConfig>): Promise<RoutingRulesConfig> {
    return this.mutate('/routing-defaults', 'PUT', body)
  }

  getMe(): Promise<UserIdentity> {
    return this.request('/me')
  }

  updateMe(body: Partial<UserIdentity>): Promise<UserIdentity> {
    return this.mutate('/me', 'PATCH', body)
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

  removeChannelMember(channelId: string, profileId: string): Promise<{ ok: boolean }> {
    return this.mutate(
      `/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(profileId)}`,
      'DELETE',
    )
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

  events(after = 0, channelId?: string, limit?: number): Promise<EventFrame[]> {
    const params = new URLSearchParams({ after: String(after) })
    if (channelId) params.set('channel_id', channelId)
    if (limit) params.set('limit', String(limit))
    return this.request(`/events?${params.toString()}`)
  }

  search(filters: {
    q?: string
    channelId?: string
    member?: string
    project?: string
    state?: string
  }): Promise<SearchResult[]> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value)
    }
    return this.request(`/search?${params.toString()}`)
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
