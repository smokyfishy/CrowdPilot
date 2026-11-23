/** The large natural-language prompt with example starters and the one Generate action. */
import type { FormEvent, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'

export const EXAMPLES: Array<{ label: string; prompt: string }> = [
  {
    label: 'Festival house & EDM',
    prompt:
      'A 45-minute house and EDM mix with 12 popular tracks. I like John Summit, Dom Dolla, Fisher and Chris Lake. Start groovy, build the energy, include a few big drops and finish with a festival-style closer. Smooth but creative transitions.',
  },
  { label: 'Tech house build', prompt: 'A 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines and smooth transitions.' },
  { label: 'Deep house sunset', prompt: 'A 30-minute deep house sunset set, mostly instrumental, relaxed at first and warmer toward the end.' },
]

export function MixPromptEditor({ value, onChange, onSubmit, busy, busyLabel, controls }: { value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean; busyLabel: string; controls: ReactNode }) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() && !busy) onSubmit()
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="rounded-2xl border border-border bg-card/70 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.6)] transition-colors focus-within:border-primary/50">
        <label htmlFor="mix-prompt" className="sr-only">Describe your mix</label>
        <textarea
          id="mix-prompt"
          data-testid="mix-prompt"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
          }}
          rows={4}
          maxLength={2000}
          placeholder="Describe your perfect DJ set… genres, artists, energy, mood, and mixing style."
          className="block min-h-32 w-full resize-y rounded-t-2xl bg-transparent px-5 pb-2 pt-5 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none sm:text-lg"
          aria-describedby="mix-prompt-hint"
        />
        <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">{controls}</div>
          <Button type="submit" size="lg" loading={busy} disabled={!value.trim()} className="w-full shrink-0 sm:w-auto" data-testid="mix-generate">
            {!busy && <Sparkles aria-hidden />}
            {busy ? busyLabel : 'Generate Mix'}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2" id="mix-prompt-hint">
        <span className="text-xs text-muted-foreground">Try:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.label} type="button" className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground" onClick={() => onChange(ex.prompt)}>
            {ex.label}
          </button>
        ))}
      </div>
    </form>
  )
}
