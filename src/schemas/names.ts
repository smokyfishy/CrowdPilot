/** Collection names. `rooms` lives in the app scope; the rest live in each room's `room:<roomId>` scope. */
export const C = {
  rooms: 'rooms',
  roomState: 'room_state',
  members: 'room_members',
  queue: 'queue_items',
  votes: 'votes',
  playback: 'playback',
  events: 'room_events',
  reactions: 'reactions',
  receipts: 'command_receipts',
  dj: 'dj_state',
  features: 'track_features',
} as const

/** Singleton record id for room_state and playback inside a room scope. */
export const STATE_ID = 'state'
