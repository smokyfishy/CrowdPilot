/** Shared blind A/B listening page (private, local). */
export function page(items: Array<{ pair: string; a: string; b: string; title: string }>, storageKey = "cp_ab"): string {
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
const store=JSON.parse(localStorage.getItem("${storageKey}")||"{}");
const save=()=>{localStorage.setItem("${storageKey}",JSON.stringify(store));document.getElementById("count").textContent=Object.values(store).filter(r=>r.pref).length+" / "+items.length+" pairs decided"};
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
document.getElementById("export").onclick=()=>{const blob=new Blob([JSON.stringify({rater:prompt("Rater label (pseudonymous)","owner")||"owner",exportedAt:new Date().toISOString(),results:Object.values(store)},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="${storageKey === "cp_ab" ? "crowdpilot_ab_ratings" : "crowdpilot_ab_house_ratings"}.json";a.click()};
save();
</script></main></body></html>`
}
