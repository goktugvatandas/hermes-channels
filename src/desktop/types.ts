export type ActivationPolicy = 'always' | 'mentioned' | 'observer' | 'disabled'

export type MessageIntent =
  | 'inform'
  | 'result'
  | 'reply_required'
  | 'question'
  | 'handoff'
  | 'review_request'
  | 'blocked'
  | 'approval_request'

export interface IntentEnvelope {
  schemaVersion: 1
  intent: MessageIntent
  recipients: string[]
  replyExpected: boolean
  replyBudget: number
  correlationId: string | null
  summary: string
}

export interface DispatchClaim {
  id: string
  kind: 'agent' | 'classification'
  channelId: string
  profileId: string | null
  context: string
  instructions: string | null
  input: string | null
  cwd: string | null
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  maxTokens: number
  temperature: number
  createdAt: number
}

export interface RpcEvent {
  type: string
  session_id?: string
  profile?: string
  payload?: unknown
}

export interface ProjectRef {
  mode: 'inherit' | 'global' | 'project'
  profile?: string | null
  projectId?: string | null
  label?: string | null
  cwd?: string | null
}

export interface CrewChannel {
  id: string
  name: string
  purpose: string
  topic: string
  defaultResponderProfile: string | null
  defaultProject: ProjectRef | null
  allowedProjects: string[]
  routingRules: Record<string, number>
  createdAt: number
  updatedAt: number
}

export interface CrewMessage {
  id: string
  channelId: string
  rootMessageId: string | null
  authorType: 'user' | 'agent' | 'system'
  authorProfileId: string | null
  content: string
  mentions: string[]
  project: ProjectRef | null
  modelLabel: string | null
  createdAt: number
}

export interface HermesProfile {
  name: string
  path: string
  isDefault: boolean
  gatewayRunning: boolean
  provider: string | null
  model: string | null
  hasEnv: boolean
  skillCount: number
  description: string
}

export interface CrewMember {
  profileId: string
  displayName: string
  role: string
  avatar: string | null
  color: string | null
  modelLabel?: string | null
  defaultProject: ProjectRef | null
  archived: boolean
  updatedAt?: number
}

export interface ChannelMember {
  channelId: string
  profileId: string
  activationPolicy: ActivationPolicy
}

export interface ClassifierConfig {
  enabled: boolean
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  maxTokens: number
  confidenceThreshold: number
}

export interface SkillState {
  name: string
  enabled: boolean
}

export interface SearchResult {
  kind: 'message' | 'activity'
  sourceId: string
  channelId: string
  memberId: string
  projectId: string
  state: string
  text: string
  createdAt: number
}

export interface EventFrame {
  sequence: number
  type: string
  channelId: string
  turnId: string | null
  payload: Record<string, unknown>
}

export interface MessageReceipt {
  message: CrewMessage
  turnIds: string[]
}
