# Telemetry sourcing and capture

**Existing public telemetry:** none found. Queries and results are in `reports/telemetry_source_audit.csv`. The closest items are estimated fader/EQ (Kim et al., DAFx 2022), synthetic placement (UnmixDB) and device MIDI maps. None is logged human control state synced to audio.

**New capture:** `ml/capture/`

- A Mixxx mapping (`CrowdPilot-Telemetry.js` / `.midi.xml`) observes about 125 effective controls through the documented `engine.makeConnection` API. It streams 14-byte SysEx records over a virtual MIDI port.
- `receiver.py` timestamps them with `perf_counter_ns`. It writes `controller_events.jsonl`, `applied_controls.parquet` and `session_manifest.json`, then fits the clock against the master recording (offset, drift, residuals).
- It works with keyboard/mouse or alongside any hardware controller.
- Tests (simulated, labelled as such): SysEx round-trip, table mirror, sequence-gap detection, clock fit (offset within 3 ms, drift within 30 ppm), mismatch detection, and refusal without consent.

**Version notes:**

- Built for the Mixxx 2.4/2.5 controller API: `engine.makeConnection`, `midi.sendSysexMsg`, `engine.beginTimer`.
- The `[Master]` group is aliased to `[Main]` in 2.5; the old name still works.
- Raw hardware MIDI cannot be co-captured on Windows, because ports are exclusive. Use a MIDI thru/monitor if it's needed.
- Track file paths aren't visible to scripts; map them from Mixxx's library history after the session.

**Status:** `BLOCKED_HUMAN_SESSION`. See `docs/DJ_SESSION_CAPTURE_GUIDE.md`.
