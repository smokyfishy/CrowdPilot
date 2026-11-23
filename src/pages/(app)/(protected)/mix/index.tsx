/**
 * /mix — "Create your mix". One prompt, optional compact preferences, one Generate action.
 * Generate interprets the description, applies any preference the user set explicitly,
 * creates the mix record and goes straight to its page, where generation starts.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, useToast } from '@/components/ui'
import { mixApi, tabRunner } from '@/mixgen/browser/client'
import { resolveSpec, type MixSpec } from '@/mixgen/spec'
import { MixPromptEditor } from '@/components/mix/create/MixPromptEditor'
import { AdvancedPreferences, MixPreferences, type AdvancedPrefs, type Prefs } from '@/components/mix/create/MixPreferences'
import { RecentMixes } from '@/components/mix/create/RecentMixes'

function applyOverrides(s: MixSpec, p: Prefs, a: AdvancedPrefs): MixSpec {
  const out: MixSpec = { ...s, explicit: [...s.explicit] }
  const mark = (k: string) => !out.explicit.includes(k) && out.explicit.push(k)
  if (p.genre) (out.genres = p.genre.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean)), mark('genres')
  if (p.count) (out.song_count = Math.max(2, Math.min(30, Number(p.count)))), mark('song_count')
  if (p.minutes) (out.target_duration_minutes = Math.max(5, Math.min(180, Number(p.minutes)))), mark('target_duration_minutes')
  if (p.energy) (out.energy_curve = p.energy as MixSpec['energy_curve']), mark('energy_curve')
  if (p.style) (out.transition_style = p.style as MixSpec['transition_style']), mark('transition_style')
  if (a.popularity) (out.popularity = a.popularity as MixSpec['popularity']), mark('popularity')
  if (a.vocals) (out.vocals = a.vocals as MixSpec['vocals']), mark('vocals')
  out.automation_model = 'transitionnet'
  return out
}

export default function MixCreate() {
  const navigate = useNavigate()
  const toast = useToast()
  const [prompt, setPrompt] = useState('')
  const [prefs, setPrefs] = useState<Prefs>({})
  const [adv, setAdv] = useState<AdvancedPrefs>({ lossless: false, reviewFirst: false })
  const [busy, setBusy] = useState<null | 'understanding' | 'starting'>(null)

  async function interpretPrompt(): Promise<{ spec: MixSpec; source: string } | null> {
    setBusy('understanding')
    try {
      const r = await mixApi.interpret(prompt.trim())
      if (r.warning) toast.warning('Heads up', r.warning)
      return { spec: applyOverrides(r.spec, prefs, adv), source: r.source }
    } catch (err) {
      toast.error("Couldn't understand that description", `${(err as Error).message}. Try rephrasing, or set the preferences below the prompt.`)
      setBusy(null)
      return null
    }
  }

  async function generate() {
    const i = await interpretPrompt()
    if (!i) return
    setBusy('starting')
    try {
      const r = await mixApi.create({ prompt: prompt.trim(), spec: i.spec, specSource: i.source, title: resolveSpec(i.spec).title })
      sessionStorage.setItem(`mix-quality:${r.id}`, adv.lossless ? 'lossless' : 'high')
      if (adv.reviewFirst) sessionStorage.setItem(`mix-review:${r.id}`, '1')
      tabRunner.mark(r.id)
      navigate(`/mix/${r.id}`)
    } catch (err) {
      toast.error("Couldn't start the mix", (err as Error).message)
      setBusy(null)
    }
  }

  /** Dev only: hand the interpreted request to local research mode (YouTube via yt-dlp). */
  async function startResearch() {
    if (!prompt.trim()) return
    const i = await interpretPrompt()
    if (!i) return
    try {
      const r = await fetch('/__research/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, spec: i.spec }) })
      const b = (await r.json()) as { id?: string; error?: string }
      if (!r.ok || !b.id) throw new Error(b.error ?? `failed (${r.status})`)
      navigate('/research')
    } catch (err) {
      toast.error('Could not start local research mode', (err as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-14 px-[max(16px,env(safe-area-inset-left))] pb-20 pt-10 sm:pt-16">
      <title>Create your mix · CrowdPilot</title>
      <section className="grid gap-7" aria-labelledby="create-title">
        <header className="grid gap-3">
          <h1 id="create-title" className="font-display text-[clamp(2.6rem,7vw,4.25rem)] leading-[0.95] tracking-[-0.01em] text-foreground">
            Create your mix
          </h1>
          <p className="max-w-[52ch] text-muted-foreground">Describe the set you want to hear. CrowdPilot finds the music and mixes it into one continuous, beat-matched DJ set.</p>
        </header>
        <MixPromptEditor
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => void generate()}
          busy={busy !== null}
          busyLabel={busy === 'starting' ? 'Starting…' : 'Reading your description…'}
          controls={<MixPreferences prefs={prefs} onChange={setPrefs} />}
        />
        <AdvancedPreferences adv={adv} onChange={setAdv}>
          {import.meta.env.DEV && (
            <div className="grid gap-2 border-t border-border pt-3">
              <p className="text-xs text-amber-300/90">Local research mode (this machine only, not for distribution): downloads the requested songs from public YouTube videos with yt-dlp and renders locally. The live site never does this.</p>
              <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void startResearch()} disabled={!prompt.trim() || busy !== null} data-testid="mix-start-research">
                Generate locally with YouTube audio
              </Button>
            </div>
          )}
        </AdvancedPreferences>
      </section>

      <section aria-labelledby="your-mixes" className="grid gap-3">
        <h2 id="your-mixes" className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Your mixes</h2>
        <RecentMixes />
      </section>
    </div>
  )
}
