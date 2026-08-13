export interface ChannelUiSnapshot {
  draft: string
  scrollTop: number
}

export type ChannelUiState = Record<string, ChannelUiSnapshot>

// scrollTop -1 means "no saved position": the timeline pins to the newest message.
export function channelUiSnapshot(state: ChannelUiState, channelId: string): ChannelUiSnapshot {
  return state[channelId] || { draft: '', scrollTop: -1 }
}

export function updateChannelUiState(
  state: ChannelUiState,
  channelId: string,
  patch: Partial<ChannelUiSnapshot>,
): ChannelUiState {
  return {
    ...state,
    [channelId]: { ...channelUiSnapshot(state, channelId), ...patch },
  }
}
