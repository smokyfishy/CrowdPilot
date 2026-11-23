/**
 * /research/:job — LOCAL research-mode viewer (dev server only). Reads the manifest, report and
 * MP3 from the dev-only, localhost-only /__research route. In production builds this page renders
 * "Not found" and the Worker answers 404 for /__research/*.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MixPlayer } from '@/components/mix/MixPlayer'
import type { MixManifest } from '@/mixgen/manifest'

interface Report {
  songs: Array<{ trackKey: string; artist: string; title: string; status: string; selected: boolean; position?: number; bpm?: number; key?: string; attempts: Array<{ key: string; uploader?: string; outcome: string; reason: string }> }>
  specSource: string
  prompt: string
}

export default function ResearchViewer() {
  const { job = '' } = useParams()
  const [m, setM] = useState<MixManifest | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const base = `/__research/${encodeURIComponent(job)}`
    Promise.all([fetch(`${base}/manifest.json`), fetch(`${base}/report.json`)])
      .then(async ([a, b]) => {
        if (!a.ok) throw new Error(`manifest ${a.status}`)
        setM((await a.json()) as MixManifest)
        if (b.ok) setReport((await b.json()) as Report)
      })
      .catch((e: Error) => setErr(e.message))
  }, [job])
  if (!import.meta.env.DEV) return <div className="mx-auto max-w-3xl p-10 text-muted-foreground">Not found.</div>
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 [overflow-wrap:anywhere] px-4 py-8">
      <title>{`Research ${job} · CrowdPilot (local)`}</title>
      <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-200" role="note">
        <strong>Research mode — local only, not for distribution.</strong> Audio was acquired from YouTube for private, noncommercial research on this machine. Nothing here is uploaded or served by crowdpilot.app.space.
      </div>
      <Link to="/mix" className="text-sm text-muted-foreground hover:text-foreground">← Mix generator</Link>
      {err && <p className="text-destructive">Could not load research job “{job}”: {err}</p>}
      {m && <MixPlayer manifest={m} audioSrc={`/__research/${encodeURIComponent(job)}/mix.mp3`} downloadUrl={null} />}
      {report && (
        <section className="grid gap-2">
          <h2 className="font-display text-2xl text-foreground">Acquisition report</h2>
          <p className="text-sm text-muted-foreground">Interpretation: {report.specSource}. Prompt: “{report.prompt}”</p>
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {report.songs.map((s) => (
              <li key={s.trackKey} className="grid gap-1 px-4 py-2">
                <p className="text-foreground">
                  {s.selected ? `${(s.position ?? 0) + 1}. ` : '– '}
                  {s.artist} – {s.title} <span className="text-muted-foreground">· {s.status}{s.bpm ? ` · ${s.bpm} BPM ${s.key}` : ''}</span>
                </p>
                <ul className="pl-4 text-xs text-muted-foreground">
                  {s.attempts.map((a, i) => (
                    <li key={i}>
                      {a.key}
                      {a.uploader ? ` [${a.uploader}]` : ''}: {a.outcome}
                      {a.outcome === 'failed' ? ` — ${a.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
