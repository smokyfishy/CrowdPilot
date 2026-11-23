/**
 * /research — LOCAL research mode (dev server only, localhost only). Starts the research CLI as a
 * child process through the dev-only /__research/jobs route and shows its real output. Production
 * builds render "Not found" and the Worker answers 404 for /__research/*.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button, Textarea } from '@/components/ui'

interface Job {
  id: string
  prompt: string
  status: 'running' | 'done' | 'failed'
  lines?: string[]
  startedAt: number
  finishedAt?: number
}

const EXAMPLE = 'Create a 45-minute house and EDM mix with 12 popular tracks. I like John Summit, Dom Dolla, Fisher, Chris Lake, and similar artists. Start groovy, gradually increase the energy, include several big drops, and finish with a festival-style closing track. Make the transitions smooth, professional, and creative.'
const field = 'h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground'

export default function ResearchHome() {
  const [prompt, setPrompt] = useState('')
  const [songs, setSongs] = useState('')
  const [minutes, setMinutes] = useState('')
  const [ml, setMl] = useState<'default' | 'off' | 'experimental'>('default')
  const [tn, setTn] = useState(false)
  const [style, setStyle] = useState('')
  const [active, setActive] = useState<Job | null>(null)
  const [past, setPast] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    fetch('/__research/')
      .then((r) => r.json() as Promise<{ jobs: string[] }>)
      .then((b) => setPast(b.jobs.sort().reverse()))
      .catch(() => undefined)
    fetch('/__research/jobs')
      .then((r) => r.json() as Promise<{ jobs: Job[] }>)
      .then((b) => {
        const running = b.jobs.find((j) => j.status === 'running')
        if (running) setActive(running)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!active || active.status !== 'running') return
    const t = setInterval(async () => {
      const r = await fetch(`/__research/jobs/${active.id}`).catch(() => null)
      if (!r?.ok) return
      const j = (await r.json()) as Job
      setActive(j)
      if (j.status === 'done') setPast((p) => [j.id, ...p.filter((x) => x !== j.id)])
    }, 1500)
    return () => clearInterval(t)
  }, [active])

  async function start(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const r = await fetch('/__research/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, songs: songs ? Number(songs) : undefined, minutes: minutes ? Number(minutes) : undefined, ml, transitionNet: tn, style: style || undefined }),
    })
    const b = (await r.json()) as { id?: string; error?: string }
    if (!r.ok || !b.id) return setErr(b.error ?? `failed (${r.status})`)
    setActive({ id: b.id, prompt, status: 'running', lines: [], startedAt: Date.now() })
  }

  if (!import.meta.env.DEV) return <div className="mx-auto max-w-3xl p-10 text-muted-foreground">Not found.</div>
  const lines = active?.lines ?? []
  const progress = [...lines].reverse().find((l) => /^\[\s*\d+s\]/.test(l))
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8">
      <title>Research mode · CrowdPilot (local)</title>
      <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-200" role="note">
        <strong>Research mode — local only, not for distribution.</strong> Songs are found on YouTube and downloaded with yt-dlp on this machine (public videos only — no
        sign-in, age-restricted, members-only or DRM content). Mixes stay in C:\crowdpilot-data\mixgen\exports\research and are never uploaded.
      </div>
      <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-none text-foreground">Research mix generator</h1>
      <form onSubmit={start} className="grid gap-3">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={2000} placeholder={EXAMPLE} aria-label="Describe your mix" data-testid="research-prompt" />
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">Songs<input className={`${field} w-24`} type="number" min={2} max={30} value={songs} onChange={(e) => setSongs(e.target.value)} placeholder="from prompt" /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">Minutes<input className={`${field} w-24`} type="number" min={5} max={180} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="from prompt" /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">Transitions
            <select className={field} value={style} onChange={(e) => setStyle(e.target.value)} data-testid="research-style">
              <option value="">From prompt</option>
              <option value="creative">Creative (effects, rolls, echoes)</option>
              <option value="energetic">Energetic (drop swaps, tempo rides)</option>
              <option value="smooth_creative">Smooth &amp; creative</option>
              <option value="smooth">Smooth (long blends)</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">ML models
            <select className={field} value={ml} onChange={(e) => setMl(e.target.value as typeof ml)}>
              <option value="default">Default (MixGraph + DJCritic)</option>
              <option value="off">Off (rules only)</option>
              <option value="experimental">Experimental</option>
            </select>
          </label>
          <label className="flex h-10 items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={tn} onChange={(e) => setTn(e.target.checked)} /> TransitionNet</label>
          <Button type="submit" disabled={!prompt.trim() || active?.status === 'running'} data-testid="research-start">Generate</Button>
          <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => setPrompt(EXAMPLE)}>Example</button>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </form>

      {active && (
        <section className="grid gap-2 rounded-xl border border-border bg-card p-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-foreground">
              {active.status === 'running' ? 'Working…' : active.status === 'done' ? 'Finished' : 'Failed'} · {active.id}
            </p>
            {active.status === 'done' && (
              <Link to={`/research/${active.id}`} className="inline-flex h-10 items-center rounded-full bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90">
                Open the mix
              </Link>
            )}
          </div>
          {progress && <p className="font-mono text-xs text-muted-foreground">{progress}</p>}
          <pre className="max-h-96 overflow-auto rounded-lg bg-[#171513] p-3 text-[11px] leading-relaxed text-muted-foreground">{lines.slice(-200).join('\n') || 'starting…'}</pre>
        </section>
      )}

      <section className="grid gap-2">
        <h2 className="font-display text-2xl text-foreground">Local research mixes</h2>
        {past.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {past.map((j) => (
              <li key={j}>
                <Link to={`/research/${j}`} className="text-primary hover:underline">{j}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
