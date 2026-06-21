from __future__ import annotations

import argparse
from pathlib import Path

from airspace_asset_contract import validate_staged_section


APP_ROOT = Path(__file__).resolve().parents[1]
SECTIONS_ROOT = APP_ROOT / "data" / "sections"


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate staged airspace labels and interaction regions.")
    parser.add_argument("--section", action="append", dest="sections", help="Section id to validate; may be repeated.")
    args = parser.parse_args()
    section_ids = args.sections or sorted(path.name for path in SECTIONS_ROOT.iterdir() if (path / "manifest.json").exists())
    failed = False
    for section_id in section_ids:
        section_root = SECTIONS_ROOT / section_id
        try:
            errors = validate_staged_section(section_root)
        except (OSError, KeyError, ValueError) as exc:
            errors = [f"[{section_id}] section: unable to read staged assets: {exc}"]
        if errors:
            failed = True
            print(f"{section_id}: FAILED ({len(errors)} errors)")
            for error in errors:
                print(f"- {error}")
        else:
            print(f"{section_id}: OK")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
