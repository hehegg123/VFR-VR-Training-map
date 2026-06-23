from __future__ import annotations

import sys
import shutil
import unittest
from pathlib import Path


TOOLS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_ROOT))

from build_section_assets import (
    base_raster_dir_from_pyramid,
    cleanup_old_base_raster_generations,
)


class BuildSectionAssetsCleanupTest(unittest.TestCase):
    def test_cleanup_keeps_active_and_one_previous_complete_generation(self) -> None:
        tmpdir = Path(__file__).resolve().parent / "__tmp_cleanup_fixture"
        if tmpdir.exists():
            shutil.rmtree(tmpdir)
        try:
            section_root = tmpdir / "data" / "sections" / "fixture"
            active = self.make_generation(section_root, "base-20260619T133250066277Z")
            previous = self.make_generation(section_root, "base-20260618T133250066277Z")
            old = self.make_generation(section_root, "base-20260617T133250066277Z")
            partial = self.make_generation(section_root, "base-20260616T133250066277Z", tmp=True)
            legacy = self.make_generation(section_root, "base")

            pyramid = {
                "levels": [
                    {
                        "tiles": [
                            {
                                "url": "rasters/base-20260619T133250066277Z/z0/tile_0_0.webp",
                            }
                        ]
                    }
                ]
            }

            removed = cleanup_old_base_raster_generations(
                section_root,
                base_raster_dir_from_pyramid(section_root, pyramid),
            )

            self.assertTrue(active.exists())
            self.assertTrue(previous.exists())
            self.assertFalse(old.exists())
            self.assertFalse(partial.exists())
            self.assertFalse(legacy.exists())
            self.assertEqual(
                {path.name for path in removed},
                {"base-20260617T133250066277Z", "base-20260616T133250066277Z", "base"},
            )
        finally:
            if tmpdir.exists():
                shutil.rmtree(tmpdir)

    @staticmethod
    def make_generation(section_root: Path, name: str, *, tmp: bool = False) -> Path:
        generation = section_root / "rasters" / name / "z0"
        generation.mkdir(parents=True, exist_ok=True)
        (generation / "tile_0_0.webp").write_bytes(b"webp")
        if tmp:
            (generation / ".tile_0_0.webp.1.tmp").write_bytes(b"tmp")
        return generation.parent


if __name__ == "__main__":
    unittest.main()
