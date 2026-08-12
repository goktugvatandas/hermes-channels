export type ActivationPolicy = 'always' | 'mentioned' | 'observer' | 'disabled'

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
