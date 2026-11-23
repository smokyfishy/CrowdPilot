/**
 * Room-scoped guest tokens for anonymous participants:
 * base64url(JSON {roomId, memberId, exp}) + "." + base64url(HMAC-SHA256).
 * Signed with the GUEST_TOKEN_SECRET worker secret. Membership status is
 * re-checked on every command, so kicking a guest revokes the token in effect.
 */

export interface GuestTokenPayload {
  roomId: string
  memberId: string
  exp: number
}

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signGuestToken(secret: string, p: GuestTokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ roomId: p.roomId, memberId: p.memberId, exp: p.exp })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)))
  return `${body}.${b64url(sig)}`
}

export async function verifyGuestToken(
  secret: string,
  token: string,
  now: number,
): Promise<{ roomId: string; memberId: string } | null> {
  try {
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const valid = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(body))
    if (!valid) return null
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Partial<GuestTokenPayload>
    if (typeof p.roomId !== 'string' || typeof p.memberId !== 'string' || typeof p.exp !== 'number') return null
    if (p.exp <= now) return null
    return { roomId: p.roomId, memberId: p.memberId }
  } catch {
    return null
  }
}
