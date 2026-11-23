/**
 * Optional preferences as compact pill controls. Every one defaults to "Auto" (taken from the
 * description); a set value overrides what the AI read from the prompt.
 */
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { ENERGY_CURVES, TRANSITION_STYLES, type MixSpec } from '@/mixgen/spec'
import { ENERGY_LABEL, STYLE_LABEL } from '../labels'

export interface Prefs {
  minutes?: string
  count?: string
  genre?: string
  energy?: string
  style?: string
}

export interface AdvancedPrefs {
  popularity?: string
  vocals?: string
  lossless: boolean
  reviewFirst: boolean
  automationModel?: MixSpec['automation_model']
}

const GENRES = ['House', 'Tech house', 'Deep house', 'Techno', 'Melodic techno', 'EDM', 'Progressive house', 'Drum and bass', 'Disco', 'Afro house', 'Trance', 'Lo-fi']

function Pill({ label, value, children }: { label: string; value: boolean; children: ReactNode }) {
  return (
    <label
      className={`group relative inline-flex h-9 items-center gap-1.5 rounded-full border pl-3.5 pr-8 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring/60 ${
        value ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border bg-background/40 text-muted-foreground hover:border-foreground/25 hover:text-foreground'
      }`}
    >
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 size-3.5 text-muted-foreground" />
    </label>
  )
}

const selectCls = 'min-w-0 cursor-pointer appearance-none [field-sizing:content] bg-transparent text-sm font-medium text-inherit outline-none [&>option]:bg-card [&>option]:text-foreground'

export function MixPreferences({ prefs, onChange }: { prefs: Prefs; onChange: (p: Prefs) => void }) {
  const set = (k: keyof Prefs) => (e: { target: { value: string } }) => onChange({ ...prefs, [k]: e.target.value || undefined })
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Mix preferences (optional)">
      <Pill label="Duration" value={!!prefs.minutes}>
        <select className={selectCls} value={prefs.minutes ?? ''} onChange={set('minutes')} data-testid="pref-minutes">
          <option value="">Auto</option>
          {[15, 20, 30, 45, 60, 90, 120].map((m) => (
            <option key={m} value={m}>{m} min</option>
          ))}
        </select>
      </Pill>
      <Pill label="Songs" value={!!prefs.count}>
        <select className={selectCls} value={prefs.count ?? ''} onChange={set('count')} data-testid="pref-count">
          <option value="">Auto</option>
          {[4, 6, 8, 10, 12, 15, 20, 25, 30].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </Pill>
      <Pill label="Genre" value={!!prefs.genre}>
        <select className={selectCls} value={prefs.genre ?? ''} onChange={set('genre')} data-testid="pref-genre">
          <option value="">Auto</option>
          {GENRES.map((g) => (
            <option key={g} value={g.toLowerCase()}>{g}</option>
          ))}
        </select>
      </Pill>
      <Pill label="Energy" value={!!prefs.energy}>
        <select className={selectCls} value={prefs.energy ?? ''} onChange={set('energy')} data-testid="pref-energy">
          <option value="">Auto</option>
          {ENERGY_CURVES.map((c) => (
            <option key={c} value={c}>{ENERGY_LABEL[c]}</option>
          ))}
        </select>
      </Pill>
      <Pill label="Mixing" value={!!prefs.style}>
        <select className={selectCls} value={prefs.style ?? ''} onChange={set('style')} data-testid="pref-style">
          <option value="">Auto</option>
          {TRANSITION_STYLES.map((c) => (
            <option key={c} value={c}>{STYLE_LABEL[c]}</option>
          ))}
        </select>
      </Pill>
    </div>
  )
}

export function AdvancedPreferences({ adv, onChange, children }: { adv: AdvancedPrefs; onChange: (a: AdvancedPrefs) => void; children?: ReactNode }) {
  const field = 'h-9 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground'
  return (
    <details className="group text-sm" data-testid="mix-advanced">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">▸</span>
        Advanced options
      </summary>
      <div className="mt-3 grid gap-4 rounded-xl border border-border bg-card/40 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Track popularity
            <select className={field} value={adv.popularity ?? ''} onChange={(e) => onChange({ ...adv, popularity: e.target.value || undefined })}>
              <option value="">Auto</option>
              <option value="high">Popular</option>
              <option value="mixed">Mixed</option>
              <option value="underground">Underground</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Vocals
            <select className={field} value={adv.vocals ?? ''} onChange={(e) => onChange({ ...adv, vocals: e.target.value || undefined })}>
              <option value="">Auto</option>
              <option value="vocal">Vocal tracks</option>
              <option value="instrumental">Mostly instrumental</option>
              <option value="mixed">Either</option>
            </select>
          </label>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          DJ automation
          <select className={field} value={adv.automationModel ?? 'standard'} onChange={(e) => onChange({ ...adv, automationModel: e.target.value as AdvancedPrefs['automationModel'] })} data-testid="pref-automation-model">
            <option value="standard">Standard (MixGraph + DJCritic)</option>
            <option value="transitionnet">TransitionNet + MixGraph and DJCritic</option>
            <option value="transitionnet-only">TransitionNet only</option>
          </select>
          <span>TransitionNet predicts deck and effect controls for supported transitions.</span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-foreground">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={adv.reviewFirst} onChange={(e) => onChange({ ...adv, reviewFirst: e.target.checked })} data-testid="pref-review" />
          <span>
            Review tracks before mixing
            <span className="block text-xs text-muted-foreground">Pause after the tracks are chosen so you can swap any of them.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-foreground">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={adv.lossless} onChange={(e) => onChange({ ...adv, lossless: e.target.checked })} />
          <span>
            Lossless source audio
            <span className="block text-xs text-muted-foreground">Uses lossless files where available. Much larger downloads.</span>
          </span>
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Music comes only from catalogs whose licences allow mixing (currently Jamendo's Creative Commons catalog). Artists that are only on YouTube or commercial services are listed as unavailable and replaced with similar licensed tracks.
        </p>
        {children}
      </div>
    </details>
  )
}
