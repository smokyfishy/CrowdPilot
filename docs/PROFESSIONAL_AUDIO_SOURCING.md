# Professional audio sourcing

Search log and decisions. The per-candidate table is in `reports/professional_audio_sourcing.csv`.

## What was searched and found

1. **UnmixDB** (Zenodo 1422385). Verified through the Zenodo API: CC BY-NC-ND 4.0, 8 files, 4.23 GB. The track files inside state CC BY-NC-ND 3.0. Downloaded through the resumable, md5-checked fetcher.
2. **Mixotic**, the human DJ mixes behind UnmixDB (Sonnleitner et al., ISMIR 2016):
   - Wayback CDX found the label's own `info.txt` for each of the six sets. Each gives the DJ, the ordered playlist with labels and catalog numbers, and a CC BY-NC-ND licence statement.
   - The audio comes from an Internet Archive community mirror (`mixotic.net_202209`) of all 300 Mixotic sets. Its description states CC licensing, but the item has no licence field, so the label's `info.txt` is the evidence used.
   - Files were md5-verified against the Internet Archive's checksums.
3. **Netlabel masters.** The Internet Archive netlabels collection has Pentagonik releases uploaded by the label itself (`kai@pentagonik.de`) with licence URLs (CC BY-NC-ND 2.5). One release (pntg007) has no licence anywhere, so it is refused.
4. **DJ Mix Dataset / Raveform / EDM-CUE / CUE-DETR / Beat This!** Inventoried through official APIs. No audio is distributed (Parquet schemas inspected). EDM-CUE annotations were fetched (MIT).
5. **YouTube, Mixcloud, SoundCloud, 1001Tracklists links** are discovery metadata only, never download rights. Not fetched.

## Ranking of next acquisitions (by verified rights × alignment utility)

1. Remaining Mixotic sets: for each transition, acquire both masters from label-uploaded netlabel items with licence URLs. Mixotic 275/281 playlists cite Insectorama, Deep In Dub, Zimmer, Cicuta and Digital Diamonds, which publish CC releases.
2. Ask Pentagonik to clarify pntg007 (template 1).
3. Consented Mixxx sessions using the acquired CC masters. This gives exact source identity and gold controls.

## Known technical blocker on human mixes

DJ sets from 2006–2016 may use keylock time-stretching and heavy EQ, which defeat waveform matching. Envelope matching places the *incoming* track of Mixotic 044 12 → 13 confidently but not the outgoing one.

Next steps: per-beat DTW on chroma plus onset envelopes, and a time-stretch-aware matcher, evaluated against UnmixDB's `stretch` variants first.
