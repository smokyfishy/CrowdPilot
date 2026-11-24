/** Download and credits: get the mix, and see who made each track and under which licence. */
import { Download, Music } from 'lucide-react'
import { MixDisclosure } from './MixDisclosure'
import type { MixManifest } from '@/mixgen/manifest'

export function QualityPanel({ m, downloadUrl }: { m: MixManifest; downloadUrl?: string | null }) {
  return (
    <MixDisclosure title="Download and credits" icon={<Music className="size-4" />} testId="mix-quality">
      <div className="grid max-w-prose min-w-0 gap-5 leading-relaxed [overflow-wrap:anywhere]">
        <div className="grid gap-2">
          {downloadUrl && m.permissions.export ? (
            <a href={downloadUrl} download={`${m.title}.opus`} className="inline-flex h-10 items-center gap-2 justify-self-start rounded-full bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90">
              <Download aria-hidden className="size-4" />
              Download mix
            </a>
          ) : null}
          <p className="text-muted-foreground">{m.permissions.reason}</p>
        </div>

        <section aria-label="Credits" className="grid gap-2">
          <h3 className="font-medium text-foreground">Tracks in this mix</h3>
          <ol className="grid gap-1.5 text-muted-foreground">
            {m.tracks.map((t) => (
              <li key={t.key}>
                {t.url ? (
                  <a href={t.url} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                    {t.title}
                  </a>
                ) : (
                  <span className="text-foreground">{t.title}</span>
                )}{' '}
                by {t.artist}
                <span className="block text-xs">
                  {t.license.url ? (
                    <a href={t.license.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {t.license.label}
                    </a>
                  ) : (
                    t.license.label
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>

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
      </div>
    </MixDisclosure>
  )
}
