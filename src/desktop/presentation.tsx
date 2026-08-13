import { createContext, useContext } from 'react'

import { Avatar } from './components/avatar'
import { displayName } from './conversation-model'
import type { CrewMember, UserIdentity } from './types'

export interface Presentation {
  /** Stored member presentation keyed by Hermes profile id. */
  members: Record<string, CrewMember>
  /** The human user's identity (display name, avatar, color). */
  me: UserIdentity
}

export const DEFAULT_IDENTITY: UserIdentity = { displayName: 'You', avatar: null, color: null }

export const PresentationContext = createContext<Presentation>({ members: {}, me: DEFAULT_IDENTITY })

export function usePresentation(): Presentation {
  return useContext(PresentationContext)
}

/** The display name for a profile, preferring the stored member presentation. */
export function presentedName(presentation: Presentation, profileId: string): string {
  const member = presentation.members[profileId]
  return member?.displayName?.trim() || displayName(profileId)
}

/**
 * The @handle used to mention a member: the display name with whitespace and
 * punctuation stripped ("Atlas Prime" → @AtlasPrime), falling back to the
 * profile id. Renaming an agent renames its handle.
 */
export function mentionHandle(presentation: Presentation, profileId: string): string {
  const display = presentation.members[profileId]?.displayName?.trim()
  const handle = (display || profileId).replace(/[^\w-]+/g, '')
  return handle || profileId
}

/** An agent avatar that honors stored customization (image or color). */
export function MemberAvatar({ profileId, size = 'md' }: { profileId: string; size?: 'sm' | 'md' | 'lg' }) {
  const presentation = usePresentation()
  const member = presentation.members[profileId]
  return (
    <Avatar
      color={member?.color || null}
      name={presentedName(presentation, profileId)}
      size={size}
      src={member?.avatar || null}
    />
  )
}

/** The human user's avatar. */
export function UserAvatar({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const { me } = usePresentation()
  return <Avatar color={me.color} name={me.displayName || 'You'} size={size} src={me.avatar} />
}
