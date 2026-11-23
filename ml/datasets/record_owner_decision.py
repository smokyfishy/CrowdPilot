"""Record an OWNER decision in the private rights store (run by the project owner, not an agent).

  python -m ml.datasets.record_owner_decision --use render_private_mix --licence-has nd \
      --basis "private, unshared evaluation renders only" [--dry-run]

Applies `approved` for one scoped use to every asset whose licence contains the given component
(e.g. 'nd' = CC no-derivatives), keeping existing evidence and appending the owner's statement.
Prints what it would change; --dry-run changes nothing.
"""
from __future__ import annotations

import argparse
import datetime as dt

from .acquire import REPO, log, rights_store
from .rights import Decision, Use


def main(argv=None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--use", required=True, choices=[u.value for u in Use])
    p.add_argument("--licence-has", required=True, help="licence component, e.g. nd, nc, sa, by")
    p.add_argument("--basis", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    use = Use(a.use)
    store = rights_store()
    today = dt.date.today().isoformat()
    hits = []
    for asset in store.assets.values():
        parts = (asset.licence or "").lower().replace("cc-", "").replace(";", "-").split("-")
        if a.licence_has.lower() not in parts:
            continue
        prev = asset.decision(Use.WAVEFORM_ANALYZE).evidence
        if not prev:
            continue  # never approve anything that has no licence evidence at all
        hits.append(asset.asset_id)
        if not a.dry_run:
            asset.set(use, Decision.APPROVED, f"{asset.licence}: owner decision {today} — {a.basis}", list(prev) + [f"Owner decision {today}: {a.basis}"], f"owner-decision:{today}")
            store.put(asset, f"owner decision: {use.value} approved ({a.basis})")
    print(f"{'Would update' if a.dry_run else 'Updated'} {len(hits)} assets for {use.value} (licence has '{a.licence_has}').")
    if not a.dry_run:
        store.save()
        store.save_redacted(REPO / "ml" / "data" / "registry" / "rights_redacted.json")
        log("owner-decision", use=use.value, licence_has=a.licence_has, assets=len(hits))


if __name__ == "__main__":
    main()
