"""Receive CrowdPilot Mixxx telemetry from a virtual MIDI port and write a session.

  python -m ml.capture.receiver --port "CrowdPilot Telemetry" --out C:\\crowdpilot-data\\captures\\session-001 \
      --consent-ref C-2026-001 --mixxx-version 2.5.0
  (Ctrl+C to stop; then run `python -m ml.capture.receiver finalize ...` with the recording path.)

Refuses to start without --consent-ref unless --dry-run is given (simulated/no-consent
sessions are labelled as such and never counted as human performance data).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .telemetry import SessionWriter, fit_clock, onset_times


def listen(args: argparse.Namespace) -> None:
    import mido

    if not args.consent_ref and not args.dry_run:
        raise SystemExit("A signed consent reference (--consent-ref) is required for a research session. Use --dry-run for tests.")
    names = mido.get_input_names()
    port = next((n for n in names if args.port.lower() in n.lower()), None)
    if not port:
        raise SystemExit(f"MIDI input containing '{args.port}' not found. Available: {names}")
    w = SessionWriter(Path(args.out), args.consent_ref, args.mixxx_version, notes="dry-run" if args.dry_run else "")
    print(f"listening on {port} → {args.out} (Ctrl+C to stop)")
    with mido.open_input(port) as inp:
        try:
            for msg in inp:
                if msg.type == "sysex":
                    w.add_raw(time.perf_counter_ns(), bytes([0xF0, *msg.data, 0xF7]))
        except KeyboardInterrupt:
            pass
    m = w.close(None, [], None)
    print(json.dumps({k: m[k] for k in ("events", "sequence_gaps", "table_match")}))


def finalize(args: argparse.Namespace) -> None:
    import pandas as pd
    import soundfile as sf

    d = Path(args.session)
    manifest = json.loads((d / "session_manifest.json").read_text(encoding="utf-8"))
    df = pd.read_parquet(d / "applied_controls.parquet")
    rec = Path(args.recording)
    audio, rate = sf.read(str(rec), always_2d=True)
    # anchors: [Recording] status 0→1 (t=0 of the file) and deck play 0→1 transitions
    rec_on = df[(df.group == "[Recording]") & (df.key == "status") & (df.value >= 1)]
    t0 = float(rec_on.t_s.iloc[0]) if len(rec_on) else 0.0
    plays = df[(df.key == "play") & (df.value >= 1)].t_s.to_numpy() - t0
    sync = fit_clock(plays[plays > 0], onset_times(audio, rate))
    sync["recording_start_event_s"] = t0
    manifest["clock_sync"] = sync
    manifest["recording"] = {"path": str(rec), "sha256": __import__("hashlib").sha256(rec.read_bytes()).hexdigest(), "rate": rate, "seconds": len(audio) / rate}
    manifest["sources"] = [{"path": p, "sha256": __import__("hashlib").sha256(Path(p).read_bytes()).hexdigest()} for p in args.sources]
    (d / "session_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(json.dumps(sync, indent=1))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m ml.capture.receiver")
    sub = p.add_subparsers(dest="cmd")
    l = sub.add_parser("listen")  # noqa: E741
    l.add_argument("--port", default="CrowdPilot Telemetry")
    l.add_argument("--out", required=True)
    l.add_argument("--consent-ref")
    l.add_argument("--mixxx-version", default="unknown")
    l.add_argument("--dry-run", action="store_true")
    l.set_defaults(fn=listen)
    f = sub.add_parser("finalize")
    f.add_argument("session")
    f.add_argument("--recording", required=True)
    f.add_argument("--sources", nargs="*", default=[])
    f.set_defaults(fn=finalize)
    args = p.parse_args(argv)
    if not getattr(args, "fn", None):
        p.print_help()
        return
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
