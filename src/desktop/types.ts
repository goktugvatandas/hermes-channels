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
  placement?: 'auto' | 'thread' | 'channel'
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

export interface RoutingRulesConfig {
  max_automated_turns: number
  max_depth: number
  max_pair_repeats: number
  max_concurrency: number
}



export interface UserIdentity {
  displayName: string
  avatar: string | null
  color: string | null
}

export interface ImageGenerationModel {
  id: string
  display: string
  speed?: string | null
  price?: string | null
}

export interface ImageGenerationStatus {
  available: boolean
  provider: string | null
  models: ImageGenerationModel[]
  defaultModel: string | null
}

export interface AvatarGenerateOptions {
  model?: string | null
  prompt?: string | null
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

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface SessionTranscript {
  id: string
  title: string
  model: string | null
  messages: SessionTranscriptMessage[]
}

export interface ChannelSection {
  id: string
  name: string
}

export interface ChannelSections {
  sections: ChannelSection[]
  assignments: Record<string, string>
}

export type KanbanCardStatus =
  | 'triage'
  | 'todo'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'

export interface KanbanComment {
  id: number
  author: string
  body: string
  createdAt: number
}

export interface KanbanEvent {
  id: number
  kind: string
  payload: Record<string, unknown> | null
  createdAt: number
}

export interface CardPrefixConfiguration {
  boardSlug: string
  boardName: string
  prefix: string
  generatedPrefix: string
  customized: boolean
  cardCount: number
  migratedCards?: number
}

export interface KanbanCard {
  id: string
  reference?: string
  title: string
  body: string | null
  status: KanbanCardStatus
  assignee: string | null
  priority: number
  createdBy: string | null
  projectId: string | null
  result: string | null
  blockKind: string | null
  tenant?: string | null
  branchName?: string | null
  workspaceKind?: string | null
  workspacePath?: string | null
  modelOverride?: string | null
  providerOverride?: string | null
  reasoningEffort?: string | null
  skills?: string[] | null
  goalMode?: boolean
  consecutiveFailures?: number
  lastFailureError?: string | null
  maxRuntimeSeconds?: number | null
  lastHeartbeatAt?: number | null
  sessionId?: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  commentCount?: number
  comments?: KanbanComment[]
  events?: KanbanEvent[]
  parents?: string[]
  children?: string[]
  blockReason?: string | null
}

export interface KanbanBoardInfo {
  slug: string
  name: string
}

export interface KanbanSnapshot {
  bound: boolean
  boardSlug?: string
  boardName?: string
  statuses?: KanbanCardStatus[]
  cards?: KanbanCard[]
  /** Unbound channels: the conventional slug offered for creation. */
  suggestedSlug?: string
  /** Unbound channels: existing host boards available to connect. */
  boards?: KanbanBoardInfo[]
}
