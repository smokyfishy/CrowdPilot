/**
 * AI mix generator API (signed-in users only).
 *
 *  POST /api/mixgen/interpret       prompt (+ optional current spec & edit) → validated MixSpec (LLM; deterministic fallback, labelled)
 *  POST /api/mixgen/discover        spec → candidate pool with central access-policy decisions (keys stay server-side)
 *  GET  /api/mixgen/audio/:key      authorized audio for the browser render worker (policy re-checked server-side, never cached)
 *  POST /api/mixgen/mixes           create a mix version (draft)
 *  POST /api/mixgen/mixes/:id       update progress / selection / completion / failure (owner only, validated)
 *  DELETE /api/mixgen/mixes/:id     delete a version (and its files)
 *
 * Long work (acquisition, analysis, rendering) never runs in these handlers: it runs in the
 * user's browser render worker or the Node research worker. Handlers are short and bounded.
 */
import type { Context, Hono } from 'hono'
import { generateText } from 'ai'
import { appFiles, createDeepSpaceAI } from 'deepspace/worker'
import { z } from 'zod'
import type { AppContext, Env } from '../../worker'
import { TokenBucket } from '../domain/rate-limit'
import { ccLabel } from '../providers/catalog/jamendo'
import { createAudiusDiscovery, createJamendoDiscovery, createYouTubeDiscovery, discover, relevant } from '../mixgen/discovery'
import { decideAccess, POLICY_VERSION, type PolicyContext } from '../mixgen/policy'
import { EditOp, extractJson, heuristicSpec, INTERPRET_SYSTEM, MixSpec, parseSpec, REFINE_SYSTEM, resolveSpec } from '../mixgen/spec'
import { STAGES } from '../mixgen/types'
import { appScope, createRoomTools } from './room-tools'
import type { VerifyResult } from 'deepspace/worker'

export type ResolveAuth = (req: Request, env: Env) => Promise<VerifyResult | null>

const interprets = new TokenBucket(10, 10 / 60_000)
const discovers = new TokenBucket(6, 6 / 60_000)
const audioFetches = new TokenBucket(120, 120 / 60_000)
const writes = new TokenBucket(240, 240 / 60_000)

export const MIXGEN_MODEL = 'claude-sonnet-5-5'

/** Deployed policy: no download worker, no YouTube grants, Audius session mixing off (renders must be storable). */
export const DEPLOYED_POLICY: PolicyContext = { grants: [], ytDlpAvailable: false, allowAudiusSession: false }

type C = Context<AppContext>

function err(c: C, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function body<T>(c: C, max = 64 * 1024): Promise<T | null> {
  const len = Number(c.req.header('content-length') ?? 0)
  if (len > max) return null
  try {
    const txt = await c.req.text()
    if (txt.length > max) return null
    return JSON.parse(txt) as T
  } catch {
    return null
  }
}

export async function interpretPrompt(
  llm: ((system: string, prompt: string) => Promise<string>) | null,
  input: { prompt: string; current?: unknown; edit?: string },
): Promise<{ spec: MixSpec; source: 'llm' | 'heuristic'; editOps: EditOp[]; warning?: string }> {
  if (input.edit && input.current) {
    const current = parseSpec(input.current)
    if (llm) {
      try {
        const out = extractJson(await llm(REFINE_SYSTEM, `Current spec:\n${JSON.stringify(current)}\n\nEdit request: ${input.edit}`)) as { spec?: unknown; edit_ops?: unknown[] }
        const spec = parseSpec(out.spec ?? out)
        const editOps = (out.edit_ops ?? []).map((o) => EditOp.safeParse(o)).filter((r) => r.success).map((r) => r.data!)
        return { spec, source: 'llm', editOps }
      } catch (e) {
        return { spec: mergeHeuristicEdit(current, input.edit), source: 'heuristic', editOps: heuristicEditOps(input.edit), warning: `AI interpreter failed (${(e as Error).message.slice(0, 120)}); applied a basic edit.` }
      }
    }
    return { spec: mergeHeuristicEdit(current, input.edit), source: 'heuristic', editOps: heuristicEditOps(input.edit), warning: 'AI interpreter unavailable; applied a basic edit.' }
  }
  if (llm) {
    try {
      const spec = parseSpec(extractJson(await llm(INTERPRET_SYSTEM, input.prompt)))
      return { spec, source: 'llm', editOps: [] }
    } catch (e) {
      return { spec: heuristicSpec(input.prompt), source: 'heuristic', editOps: [], warning: `AI interpreter failed (${(e as Error).message.slice(0, 120)}); used a basic interpretation.` }
    }
  }
  return { spec: heuristicSpec(input.prompt), source: 'heuristic', editOps: [], warning: 'AI interpreter unavailable; used a basic interpretation.' }
}

/** Deterministic edit fallback for common refinements. */
export function mergeHeuristicEdit(cur: MixSpec, edit: string): MixSpec {
  const e = edit.toLowerCase()
  const s: MixSpec = { ...cur, explicit: [...cur.explicit] }
  const mark = (k: string) => !s.explicit.includes(k) && s.explicit.push(k)
  const min = /(\d{1,3})\s*-?\s*min/.exec(e)
  if (min) (s.target_duration_minutes = Number(min[1])), mark('target_duration_minutes')
  if (/more energetic|more energy|harder|hype/.test(e)) (s.intensity = Math.min(1, (s.intensity ?? 0.6) + 0.2)), mark('intensity')
  if (/less energetic|chill(er)?|calmer|softer/.test(e)) (s.intensity = Math.max(0, (s.intensity ?? 0.6) - 0.2)), mark('intensity')
  if (/more popular|bigger (tracks|songs)|hits/.test(e)) (s.popularity = 'high'), mark('popularity')
  if (/smoother/.test(e)) (s.transition_style = 'smooth'), mark('transition_style')
  if (/more creative|creative transitions|more effects/.test(e)) (s.transition_style = 'creative'), mark('transition_style')
  if (/fewer vocals|less vocals|reduce (the number of )?vocals|instrumental/.test(e)) (s.vocals = 'instrumental'), mark('vocals')
  if (/drops?/.test(e) && !s.features.includes('big_drops')) (s.features = [...s.features, 'big_drops']), mark('features')
  if (/ending more dramatic|dramatic ending|festival/.test(e) && !s.features.includes('festival_closer')) (s.features = [...s.features, 'festival_closer']), mark('features')
  const cnt = /(\d{1,2})\s+(tracks|songs)/.exec(e)
  if (cnt) (s.song_count = Number(cnt[1])), mark('song_count')
  return MixSpec.parse(s)
}

const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, last: 99 }
export function heuristicEditOps(edit: string): EditOp[] {
  const e = edit.toLowerCase()
  const m = /(replace|swap|change|remove|drop)\s+(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last))\s+(?:song|track)/.exec(e)
  if (!m) return []
  const pos = m[2] ? Number(m[2]) : ORD[m[3]]
  return [{ op: m[1] === 'remove' || m[1] === 'drop' ? 'remove' : 'replace', position: Math.min(30, pos) }]
}

const MixPatch = z.object({
  status: z.enum(['draft', 'working', 'review', 'rendering', 'ready', 'failed']).optional(),
  stage: z.enum(STAGES).optional(),
  progress: z.record(z.string(), z.object({ done: z.number().int().min(0).max(100000), total: z.number().int().min(0).max(100000), detail: z.string().max(300).optional(), at: z.number().optional() })).optional(),
  selection: z.array(z.record(z.string(), z.unknown())).max(80).optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  manifestKey: z.string().max(300).optional(),
  audioKey: z.string().max(300).optional(),
  audioMime: z.string().max(60).optional(),
  durationSec: z.number().min(0).max(4 * 3600).optional(),
  trackCount: z.number().int().min(0).max(40).optional(),
  permissions: z.object({ persistRender: z.boolean(), export: z.boolean(), reason: z.string().max(400) }).optional(),
  title: z.string().max(120).optional(),
  error: z.string().max(1000).optional(),
})

export function registerMixgenRoutes(app: Hono<AppContext>, resolveAuth: ResolveAuth): void {
  // Local research outputs are only ever served by the dev server on localhost; never in production.
  app.all('/__research', (c) => c.text('Not found', 404))
  app.all('/__research/*', (c) => c.text('Not found', 404))

  const authed = async (c: C) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth || auth.userId.startsWith('anon-')) return null
    return auth
  }

  app.post('/api/mixgen/interpret', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to generate a mix.')
    if (!interprets.take(auth.userId, Date.now()).ok) return err(c, 429, 'RATE_LIMITED', 'Slow down a little and try again.')
    const b = await body<{ prompt?: string; current?: unknown; edit?: string }>(c)
    const prompt = typeof b?.prompt === 'string' ? b.prompt.trim().slice(0, 2000) : ''
    const edit = typeof b?.edit === 'string' ? b.edit.trim().slice(0, 1000) : undefined
    if (!prompt && !edit) return err(c, 400, 'INVALID', 'Describe the mix you want.')
    const jwt = c.req.header('Authorization')!.slice(7)
    let llm: ((system: string, prompt: string) => Promise<string>) | null = null
    try {
      const model = createDeepSpaceAI(c.env, 'anthropic', { authToken: jwt })(MIXGEN_MODEL)
      llm = async (system, p) => (await generateText({ model, system, prompt: p, maxOutputTokens: 1500, temperature: 0 })).text
    } catch {
      llm = null
    }
    try {
      const r = await interpretPrompt(llm, { prompt, current: b?.current, edit })
      return c.json({ ...r, resolved: resolveSpec(r.spec) })
    } catch (e) {
      return err(c, 400, 'INVALID', (e as Error).message.slice(0, 300))
    }
  })

  app.post('/api/mixgen/discover', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to generate a mix.')
    if (!discovers.take(auth.userId, Date.now()).ok) return err(c, 429, 'RATE_LIMITED', 'Discovery is busy; try again in a minute.')
    const b = await body<{ spec?: unknown }>(c)
    let spec
    try {
      spec = resolveSpec(parseSpec(b?.spec))
    } catch (e) {
      return err(c, 400, 'INVALID', (e as Error).message.slice(0, 300))
    }
    const providers = [createJamendoDiscovery(c.env.JAMENDO_CLIENT_ID), createAudiusDiscovery(), createYouTubeDiscovery(c.env.YOUTUBE_API_KEY)]
    const res = await discover(spec, providers)
    const pool = res.pool.filter((x) => relevant(spec, x))
    return c.json({
      pool: pool.map((x) => ({ ...x, access: decideAccess(x, DEPLOYED_POLICY) })),
      crossResolved: res.crossResolved,
      queries: res.queries,
      bySource: res.bySource,
      policyVersion: POLICY_VERSION,
    })
  })

  // Authorized audio for the browser render worker. Policy is re-derived from the provider's
  // CURRENT metadata (never from the client). Bytes are streamed through, never stored.
  app.get('/api/mixgen/audio/:key', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to generate a mix.')
    if (!audioFetches.take(auth.userId, Date.now()).ok) return err(c, 429, 'RATE_LIMITED', 'Too many audio requests.')
    const key = c.req.param('key')
    const m = /^jamendo:(\d{1,12})$/.exec(key)
    if (!m) return err(c, 403, 'NOT_PERMITTED', 'This source has no authorized audio access for mixing.')
    const id = m[1]
    if (!c.env.JAMENDO_CLIENT_ID) return err(c, 502, 'UPSTREAM', 'Jamendo is not configured.')
    let t: { audio?: string; audiodownload?: string; audiodownload_allowed?: boolean; license_ccurl?: string } | undefined
    // The Jamendo API intermittently answers an empty result under load: retry with backoff.
    for (let attempt = 0; attempt < 5 && !t; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 300 * attempt))
      const p = new URLSearchParams({ client_id: c.env.JAMENDO_CLIENT_ID, format: 'json', id, audioformat: 'mp32', audiodlformat: 'flac' })
      const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?${p.toString()}`).catch(() => null)
      t = ((await r?.json().catch(() => null)) as { results?: Array<NonNullable<typeof t>> } | null)?.results?.[0]
    }
    if (!t) return err(c, 404, 'UNAVAILABLE', 'The recording is no longer available on Jamendo.')
    const lic = ccLabel(t.license_ccurl)
    if (lic.ndOrUnknown) return err(c, 403, 'NOT_PERMITTED', `${lic.label}: not mixable (no derivatives / unknown licence).`)
    const quality = c.req.query('quality') === 'lossless' && t.audiodownload_allowed && t.audiodownload ? 'flac' : 'mp3'
    const url = quality === 'flac' ? t.audiodownload! : t.audio!
    const upstream = await fetch(url, { redirect: 'follow' })
    if (!upstream.ok) return err(c, 502, 'UPSTREAM', `Jamendo audio returned ${upstream.status}.`)
    const out = new Headers()
    out.set('content-type', quality === 'flac' ? 'audio/flac' : 'audio/mpeg')
    const len = upstream.headers.get('content-length')
    if (len) out.set('content-length', len)
    out.set('cache-control', 'no-store')
    out.set('x-crowdpilot-license', lic.label)
    out.set('x-crowdpilot-quality', quality)
    return new Response(upstream.body, { status: 200, headers: out })
  })

  app.post('/api/mixgen/mixes', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in to generate a mix.')
    if (!writes.take(auth.userId, Date.now()).ok) return err(c, 429, 'RATE_LIMITED', 'Slow down a little.')
    const b = await body<{ prompt?: string; spec?: unknown; specSource?: string; parentId?: string; editPrompt?: string; title?: string }>(c)
    let spec
    try {
      spec = parseSpec(b?.spec)
    } catch (e) {
      return err(c, 400, 'INVALID', (e as Error).message.slice(0, 300))
    }
    const tools = createRoomTools(c.env, appScope(c.env), auth.userId)
    let rootId: string | undefined
    let version = 1
    if (b?.parentId) {
      const parent = await tools.get('mixes', b.parentId)
      const pd = parent.success ? parent.data?.record?.data : undefined
      if (!pd || pd.ownerUserId !== auth.userId) return err(c, 404, 'NOT_FOUND', 'That mix does not exist.')
      rootId = (pd.rootId as string) || b.parentId
      const siblings = await tools.query('mixes', { where: { rootId, ownerUserId: auth.userId }, limit: 200 })
      const list = siblings.success ? (siblings.data?.records ?? []) : []
      version = Math.max(1, Number(pd.version ?? 1), ...list.map((r) => Number(r.data?.version ?? 1))) + 1
    }
    const id = crypto.randomUUID()
    const now = Date.now()
    const r = await tools.create(
      'mixes',
      {
        ownerUserId: auth.userId,
        rootId: rootId ?? id,
        parentId: b?.parentId ?? '',
        version,
        title: (b?.title ?? resolveSpec(spec).title).slice(0, 120),
        prompt: (b?.prompt ?? '').slice(0, 2000),
        editPrompt: (b?.editPrompt ?? '').slice(0, 1000),
        spec,
        specSource: b?.specSource === 'llm' || b?.specSource === 'user' ? b.specSource : 'heuristic',
        status: 'draft',
        stage: 'understanding',
        progress: { understanding: { done: 1, total: 1, at: now } },
        createdAt: now,
        updatedAt: now,
      },
      id,
    )
    if (!r.success) return err(c, 502, 'STORE', 'Could not save the mix.')
    return c.json({ id, version, rootId: rootId ?? id })
  })

  const ownMix = async (c: C, userId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null
    const tools = createRoomTools(c.env, appScope(c.env), userId)
    const r = await tools.get('mixes', id)
    const d = r.success ? r.data?.record?.data : undefined
    if (!d || d.ownerUserId !== userId) return null
    return { tools, data: d }
  }

  app.post('/api/mixgen/mixes/:id', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in.')
    if (!writes.take(auth.userId, Date.now()).ok) return err(c, 429, 'RATE_LIMITED', 'Slow down a little.')
    const own = await ownMix(c, auth.userId, c.req.param('id'))
    if (!own) return err(c, 404, 'NOT_FOUND', 'That mix does not exist.')
    const raw = await body<unknown>(c, 256 * 1024)
    const parsed = MixPatch.safeParse(raw)
    if (!parsed.success) return err(c, 400, 'INVALID', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300))
    const patch = parsed.data
    // Files must live in the caller's own private folder.
    for (const k of [patch.audioKey, patch.manifestKey]) if (k && !k.includes(auth.userId)) return err(c, 403, 'FORBIDDEN', 'File keys must be in your own storage.')
    if (patch.status === 'ready' && (!patch.manifestKey && !own.data.manifestKey)) return err(c, 400, 'INVALID', 'A ready mix needs its manifest.')
    const progress = patch.progress ? { ...((own.data.progress as object) ?? {}), ...patch.progress } : undefined
    const r = await own.tools.update('mixes', c.req.param('id'), { ...patch, ...(progress ? { progress } : {}), updatedAt: Date.now() })
    if (!r.success) return err(c, 502, 'STORE', 'Could not update the mix.')
    return c.json({ ok: true })
  })

  app.delete('/api/mixgen/mixes/:id', async (c) => {
    const auth = await authed(c)
    if (!auth) return err(c, 401, 'UNAUTHENTICATED', 'Sign in.')
    const own = await ownMix(c, auth.userId, c.req.param('id'))
    if (!own) return err(c, 404, 'NOT_FOUND', 'That mix does not exist.')
    const files = appFiles(c.env, { scope: 'self', userId: auth.userId })
    for (const k of [own.data.audioKey, own.data.manifestKey]) if (typeof k === 'string' && k) await files.delete(k).catch(() => undefined)
    await own.tools.remove('mixes', c.req.param('id'))
    return c.json({ ok: true })
  })
}

export type { Env }
