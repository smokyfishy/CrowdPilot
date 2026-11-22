/**
 * Central source-access policy. Every acquisition, analysis, render-persistence and
 * export decision goes through `decideAccess`, so the user never sees per-track
 * licensing dialogs and the rules are applied consistently and auditable in one place.
 *
 * Basis (see docs/DATA_RIGHTS_AND_PROVENANCE.md and docs/AI_MIX_GENERATOR.md):
 *  - Jamendo: per-track Creative Commons licence, API free for non-commercial use.
 *    Non-ND licences permit adaptations (a DJ mix is one) with attribution → full use.
 *    ND / unknown licences: analysis only, never mixed.
 *  - Audius: Open Music License streaming grant + API Terms (session-only caching,
 *    no ML training). Mixed only in the user's session; the render is not stored
 *    server-side and not exported.
 *  - YouTube: discovery/identity metadata only. YouTube's Terms of Service do not
 *    permit downloading unless YouTube provides a download feature or the rights holders
 *    have given permission, so a public, viewable video is NOT treated as downloadable.
 *    `yt-dlp` acquisition is allowed only for videos/channels with an explicit
 *    authorization grant recorded by the operator, or for videos the artist's OFFICIAL channel
 *    licensed Creative Commons (CC BY — the rights holder's own reuse permission, re-verified on
 *    the video page at download time). DRM-protected or
 *    access-restricted streams are never acquired, with or without a grant.
 */
import type { AccessDecision, TrackCandidate } from './types'

export const POLICY_VERSION = 'cp-access-2026-11-22b'

export interface AuthorizationGrant {
  /** What the grant covers. */
  scope: 'youtube_video' | 'youtube_channel'
  id: string
  /** Who granted it (rights holder / label / artist) and the evidence reference. */
  grantor: string
  evidence: string
  allows: Array<'acquire' | 'mix' | 'persist_render' | 'export'>
  /** ISO date; the grant is ignored after it. */
  expires?: string
}

export interface PolicyContext {
  /** Operator-recorded grants (research worker only). */
  grants: AuthorizationGrant[]
  /** Whether the current environment can run yt-dlp at all (Node research worker). */
  ytDlpAvailable: boolean
  /** Include Audius OML-only uploads (session-only). Mirrors the room's host toggle default. */
  allowAudiusSession: boolean
  /**
   * Local research mode (operator's own machine, private noncommercial research, operator's
   * responsibility): YouTube recordings may be acquired with yt-dlp, but outputs are local-only
   * (never persisted to cloud storage or served). Only honoured when `environment === 'local'`.
   * Set exclusively by the local Node worker from its research flag; never by the Cloudflare
   * app or the container worker.
   */
  researchYouTube?: boolean
  /** Where this policy is evaluated. Defaults to 'cloud' (the strict policy). */
  environment?: 'local' | 'cloud'
  now?: Date
}

const DENY = (reason: string): AccessDecision => ({
  acquire: false,
  analyze: false,
  mix: false,
  persistRender: false,
  export: false,
  cacheAudio: false,
  attributionRequired: false,
  method: 'none',
  reason,
  policyVersion: POLICY_VERSION,
})

function liveGrant(ctx: PolicyContext, c: TrackCandidate): AuthorizationGrant | undefined {
  const now = (ctx.now ?? new Date()).toISOString().slice(0, 10)
  return ctx.grants.find(
    (g) =>
      (!g.expires || g.expires >= now) &&
      ((g.scope === 'youtube_video' && g.id === c.sourceId) || (g.scope === 'youtube_channel' && !!c.uploader && g.id.toLowerCase() === c.uploader.toLowerCase())),
  )
}

export function decideAccess(c: TrackCandidate, ctx: PolicyContext): AccessDecision {
  switch (c.source) {
    case 'jamendo': {
      const b = c.license.basis
      if (!b.startsWith('cc-')) return DENY('Jamendo track without a stated Creative Commons licence.')
      if (b.includes('-nd-') || b.endsWith('-nd')) {
        return { ...DENY('CC No-Derivatives licence: a DJ mix is an adaptation, so this track is not mixed.'), analyze: false }
      }
      return {
        acquire: true,
        analyze: true,
        mix: true,
        persistRender: true,
        export: true,
        cacheAudio: true,
        attributionRequired: true,
        method: 'jamendo_api',
        reason: `${c.license.label}: adaptation permitted with attribution${b.includes('-nc') ? ' (non-commercial)' : ''}${b.includes('-sa') ? '; mix shared under the same licence' : ''}.`,
        policyVersion: POLICY_VERSION,
      }
    }
    case 'audius': {
      // The API Terms (session-only caching, no training) apply to all API-delivered audio, CC or not.
      if (!ctx.allowAudiusSession) return DENY('Audius audio is session-only under the Audius API Terms, and session mixing is disabled here (renders must be storable).')
      return {
        acquire: true,
        analyze: true,
        mix: true,
        persistRender: false,
        export: false,
        cacheAudio: false,
        attributionRequired: true,
        method: 'audius_stream',
        reason: 'Audius stream (Open Music License): mixed in your session only; the render is not stored or exported, and is never used for training.',
        policyVersion: POLICY_VERSION,
      }
    }
    case 'youtube': {
      if (ctx.researchYouTube && ctx.environment === 'local' && ctx.ytDlpAvailable) {
        return {
          acquire: true,
          analyze: true,
          mix: true,
          persistRender: false,
          export: true,
          exportScope: 'local',
          cacheAudio: true,
          attributionRequired: true,
          method: 'yt_dlp_research',
          reason: 'Local research mode — not for distribution',
          policyVersion: POLICY_VERSION,
        }
      }
      const g = liveGrant(ctx, c)
      if (!g && c.license.basis === 'youtube-cc-by' && c.official) {
        if (!ctx.ytDlpAvailable) return DENY('CC BY video from the official channel, but this environment has no download worker.')
        return {
          acquire: true,
          analyze: true,
          mix: true,
          persistRender: true,
          export: true,
          cacheAudio: true,
          attributionRequired: true,
          method: 'yt_dlp_authorized',
          reason: `Licensed CC BY by the official channel "${c.uploader ?? c.artist}" (reuse with attribution).`,
          policyVersion: POLICY_VERSION,
          basis: 'official-cc-by',
        }
      }
      if (!g) return DENY('YouTube video: no download authorization from the rights holder (YouTube Terms of Service). Discovery and identity only.')
      if (!ctx.ytDlpAvailable) return DENY('Authorized YouTube source, but this environment has no download worker; the research worker can acquire it.')
      return {
        acquire: g.allows.includes('acquire'),
        analyze: g.allows.includes('acquire'),
        mix: g.allows.includes('mix'),
        persistRender: g.allows.includes('persist_render'),
        export: g.allows.includes('export'),
        cacheAudio: g.allows.includes('acquire'),
        attributionRequired: true,
        method: 'yt_dlp_authorized',
        reason: `Authorized by ${g.grantor} (${g.evidence}).`,
        policyVersion: POLICY_VERSION,
        basis: 'grant',
      }
    }
  }
}

/** Aggregate export/persist permission for a whole mix: the strictest track wins. */
export function mixPermissions(decisions: AccessDecision[]): { persistRender: boolean; export: boolean; reason: string } {
  const blockPersist = decisions.find((d) => !d.persistRender)
  const blockExport = decisions.find((d) => !d.export)
  return {
    persistRender: !blockPersist,
    export: !blockExport,
    reason: blockExport ? `Download unavailable: ${blockExport.reason}` : 'All tracks permit adaptation and download with attribution.',
  }
}
