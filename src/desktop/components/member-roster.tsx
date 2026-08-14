import { useCallback, useEffect, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'
import { ThemedSelect } from './themed-select'
import type { ChannelMember, CrewChannel, HermesProfile } from '../types'

const POLICIES: ChannelMember['activationPolicy'][] = ['always', 'mentioned', 'observer', 'disabled']

interface MemberRosterProps {
  api: Pick<CrewApi, 'listChannelMembers' | 'updateChannelMember' | 'removeChannelMember' | 'patchChannel'>
  channel: CrewChannel
  profiles: HermesProfile[]
  /** Profiles with a live (non-terminal) turn right now. */
  activeProfileIds?: string[]
  onMembershipChange?(): void
  onChannelChange?(channel: CrewChannel): void
}

/**
 * The channel's real membership, managed in place: add bots, change their
 * activation policy, remove them. The default responder is protected —
 * routing needs someone to answer untagged messages.
 */
export function MemberRoster({ api, channel, profiles, activeProfileIds = [], onMembershipChange, onChannelChange }: MemberRosterProps) {
  const presentation = usePresentation()
  const [members, setMembers] = useState<ChannelMember[]>([])
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState('')
  const loadSequence = useRef(0)

  const load = useCallback(() => {
    const sequence = ++loadSequence.current
    void api.listChannelMembers(channel.id)
      .then((next) => {
        if (sequence === loadSequence.current) setMembers(next)
      })
      .catch(() => setError('Members could not be loaded'))
  }, [api, channel.id])

  useEffect(() => {
    setError('')
    setCandidate('')
    load()
    return () => { loadSequence.current += 1 }
  }, [load])

  const memberIds = new Set(members.map((member) => member.profileId))
  const addable = profiles.filter((profile) => !memberIds.has(profile.name))

  function add() {
    if (!candidate) return
    setError('')
    void api.updateChannelMember(channel.id, candidate, 'mentioned')
      .then(() => { setCandidate(''); load(); onMembershipChange?.() })
      .catch(() => setError('Member could not be added'))
  }

  function setPolicy(profileId: string, policy: ChannelMember['activationPolicy']) {
    setError('')
    setMembers((current) => current.map((member) => (
      member.profileId === profileId ? { ...member, activationPolicy: policy } : member
    )))
    void api.updateChannelMember(channel.id, profileId, policy).catch(() => {
      setError('Policy could not be saved')
      load()
    })
  }

  function remove(profileId: string) {
    setError('')
    void api.removeChannelMember(channel.id, profileId)
      .then(() => { load(); onMembershipChange?.() })
      .catch(() => setError('The default responder cannot be removed'))
  }

  function setDefaultResponder(profileId: string) {
    setError('')
    void api.patchChannel(channel.id, {
      defaultResponderProfile: profileId === '__none__' ? null : profileId,
    })
      .then((updated) => onChannelChange?.(updated))
      .catch(() => setError('Default responder could not be saved'))
  }

  return (
    <section aria-label="Channel members" className="grid content-start gap-1 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Members</h2>
      {members.length > 0 ? (
        <label className="mb-1 grid gap-1 text-[11px] text-(--ui-text-tertiary)">
          Default responder
          <ThemedSelect
            ariaLabel="Default responder"
            onChange={setDefaultResponder}
            options={[
              { value: '__none__', label: 'No default' },
              ...members
                .filter((member) => !['observer', 'disabled'].includes(member.activationPolicy))
                .map((member) => ({
                  value: member.profileId,
                  label: presentedName(presentation, member.profileId),
                })),
            ]}
            value={channel.defaultResponderProfile || '__none__'}
          />
        </label>
      ) : null}
      {members.map((member) => {
        const working = activeProfileIds.includes(member.profileId)
        const isResponder = channel.defaultResponderProfile === member.profileId
        const presented = presentation.members[member.profileId]
        const subtitle = presented?.role?.trim()
          || (isResponder ? 'Default responder' : 'Channel member')
        return (
          <article className="group flex items-center gap-2 rounded px-1 py-2 hover:bg-(--ui-surface-secondary)" key={member.profileId}>
            <MemberAvatar profileId={member.profileId} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <strong className="truncate text-sm">{presentedName(presentation, member.profileId)}</strong>
                {working ? <span aria-label="Working now" className="size-2 rounded-full bg-green-500" title="Working now" /> : null}
              </div>
              <p className="truncate text-[11px] text-(--ui-text-tertiary)">{working ? 'Working now' : subtitle}</p>
            </div>
            <ThemedSelect
              ariaLabel={`Activation policy for ${member.profileId}`}
              className="h-6 rounded border border-(--ui-stroke-secondary) bg-background px-1.5 py-0.5 text-[11px] text-(--ui-text-secondary)"
              onChange={(policy) => setPolicy(member.profileId, policy as ChannelMember['activationPolicy'])}
              options={(isResponder ? POLICIES.slice(0, 2) : POLICIES)
                .map((policy) => ({ value: policy, label: policy }))}
              value={member.activationPolicy}
            />
            {isResponder ? null : (
              <button
                aria-label={`Remove ${member.profileId} from channel`}
                className="rounded p-0.5 leading-none text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => remove(member.profileId)}
                title="Remove from channel"
                type="button"
              >
                <span aria-hidden="true" className="codicon codicon-close" style={{ fontSize: 13, width: 13, height: 13 }} />
              </button>
            )}
          </article>
        )
      })}
      {addable.length > 0 ? (
        <div className="mt-1 flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <ThemedSelect
              ariaLabel="Add member"
              className="h-7 w-full rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1 text-xs"
              onChange={(next) => setCandidate(next === '__none__' ? '' : next)}
              options={[
                { value: '__none__', label: 'Add a bot…' },
                ...addable.map((profile) => ({
                  value: profile.name,
                  label: presentedName(presentation, profile.name),
                })),
              ]}
              value={candidate || '__none__'}
            />
          </div>
          <button
            className="rounded-lg bg-(--ui-accent) px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            disabled={!candidate}
            onClick={add}
            type="button"
          >
            Add
          </button>
        </div>
      ) : null}
      {error ? <p className="text-[11px] text-amber-500" role="alert">{error}</p> : null}
    </section>
  )
}
