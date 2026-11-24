/** Quality, licence and download: what was checked in the finished audio, who made the music, and how it may be used. */
import { Check, Download, ShieldCheck, X } from 'lucide-react'
import { MixDisclosure } from './MixDisclosure'
import type { MixManifest } from '@/mixgen/manifest'

/** Plain-language names for the validator's checks (the raw name stays available as a tooltip). */
const CHECK_NAME: Array<[RegExp, string]> = [
  [/^continuous audio/, 'No gaps or silence'],
  [/^no clipped samples/, 'No clipping'],
  [/^sample peak/, 'Safe peak level'],
  [/^no sudden volume jumps/, 'No volume jumps at transitions'],
  [/^loudness matched/, 'Even loudness between tracks'],
  [/^integrated loudness/, 'Overall loudness in range'],
  [/^all tracks present/, 'Every track included'],
  [/^timeline monotone/, 'Tracks play in order'],
  [/^duration near target/, 'Length matches the request'],
  [/^real overlapping transitions/, 'Tracks really blend'],
  [/^sample-aligned splices/, 'Clean joins'],
  [/^waveform matches length/, 'Waveform matches the audio'],
  [/^no unintended abrupt cuts/, 'No accidental cuts'],
  [/^transitions pass rendered-audio checks/, 'Transitions pass audio checks'],
  [/^every transition ≥ 16 bars/, 'Every transition 16+ bars, no loop rolls'],
]
export function checkLabel(raw: string): string {
  const hit = CHECK_NAME.find(([re]) => re.test(raw))
  return hit ? hit[1] : raw.charAt(0).toUpperCase() + raw.slice(1)
}

export function QualityPanel({ m, downloadUrl }: { m: MixManifest; downloadUrl?: string | null }) {
  const checks = m.validation?.checks ?? []
  const failed = checks.filter((c) => !c.ok)
  const passed = checks.filter((c) => c.ok)
  const aside = checks.length ? (failed.length ? `${failed.length} check${failed.length > 1 ? 's' : ''} need attention` : `All ${checks.length} checks passed`) : undefined
  return (
    <MixDisclosure title="Audio checks, licences and downloads" icon={<ShieldCheck className="size-4" />} testId="mix-quality" aside={aside}>
      <div className="grid min-w-0 gap-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {downloadUrl && m.permissions.export ? (
            <a href={downloadUrl} download={`${m.title}.opus`} className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90">
              <Download aria-hidden className="size-4" />
              Download mix
            </a>
          ) : null}
          <p className="min-w-0 flex-1 text-muted-foreground">{m.permissions.reason}</p>
        </div>

        {checks.length > 0 && (
          <section aria-label="Audio checks" className="grid gap-2">
            <h3 className="font-medium text-foreground">{failed.length ? `${passed.length} of ${checks.length} checks passed` : `All ${checks.length} audio checks passed`}</h3>
            {failed.length > 0 && (
              <ul className="grid gap-1.5">
                {failed.map((c) => (
                  <li key={c.name} className="flex min-w-0 items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                    <X aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <span className="min-w-0" title={c.name}>
                      <span className="text-foreground">{checkLabel(c.name)}</span>
                      <span className="block text-xs text-muted-foreground">Measured {c.value}; limit {c.limit}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {passed.map((c) => (
                <li key={c.name} className="flex min-w-0 items-center gap-2 text-muted-foreground" title={`${c.name}: ${c.value}`}>
                  <Check aria-hidden className="size-3.5 shrink-0 text-emerald-400" />
                  <span className="min-w-0 truncate">{checkLabel(c.name)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {m.unavailable.length > 0 && (
          <section aria-label="Songs left out" className="grid gap-1.5">
            <h3 className="font-medium text-foreground">Requested but left out</h3>
            <ul className="grid gap-1 text-muted-foreground">
              {m.unavailable.map((u) => (
                <li key={u.request}>
                  <span className="text-foreground">{u.request}</span>: {u.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        {m.attribution.length > 0 && (
          <section aria-label="Credits" className="grid gap-1.5">
            <h3 className="font-medium text-foreground">Credits and licences</h3>
            <ul className="grid gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {m.attribution.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </MixDisclosure>
  )
}
