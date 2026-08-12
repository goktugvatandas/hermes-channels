export const crewKeys = {
  root: ['hermes-crew'] as const,
  channels: () => ['hermes-crew', 'channels'] as const,
  messages: (channelId: string) => ['hermes-crew', 'messages', channelId] as const,
  thread: (rootMessageId: string) =>
    ['hermes-crew', 'thread', rootMessageId] as const,
  profiles: () => ['hermes-crew', 'profiles'] as const,
  projects: (profile: string) => ['hermes-crew', 'projects', profile] as const,
  events: () => ['hermes-crew', 'events'] as const,
}
