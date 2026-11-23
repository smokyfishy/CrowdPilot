/**
 * Optional preferences as compact pill controls. Every one defaults to "Auto" (taken from the
 * description); a set value overrides what the AI read from the prompt.
 */
import type { ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui'
import { MixDisclosure } from '../MixDisclosure'
import { ENERGY_CURVES, TRANSITION_STYLES } from '@/mixgen/spec'
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
}

const GENRES = ['House', 'Tech house', 'Deep house', 'Techno', 'Melodic techno', 'EDM', 'Progressive house', 'Drum and bass', 'Disco', 'Afro house', 'Trance', 'Lo-fi']

type Option = readonly [value: string, label: string]

function PreferenceSelect({ label, value, onChange, options, testId, compact = false }: {
  label: string
  value?: string
  onChange: (value?: string) => void
  options: readonly Option[]
  testId?: string
  compact?: boolean
}) {
  return (
    <div className={compact ? 'min-w-0 max-w-full' : 'grid min-w-0 gap-1.5'}>
      {!compact && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      <Select value={value ?? 'auto'} onValueChange={(next) => onChange(next === 'auto' ? undefined : next)}>
        <SelectTrigger aria-label={label} data-testid={testId} className={
          compact
            ? `h-10 w-auto max-w-full rounded-full px-3 shadow-none ${value ? 'border-primary/45 bg-primary/10' : 'bg-background/50'}`
            : 'h-10 min-w-0 bg-background/55 shadow-none'
        }>
          {compact && <span className="!flex-none text-xs text-muted-foreground">{label}</span>}
          <SelectValue className={`truncate font-medium ${compact ? 'max-w-36 sm:max-w-44' : ''}`} />
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-1rem)] min-w-36 rounded-xl p-1.5 shadow-xl">
          <SelectItem value="auto" className="text-muted-foreground data-[selected]:bg-primary/10 data-[selected]:text-primary">Auto</SelectItem>
          {options.map(([id, name]) => (
            <SelectItem key={id} value={id} className="min-h-10 data-[selected]:bg-primary/10 data-[selected]:text-primary">{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

const PREFERENCES: ReadonlyArray<{ key: keyof Prefs; label: string; options: readonly Option[] }> = [
  { key: 'minutes', label: 'Duration', options: [15, 20, 30, 45, 60, 90, 120].map((n) => [String(n), `${n} min`]) },
  { key: 'count', label: 'Songs', options: [4, 6, 8, 10, 12, 15, 20, 25, 30].map((n) => [String(n), String(n)]) },
  { key: 'genre', label: 'Genre', options: GENRES.map((genre) => [genre.toLowerCase(), genre]) },
  { key: 'energy', label: 'Energy', options: ENERGY_CURVES.map((key) => [key, ENERGY_LABEL[key]]) },
  { key: 'style', label: 'Mixing', options: TRANSITION_STYLES.map((key) => [key, STYLE_LABEL[key]]) },
]

export function MixPreferences({ prefs, onChange }: { prefs: Prefs; onChange: (p: Prefs) => void }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Mix preferences (optional)">
      {PREFERENCES.map(({ key, label, options }) => (
        <PreferenceSelect key={key} label={label} value={prefs[key]} onChange={(value) => onChange({ ...prefs, [key]: value })} options={options} testId={`pref-${key}`} compact />
      ))}
    </div>
  )
}

export function AdvancedPreferences({ adv, onChange, children }: { adv: AdvancedPrefs; onChange: (a: AdvancedPrefs) => void; children?: ReactNode }) {
  return (
    <MixDisclosure title="Advanced options" icon={<SlidersHorizontal className="size-4" />} testId="mix-advanced">
      <div className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <PreferenceSelect label="Track popularity" value={adv.popularity} onChange={(popularity) => onChange({ ...adv, popularity })}
            options={[[ 'high', 'Popular' ], [ 'mixed', 'Mixed' ], [ 'underground', 'Underground' ]]} />
          <PreferenceSelect label="Vocals" value={adv.vocals} onChange={(vocals) => onChange({ ...adv, vocals })}
            options={[[ 'vocal', 'Vocal tracks' ], [ 'instrumental', 'Mostly instrumental' ], [ 'mixed', 'Either' ]]} />
        </div>
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
    </MixDisclosure>
  )
}
