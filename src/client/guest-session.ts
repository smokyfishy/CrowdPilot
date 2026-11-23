/**
 * Per-room guest tokens for anonymous participants. A convenience store: if
 * storage is blocked the guest simply has to join again.
 */
const key = (roomId: string) => `crowdpilot:guest:${roomId}`

export function getGuestToken(roomId: string): string | null {
  try {
    return localStorage.getItem(key(roomId))
  } catch {
    return null
  }
}

export function setGuestToken(roomId: string, token: string): void {
  try {
    localStorage.setItem(key(roomId), token)
  } catch {
    // storage unavailable (private mode); the session lasts until reload
  }
}

export function clearGuestToken(roomId: string): void {
  try {
    localStorage.removeItem(key(roomId))
  } catch {
    // ignore
  }
}
