/** The large natural-language prompt with example starters and the one Generate action. */
import type { FormEvent, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'

/** Starters sized for a reasonable wait: a 5-minute set with 4–6 songs generates in about 6 minutes. */
export const EXAMPLES: Array<{ label: string; prompt: string }> = [
  { label: 'Tech house build', prompt: 'A 5-minute tech house set with 5 songs that builds gradually, with strong basslines and smooth long blends.' },
  { label: 'Drop swaps', prompt: 'A 5-minute EDM set with 4 songs, building into every drop with drop swaps and no loop rolls.' },
  { label: 'Deep house sunset', prompt: 'A 5-minute deep house sunset set with 6 songs, mostly instrumental, relaxed at first and warmer toward the end.' },
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
          placeholder="Describe your set: length, number of songs, genre, energy and mixing style. For example: a 5-minute tech house set with 5 songs that builds gradually."
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
        <p className="w-full text-xs text-muted-foreground">A 5-minute set with 4–6 songs takes about 6 minutes to generate; longer sets take longer.</p>
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
