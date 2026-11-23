# DJ session capture guide (Mixxx)

This is the only route to **gold-standard** controller data. It needs a real person who consents.

## What gets recorded

| File | Content |
|---|---|
| `controller_events.jsonl` | Every effective mixer change with a monotonic timestamp: play, volume, pregain, tempo (`rate`), positions (sampled every 50 ms), track loaded/duration/bpm, sync, keylock, cue/loop/slip/jog/scratch, 3-band EQ + kills, filter (QuickEffect super), crossfader, master gain, recording status, FX units 1–2. Comes from keyboard, mouse or a controller. |
| `applied_controls.parquet` | The same data as a table (seconds from session start). |
| `session_manifest.json` | Mixxx version, consent reference, sequence gaps, table check, recording and source SHA-256 hashes, clock-sync fit, and fields that were **not available**. |
| Master recording | Mixxx's own "Record Mix" (WAV). |

## Setup (Windows, about 10 minutes)

1. Install Mixxx 2.4+ (GPL; a local tool only).
2. Install **loopMIDI** and create a port named `CrowdPilot Telemetry`.
3. Copy `ml/capture/mixxx/CrowdPilot-Telemetry.midi.xml` and `.js` into `%LOCALAPPDATA%\Mixxx\controllers\`.
4. In Mixxx, go to **Preferences → Controllers → CrowdPilot Telemetry** (the loopMIDI port), enable it and choose the "CrowdPilot Telemetry (research capture)" mapping. A hardware controller can keep its own mapping at the same time.
5. Run the receiver:
   ```
   ml\.venv\Scripts\python -m ml.capture.receiver listen --out C:\crowdpilot-data\captures\S001 --consent-ref C-S001 --mixxx-version 2.5.0
   ```
6. Load only tracks whose files you're allowed to use, with their licence or grant recorded. Press **Record** in Mixxx, then DJ normally. Stop the recording, then press Ctrl+C in the receiver.
7. Finalize (fits the clock, hashes the files):
   ```
   ml\.venv\Scripts\python -m ml.capture.receiver finalize C:\crowdpilot-data\captures\S001 --recording <mix.wav> --sources <track1> <track2> ...
   ```
   QC passes when the RMS clock residual is under 10 ms and drift is under 100 ppm.

## Consent form (fill in and sign; keep it private under `C:\crowdpilot-data\registry\private\consent\`)

> I, {name}, agree that CrowdPilot (owner: {owner}) records my DJ session on {date}: the mixer actions logged by Mixxx, the master output, and the list and hashes of the tracks I play.
>
> **Purposes** (tick):
> - ☐ private analysis
> - ☐ training private research models
> - ☐ anonymised statistics in a write-up
> - ☐ short audio excerpts in a private demo
>
> **Not permitted:** public release of my recording, commercial use, and identifying me by name unless I tick ☐.
>
> **Retention:** until {date}, or until I withdraw. I can withdraw at any time by emailing {contact}. My recording, logs and derived data will then be deleted, and models trained on them will be flagged for retraining.
>
> Signature: ___ Date: ___

## Honest labelling

- Sessions without a consent reference are refused, unless `--dry-run` is used for tests. Those are labelled `UNCONSENTED` and never counted.
- Simulated telemetry exists only in unit tests.
- A session by the owner is labelled by the performer's actual experience (for example "self-performed, amateur"), not as "professional".
