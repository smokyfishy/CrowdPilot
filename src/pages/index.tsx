/**
 * Landing page — static (no DeepSpace providers), prerendered at build.
 * Keep it renderable without a browser: no window/document during render.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { Logo } from '../components/brand/Logo'
import { seo } from '../seo'

const STEPS = [
  { title: 'Start a room', body: 'Sign in, name the room, and open it on the laptop or phone connected to the speaker.' },
  { title: 'Share the code', body: 'Friends scan the QR code or type six letters. They can sign in or just pick a name.' },
  { title: 'Fill the queue', body: 'Everyone searches YouTube, adds songs and votes. You keep the controls.' },
]

/** Sleeve stack: abstract record covers standing in for album art on the static page. */
function SleeveStack() {
  return (
    <div aria-hidden="true" className="relative mx-auto h-[260px] w-full max-w-[420px] sm:h-[340px]">
      <div className="absolute left-0 top-8 aspect-square w-[58%] -rotate-6 rounded-md bg-[radial-gradient(circle_at_30%_30%,#e8d3a8_0_9%,transparent_10%),radial-gradient(circle_at_70%_75%,#c9842e_0_30%,transparent_31%),linear-gradient(135deg,#c9842e,#5b2f1f)] shadow-[0_24px_60px_rgba(0,0,0,.5)]" />
      <div className="absolute left-[22%] top-0 aspect-square w-[58%] rotate-3 rounded-md bg-[conic-gradient(from_40deg,#3a2418,#c9842e,#e8d3a8,#3a2418)] shadow-[0_24px_60px_rgba(0,0,0,.5)]" />
      <div className="absolute right-0 top-14 grid aspect-square w-[58%] rotate-[9deg] place-items-center rounded-md bg-[#1e1c1a] shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="aspect-square w-[78%] rounded-full bg-[repeating-radial-gradient(circle,#151413_0_2px,#211e1b_2px_4px)]">
          <div className="grid h-full w-full place-items-center">
            <div className="grid aspect-square w-[34%] place-items-center rounded-full bg-primary">
              <div className="size-2 rounded-full bg-background" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const cleaned = code.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6)

  function join(e: FormEvent) {
    e.preventDefault()
    if (cleaned.length === 6) navigate(`/join/${cleaned}`)
  }

  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="mx-auto flex min-h-screen max-w-6xl flex-col px-[max(16px,env(safe-area-inset-left))] pb-16">
        <header className="flex h-16 items-center justify-between">
          <Logo />
          <Link to="/home" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Your rooms
          </Link>
        </header>

        <main className="grid flex-1 items-center gap-12 py-10 md:grid-cols-[1.15fr_1fr] md:py-16">
          <div>
            <h1 className="font-display text-[clamp(2.75rem,7vw,5.25rem)] leading-[0.95] tracking-[-0.015em] text-foreground">
              Everyone picks the music. One speaker plays it.
            </h1>
            <p className="mt-6 max-w-[46ch] text-lg text-muted-foreground">
              Start a room, share the code, and let the people around you search YouTube and add songs to one shared
              queue. You stay in control of playback.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/home"
                className="inline-flex h-12 items-center rounded-full bg-primary px-7 text-[0.95rem] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Start a room
              </Link>
              <form onSubmit={join} className="flex items-center gap-2">
                <label htmlFor="landing-code" className="sr-only">
                  Room code
                </label>
                <input
                  id="landing-code"
                  value={cleaned}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Room code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  inputMode="text"
                  className="h-12 w-[10.5ch] rounded-full border border-input bg-card px-4 text-[0.95rem] font-semibold tracking-[0.14em] text-foreground placeholder:font-normal placeholder:tracking-normal placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  disabled={cleaned.length !== 6}
                  className="h-12 rounded-full border border-input px-5 text-[0.95rem] font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Join
                </button>
              </form>
            </div>
          </div>
          <SleeveStack />
        </main>

        <section aria-labelledby="how" className="border-t border-border pt-10">
          <h2 id="how" className="font-display text-3xl text-foreground">
            How a room works
          </h2>
          <ol className="mt-6 grid gap-8 sm:grid-cols-3">
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
          <p className="mt-10 max-w-[70ch] text-sm text-muted-foreground">
            Music plays from the host's device through YouTube's official player. Guests see what's playing and what's
            next on their own phones, without a second speaker going off.
          </p>
        </section>
      </div>
    </>
  )
}
