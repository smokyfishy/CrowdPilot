/**
 * Landing page — static (no DeepSpace providers), prerendered at build.
 * Keep it renderable without a browser: no window/document during render.
 */
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { Logo } from '../components/brand/Logo'
import { seo } from '../seo'

const STEPS = [
  { title: 'Describe your mix', body: 'Genre, length, energy, artists you like, the kind of transitions you want — in your own words. Review and tweak what CrowdPilot understood.' },
  { title: 'Discover songs', body: 'CrowdPilot searches music catalogs, verifies each recording, gets audio from sources that allow mixing, and analyzes beats, key, phrases and energy.' },
  { title: 'Generate the mix', body: 'It orders the set for your energy arc, plans every transition on the beat grid, and renders one continuous audio file.' },
  { title: 'Listen and explore', body: 'Play it with a waveform of the actual rendered audio, jump to any track, inspect each transition, refine it in words, and download it.' },
]

const FEATURES = [
  { title: 'Real beat-matched blends', body: 'Pitch-preserving tempo matching, phrase-aligned cue points, EQ bass swaps, filter sweeps, drop swaps and echo-outs — chosen per pair, not one crossfade for everything.' },
  { title: 'One continuous recording', body: 'Rendered offline as a single file, with a look-ahead limiter and loudness matching. Every mix is checked for gaps, clipping and level jumps.' },
  { title: 'Honest about sources', body: 'Audio comes only from sources whose licences allow mixing (Creative Commons music from Jamendo). Requested songs without such a source are listed as unavailable.' },
]

/** Abstract waveform + sleeve illustration (static, decorative). */
function WaveArt() {
  const bars = Array.from({ length: 64 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11 + 1)))
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-[460px]">
      <div className="absolute -left-4 -top-6 aspect-square w-[46%] -rotate-6 rounded-md bg-[radial-gradient(circle_at_30%_30%,#e8d3a8_0_9%,transparent_10%),radial-gradient(circle_at_70%_75%,#c9842e_0_30%,transparent_31%),linear-gradient(135deg,#c9842e,#5b2f1f)] opacity-80 shadow-[0_24px_60px_rgba(0,0,0,.5)]" />
      <div className="relative mt-16 rounded-xl border border-border bg-[#171513] p-4 shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="mb-3 flex gap-1">
          {['#c9842e', '#7f9c8a', '#b5654a', '#8a87b8', '#c2a35a'].map((c, i) => (
            <div key={c} className="h-1 rounded-full" style={{ background: c, flex: [3, 2, 4, 2, 3][i] }} />
          ))}
        </div>
        <div className="flex h-28 items-center gap-[3px]">
          {bars.map((h, i) => (
            <div key={i} className="flex-1 rounded-sm" style={{ height: `${h * 100}%`, background: i < 26 ? '#e8d3a8' : '#6f685f' }} />
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>12 tracks · 44:41</span>
          <span>Bass swap → Drop swap → Long blend</span>
        </div>
      </div>
    </div>
  )
}

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="mx-auto flex min-h-screen max-w-6xl flex-col px-[max(16px,env(safe-area-inset-left))] pb-16">
        <header className="flex h-16 items-center justify-between">
          <Logo />
          <Link to="/mix" className="text-sm font-semibold text-foreground transition-colors hover:text-primary">
            Your mixes
          </Link>
        </header>

        <main className="grid flex-1 items-center gap-12 py-10 md:grid-cols-[1.15fr_1fr] md:py-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">AI DJ mix generator</p>
            <h1 className="mt-3 font-display text-[clamp(2.75rem,7vw,5.25rem)] leading-[0.95] tracking-[-0.015em] text-foreground">
              Describe your dream DJ set. CrowdPilot creates it.
            </h1>
            <p className="mt-6 max-w-[48ch] text-lg text-muted-foreground">
              Tell it the mix you want. CrowdPilot finds the songs, analyzes every beat, and renders one continuous set with real
              beat-matched transitions you can play, explore and download.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/mix"
                data-testid="landing-generate"
                className="inline-flex h-12 items-center rounded-full bg-primary px-7 text-[0.95rem] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Generate AI Mix
              </Link>
              <a href="#how" className="inline-flex h-12 items-center rounded-full border border-input px-6 text-[0.95rem] font-semibold text-foreground transition-colors hover:bg-accent">
                How it works
              </a>
            </div>
          </div>
          <WaveArt />
        </main>

        <section id="how" aria-labelledby="how-heading" className="border-t border-border pt-10">
          <h2 id="how-heading" className="font-display text-3xl text-foreground">
            Describe → Discover → Generate → Listen
          </h2>
          <ol className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-3">
                <span className="font-display text-2xl leading-none text-primary">{i + 1}</span>
                <div>
                  <h3 className="font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-1 text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="features" className="mt-14 grid gap-6 border-t border-border pt-10 md:grid-cols-3">
          <h2 id="features" className="sr-only">
            What makes it a real mix
          </h2>
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-card p-5">
              <h3 className="font-semibold text-foreground">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-14 grid gap-4 rounded-2xl border border-primary/40 bg-card p-6 sm:p-8 md:grid-cols-[1.4fr_auto] md:items-center">
          <p className="font-display text-[clamp(1.6rem,3.5vw,2.4rem)] leading-tight text-foreground">
            “A 40-minute tech house mix with a gradual energy build, strong basslines and smooth transitions.”
          </p>
          <Link to="/mix" className="inline-flex h-12 items-center justify-center rounded-full bg-primary px-7 text-[0.95rem] font-semibold text-primary-foreground hover:bg-primary/90">
            Try it
          </Link>
        </section>
      </div>
    </>
  )
}
