/**
 * Blind A/B listening set: the SAME track pairs rendered by the previously deployed algorithm
 * ("legacy": DSP grid + old planner + shelving EQ, code restored from commit 5859511) and the
 * current one ("v2": Beat This! grid + local refinement + new planner + LR4 isolator).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ab.eval.ts
 *
 * Writes C:\crowdpilot-data\listening\ (private; never committed or deployed — the tracks'
 * licences do not allow redistribution): index.html, version_*.wav, key.json (label map,
 * kept out of the page), manifest.json (plans, hashes, versions).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize } from '../src/dsp/analyze'
import { encodeWav, renderTransition } from '../src/dj/render'
import { bestTransition, DEFAULT_OPTIONS, type PlanTrack } from '../src/dj/transitions'
import { refineWithLocalBeats } from '../src/dj/phase'
import { trimDbFor } from '../src/dj/engine/deck-engine'
import { bestTransition as legacyBest, DEFAULT_OPTIONS as LEGACY_OPTS } from './legacy/transitions'
import { renderTransition as legacyRender } from './legacy/render'
import { readWav } from './wav'

const ROOT = 'C:/crowdpilot-data'
const OUT = join(ROOT, 'listening')

function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

it('build blind A/B listening set', () => {
  mkdirSync(OUT, { recursive: true })
  const corpus = JSON.parse(readFileSync(join(ROOT, 'raw/jamendo_eval/corpus.json'), 'utf8')) as Array<{ id: number; title: string; artist: string; wav: string; licence: string }>
  const net = JSON.parse(readFileSync(join(ROOT, 'raw/jamendo_eval/beatnet_ts.json'), 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>
  const tracks = corpus.map((c) => {
    const w = readWav(c.wav)
    const legacyA = analyzeTrack({ channels: w.channels, sampleRate: w.rate })
    const v2A = analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] })
    return { c, w, legacy: summarize(legacyA), v2: summarize(v2A), v2A }
  })
  // pair by the v2 (reference-quality) tempo so both algorithms get identical pairs
  const order = [...tracks].sort((a, b) => a.v2.bpm - b.v2.bpm)
  const rand = rng(20261122)
  const manifest: unknown[] = []
  const key: Record<string, Record<string, string>> = {}
  const items: Array<{ pair: string; a: string; b: string; title: string }> = []
  for (let k = 0; k + 1 < order.length; k++) {
    const A = order[k]
    const B = order[k + 1]
    const pid = `p${String(k).padStart(2, '0')}`
    const mk = (s: typeof A.v2, t: typeof A, id: string): PlanTrack => ({ itemId: id, trackKey: `jamendo:${t.c.id}`, title: t.c.title, mixable: true, summary: s, durationSec: s.durationSec })
    // legacy
    const lp = legacyBest(mk(A.legacy, A, 'a'), mk(B.legacy, B, 'b'), LEGACY_OPTS, 0).best
    const lr = lp.style === 'sequential' ? null : legacyRender({ rate: A.w.rate, out: A.w.channels, in: B.w.channels, plan: lp, outTrimDb: trimDbFor(A.legacy.lufs), inTrimDb: trimDbFor(B.legacy.lufs) })
    // v2
    let vp = bestTransition(mk(A.v2, A, 'a'), mk(B.v2, B, 'b'), DEFAULT_OPTIONS, 0).best
    if (vp.durationSec >= 4) vp = { ...vp, ...refineWithLocalBeats(vp, A.v2A.netBeats, B.v2A.netBeats) }
    const vr = vp.style === 'sequential' ? null : renderTransition({ rate: A.w.rate, out: A.w.channels, in: B.w.channels, plan: vp, outTrimDb: trimDbFor(A.v2.lufs, A.v2.truePeak), inTrimDb: trimDbFor(B.v2.lufs, B.v2.truePeak) })
    if (!lr || !vr) continue
    const flip = rand() < 0.5
    const files: Record<string, string> = {}
    for (const [label, render, algo] of [
      ['1', flip ? vr : lr, flip ? 'v2' : 'legacy'],
      ['2', flip ? lr : vr, flip ? 'legacy' : 'v2'],
    ] as const) {
      const wav = encodeWav(render.channels, render.rate)
      const f = `${pid}_version${label}.wav`
      writeFileSync(join(OUT, f), wav)
      files[label] = f
      ;(key[pid] ??= {})[label] = algo
      manifest.push({ pair: pid, label, file: f, sha256: createHash('sha256').update(wav).digest('hex') })
    }
    manifest.push({ pair: pid, a: A.c.id, b: B.c.id, legacy: { style: lp.style, outCue: lp.outCueSec, inCue: lp.inCueSec, ratio: lp.tempoRatio }, v2: { style: vp.style, outCue: vp.outCueSec, inCue: vp.inCueSec, ratio: vp.tempoRatio } })
    items.push({ pair: pid, a: files['1'], b: files['2'], title: `${A.c.artist} – ${A.c.title}  →  ${B.c.artist} – ${B.c.title}` })
  }
  writeFileSync(join(OUT, 'key.json'), JSON.stringify({ note: 'Do not open before rating. Maps pair → version label → algorithm.', algorithms: { legacy: 'deployed baseline (commit 5859511)', v2: 'Beat This! grid + local refinement + new planner + LR4 isolator' }, key }, null, 1))
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))
  writeFileSync(join(OUT, 'index.html'), page(items))
  console.log(`listening set: ${items.length} pairs → ${OUT}\\index.html`)
}, 3_600_000)

function page(items: Array<{ pair: string; a: string; b: string; title: string }>): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrowdPilot blind A/B</title>
<style>
:root{--bg:#141210;--fg:#ece6da;--mut:#9a9184;--acc:#e0a24a;--card:#1d1a17;--line:#2e2a25}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-weight:600;font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}
.pair{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button{background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer}
button.on{border-color:var(--acc);color:var(--acc)}
label{display:grid;grid-template-columns:150px 1fr 70px;gap:8px;align-items:center;margin:4px 0}
input[type=range]{accent-color:var(--acc)}
textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style></head><body><main>
<h1>Blind transition comparison</h1>
<p class="mut">Each pair has two versions of the same track change, made by different algorithms. Labels are randomised. Switch between them (they stay in sync), rate each, and pick the one you prefer. Ratings are saved in this browser. Use "Export ratings" when you're done and send the file back.</p>
<div id="list"></div>
<p><button id="export">Export ratings (JSON)</button> <span id="count" class="mut"></span></p>
<script>
const items=${JSON.stringify(items)};
const dims=[["smooth","Smoothness"],["beat","Beat alignment"],["natural","Naturalness"],["energy","Energy continuity"],["creative","Creativity"]];
const store=JSON.parse(localStorage.getItem("cp_ab")||"{}");
const save=()=>{localStorage.setItem("cp_ab",JSON.stringify(store));document.getElementById("count").textContent=Object.values(store).filter(r=>r.pref).length+" / "+items.length+" pairs decided"};
const list=document.getElementById("list");
for(const it of items){
  const r=store[it.pair]||(store[it.pair]={pair:it.pair,ratings:{"1":{},"2":{}},pref:null,notes:""});
  const d=document.createElement("section");d.className="pair";
  d.innerHTML='<div class="mut">'+it.pair+'</div><div>'+it.title.replace(/</g,"&lt;")+'</div>';
  const audio=new Audio();audio.preload="auto";let cur="1";
  const src={"1":it.a,"2":it.b};audio.src=src[cur];
  const ctl=document.createElement("div");ctl.className="row";
  const play=document.createElement("button");play.textContent="Play";play.onclick=()=>{if(audio.paused){audio.play();play.textContent="Pause"}else{audio.pause();play.textContent="Play"}};
  const sw={};for(const v of ["1","2"]){const b=document.createElement("button");b.textContent="Version "+v;b.className=v===cur?"on":"";b.onclick=()=>{const t=audio.currentTime,p=!audio.paused;cur=v;audio.src=src[v];audio.currentTime=t;if(p)audio.play();for(const k in sw)sw[k].className=k===v?"on":""};sw[v]=b;ctl.append(b)}
  ctl.prepend(play);d.append(ctl);
  for(const v of ["1","2"]){const h=document.createElement("div");h.className="mut";h.textContent="Version "+v;d.append(h);
    for(const [k,lbl] of dims){const l=document.createElement("label");const s=document.createElement("input");s.type="range";s.min=1;s.max=5;s.step=1;s.value=r.ratings[v][k]||3;const o=document.createElement("span");o.textContent=r.ratings[v][k]?s.value:"–";s.oninput=()=>{r.ratings[v][k]=+s.value;o.textContent=s.value;save()};l.append(lbl,s,o);d.append(l)}}
  const pr=document.createElement("div");pr.className="row";pr.append("Preferred: ");
  for(const v of ["1","2","no preference"]){const b=document.createElement("button");b.textContent=v.length===1?"Version "+v:v;b.className=r.pref===v?"on":"";b.onclick=()=>{r.pref=v;[...pr.querySelectorAll("button")].forEach(x=>x.className=x===b?"on":"");save()};pr.append(b)}
  d.append(pr);const ta=document.createElement("textarea");ta.rows=2;ta.placeholder="Notes (optional)";ta.value=r.notes;ta.oninput=()=>{r.notes=ta.value;save()};d.append(ta);list.append(d)}
document.getElementById("export").onclick=()=>{const blob=new Blob([JSON.stringify({rater:prompt("Rater label (pseudonymous)","owner")||"owner",exportedAt:new Date().toISOString(),results:Object.values(store)},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="crowdpilot_ab_ratings.json";a.click()};
save();
</script></main></body></html>`
}
