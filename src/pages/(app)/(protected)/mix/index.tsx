/**
 * /mix — "Describe your dream DJ set." Step 1: prompt (+ optional controls) → AI
 * interpretation the user can review and edit → create the mix and start generating.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button, Skeleton, Textarea, useToast } from '@/components/ui'
import { mixApi, type InterpretResult } from '@/mixgen/browser/client'
import { ENERGY_CURVES, TRANSITION_STYLES, resolveSpec, type MixSpec } from '@/mixgen/spec'
import { fmtTime } from '@/components/mix/MixPlayer'
import { MixSteps } from '@/components/mix/MixSteps'

const EXAMPLES = [
  'Create a 45-minute house and EDM mix with 12 popular tracks. I like John Summit, Dom Dolla, Fisher, Chris Lake, and similar artists. Start groovy, gradually increase the energy, include several big drops, and finish with a festival-style closing track. Make the transitions smooth, professional, and creative.',
  'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.',
  'A 30-minute deep house sunset set, mostly instrumental, relaxed at first and warmer toward the end.',
]

const ENERGY_LABEL: Record<string, string> = {
  constant_high: 'Constant high energy',
  gradual_build: 'Gradual build',
  gradual_build_to_peak: 'Build to a peak',
  multiple_peaks: 'Multiple peaks',
  chill_to_energetic: 'Chill to energetic',
  festival_climax: 'Festival climax',
  groovy_then_harder: 'Groovy, then harder',
  high_then_relaxed: 'High energy, relaxed ending',
  steady: 'Steady',
}
const STYLE_LABEL: Record<string, string> = { smooth: 'Smooth', smooth_creative: 'Smooth & creative', creative: 'Creative (effects)', energetic: 'Energetic', minimal: 'Minimal' }

const field = 'h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground'

interface MixRow {
  title: string
  status: string
  stage: string
  durationSec?: number
  trackCount?: number
  version?: number
  rootId?: string
  updatedAt: number
}

function YourMixes() {
  const { records, status } = useQuery<MixRow>('mixes', { orderBy: 'updatedAt', orderDir: 'desc', limit: 50 })
  if (status === 'loading') return <Skeleton className="h-24" />
  if (!records.length) return <p className="text-muted-foreground">No mixes yet. Describe one above.</p>
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {records.map((r) => (
        <li key={r.recordId}>
          <Link to={`/mix/${r.recordId}`} className="flex items-center gap-4 px-4 py-3 hover:bg-accent">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">
                {r.data.title} {Number(r.data.version) > 1 && <span className="text-muted-foreground">· v{r.data.version}</span>}
              </p>
              <p className="text-sm text-muted-foreground">
                {r.data.status === 'ready' ? `${r.data.trackCount} tracks · ${fmtTime(Number(r.data.durationSec))}` : r.data.status === 'failed' ? 'Failed' : `In progress: ${r.data.stage}`}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default function MixCreate() {
  const navigate = useNavigate()
  const { error } = useToast()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [interp, setInterp] = useState<InterpretResult | null>(null)
  const [spec, setSpec] = useState<MixSpec | null>(null)
  const [quality, setQuality] = useState<'high' | 'lossless'>('high')
  // optional controls (explicit user overrides)
  const [ov, setOv] = useState<{ genre?: string; popularity?: string; count?: string; minutes?: string; energy?: string; style?: string }>({})

  function applyOverrides(s: MixSpec): MixSpec {
    const out: MixSpec = { ...s, explicit: [...s.explicit] }
    const mark = (k: string) => !out.explicit.includes(k) && out.explicit.push(k)
    if (ov.genre) (out.genres = ov.genre.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean)), mark('genres')
    if (ov.popularity) (out.popularity = ov.popularity as MixSpec['popularity']), mark('popularity')
    if (ov.count) (out.song_count = Math.max(2, Math.min(30, Number(ov.count)))), mark('song_count')
    if (ov.minutes) (out.target_duration_minutes = Math.max(5, Math.min(180, Number(ov.minutes)))), mark('target_duration_minutes')
    if (ov.energy) (out.energy_curve = ov.energy as MixSpec['energy_curve']), mark('energy_curve')
    if (ov.style) (out.transition_style = ov.style as MixSpec['transition_style']), mark('transition_style')
    return out
  }

  async function interpret(e: FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) return
    setBusy(true)
    try {
      const r = await mixApi.interpret(prompt.trim())
      setInterp(r)
      setSpec(applyOverrides(r.spec))
    } catch (err) {
      error('Could not understand the request', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Dev only: hand the AI-interpreted request to local research mode (YouTube via yt-dlp). */
  async function startResearch() {
    if (!spec) return
    setBusy(true)
    try {
      const r = await fetch('/__research/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, spec }) })
      const b = (await r.json()) as { id?: string; error?: string }
      if (!r.ok || !b.id) throw new Error(b.error ?? `failed (${r.status})`)
      navigate('/research')
    } catch (err) {
      error('Could not start local research mode', (err as Error).message)
      setBusy(false)
    }
  }

  async function start() {
    if (!spec) return
    setBusy(true)
    try {
      const r = await mixApi.create({ prompt, spec, specSource: interp?.source ?? 'user', title: resolveSpec(spec).title })
      sessionStorage.setItem(`mix-quality:${r.id}`, quality)
      navigate(`/mix/${r.id}`)
    } catch (err) {
      error('Could not start the mix', (err as Error).message)
      setBusy(false)
    }
  }

  const resolved = spec ? resolveSpec(spec) : null
  const set = (patch: Partial<MixSpec>, key: string) => spec && setSpec({ ...spec, ...patch, explicit: spec.explicit.includes(key) ? spec.explicit : [...spec.explicit, key] })

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-10 px-[max(16px,env(safe-area-inset-left))] py-10">
      <title>Generate AI Mix · CrowdPilot</title>
      <section className="grid gap-4">
        <MixSteps current={0} />
        <h1 className="font-display text-[clamp(2.4rem,6vw,4rem)] leading-[0.95] text-foreground">Describe your dream DJ set.</h1>
        <p className="max-w-[60ch] text-muted-foreground">CrowdPilot finds the music, gets audio from sources that allow mixing, analyzes every track, and renders one continuous mix with real beat-matched transitions.</p>
        <form onSubmit={interpret} className="grid gap-3">
          <label htmlFor="mix-prompt" className="sr-only">Describe your mix</label>
          <Textarea id="mix-prompt" data-testid="mix-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} maxLength={2000} placeholder={EXAMPLES[0]} className="text-base" />
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm text-foreground">Optional controls</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1 text-xs text-muted-foreground">Genre<input className={field} value={ov.genre ?? ''} onChange={(e) => setOv({ ...ov, genre: e.target.value })} placeholder="tech house, house" /></label>
              <label className="grid gap-1 text-xs text-muted-foreground">Popularity
                <select className={field} value={ov.popularity ?? ''} onChange={(e) => setOv({ ...ov, popularity: e.target.value || undefined })}>
                  <option value="">From prompt</option><option value="high">Popular</option><option value="mixed">Mixed</option><option value="underground">Underground</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">Songs<input className={field} type="number" min={2} max={30} value={ov.count ?? ''} onChange={(e) => setOv({ ...ov, count: e.target.value })} placeholder="12" /></label>
              <label className="grid gap-1 text-xs text-muted-foreground">Minutes<input className={field} type="number" min={5} max={180} value={ov.minutes ?? ''} onChange={(e) => setOv({ ...ov, minutes: e.target.value })} placeholder="45" /></label>
              <label className="grid gap-1 text-xs text-muted-foreground">Energy
                <select className={field} value={ov.energy ?? ''} onChange={(e) => setOv({ ...ov, energy: e.target.value || undefined })}>
                  <option value="">From prompt</option>{ENERGY_CURVES.map((c) => <option key={c} value={c}>{ENERGY_LABEL[c]}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">Mixing style
                <select className={field} value={ov.style ?? ''} onChange={(e) => setOv({ ...ov, style: e.target.value || undefined })}>
                  <option value="">From prompt</option>{TRANSITION_STYLES.map((c) => <option key={c} value={c}>{STYLE_LABEL[c]}</option>)}
                </select>
              </label>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" loading={busy && !interp} disabled={!prompt.trim()} data-testid="mix-interpret">Interpret my request</Button>
            <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setPrompt(EXAMPLES[(EXAMPLES.indexOf(prompt) + 1) % EXAMPLES.length])}>Try an example</button>
          </div>
        </form>
      </section>

      {spec && resolved && (
        <section aria-labelledby="interp" className="grid gap-4 rounded-xl border border-border bg-card p-5" data-testid="mix-interpretation">
          <div>
            <h2 id="interp" className="font-display text-2xl text-foreground">Here's what I understood</h2>
            <p className="mt-1 text-sm text-muted-foreground">{spec.summary}</p>
            {interp?.warning && <p className="mt-1 text-sm text-amber-400">{interp.warning}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">Genres<input className={field} value={spec.genres.join(', ')} onChange={(e) => set({ genres: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }, 'genres')} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Artists<input className={field} value={spec.artists.join(', ')} onChange={(e) => set({ artists: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }, 'artists')} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Songs<input className={field} type="number" min={2} max={30} value={resolved.songCount} onChange={(e) => set({ song_count: Number(e.target.value) }, 'song_count')} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Minutes<input className={field} type="number" min={5} max={180} value={Math.round(resolved.targetDurationSec / 60)} onChange={(e) => set({ target_duration_minutes: Number(e.target.value) }, 'target_duration_minutes')} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Energy
              <select className={field} value={resolved.energyCurve} onChange={(e) => set({ energy_curve: e.target.value as MixSpec['energy_curve'] }, 'energy_curve')}>{ENERGY_CURVES.map((c) => <option key={c} value={c}>{ENERGY_LABEL[c]}</option>)}</select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">Transitions
              <select className={field} value={resolved.transitionStyle} onChange={(e) => set({ transition_style: e.target.value as MixSpec['transition_style'] }, 'transition_style')}>{TRANSITION_STYLES.map((c) => <option key={c} value={c}>{STYLE_LABEL[c]}</option>)}</select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">Popularity
              <select className={field} value={resolved.popularity} onChange={(e) => set({ popularity: e.target.value as MixSpec['popularity'] }, 'popularity')}><option value="high">Popular</option><option value="mixed">Mixed</option><option value="underground">Underground</option></select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">Vocals
              <select className={field} value={resolved.vocals} onChange={(e) => set({ vocals: e.target.value as MixSpec['vocals'] }, 'vocals')}><option value="mixed">Either</option><option value="vocal">Vocal</option><option value="instrumental">Mostly instrumental</option></select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {resolved.features.length > 0 && <>Moments: {resolved.features.map((f) => f.replace(/_/g, ' ')).join(', ')}. </>}
            {resolved.defaulted.length > 0 && <>Defaults used for: {resolved.defaulted.map((d) => d.replace(/_/g, ' ')).join(', ')}. </>}
            Similar artists: {resolved.artistMatching === 'only_these' ? 'no' : 'allowed'} · Substitutions: {resolved.allowSubstitutions ? 'allowed' : 'not allowed'}.
          </p>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={quality === 'lossless'} onChange={(e) => setQuality(e.target.checked ? 'lossless' : 'high')} />
            Use lossless source audio where available (much larger downloads)
          </label>
          <p className="text-xs text-muted-foreground">
            Audio comes only from sources whose licences allow mixing (currently Jamendo's Creative Commons catalog). Requested artists that are only on YouTube or commercial services are listed as unavailable rather than downloaded.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={start} loading={busy} data-testid="mix-start">Find tracks and build the mix</Button>
            {import.meta.env.DEV && (
              <Button size="lg" variant="outline" onClick={startResearch} loading={busy} data-testid="mix-start-research">
                Generate locally with YouTube audio
              </Button>
            )}
          </div>
          {import.meta.env.DEV && (
            <p className="text-xs text-amber-300/90">
              Local research mode (this machine only, not for distribution): downloads the requested songs from public YouTube videos with yt-dlp and renders the mix
              locally. The live site never does this.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="your-mixes" className="grid gap-3">
        <h2 id="your-mixes" className="font-display text-3xl text-foreground">Your mixes</h2>
        <YourMixes />
      </section>
    </div>
  )
}
