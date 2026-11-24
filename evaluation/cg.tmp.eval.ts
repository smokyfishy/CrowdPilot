import { it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { constantGrid } from '../src/dj/phase'
import { summarize } from '../src/dsp/analyze'
it('cg', () => {
  const ix = JSON.parse(readFileSync('C:/crowdpilot-data/mixgen/acquired/index.json', 'utf8'))
  for (const k of ['youtube:ywjYBs49rBo', 'youtube:SgcYNgNtdKo', 'youtube:KtGFByAJRQQ', 'youtube:zJALzXTdwV0', 'youtube:K550NF8wIeU']) {
    const f = readdirSync('C:/crowdpilot-data/mixgen/analysis').find((x) => x.startsWith(ix[k].sha256))!
    const a = JSON.parse(readFileSync('C:/crowdpilot-data/mixgen/analysis/' + f, 'utf8'))
    const s = summarize(a)
    const g = constantGrid(a.netBeats, s.durationSec)
    process.stderr.write(`CG ${k} stable=${s.stable} -> ${g ? `${g.bpm.toFixed(2)} BPM fit ${g.fitMs.toFixed(1)} ms, ${g.beats.length} beats` : 'null'}\n`)
  }
})
