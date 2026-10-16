"""Unit tests for eval/rating.py: python3 -m unittest discover -s eval -p 'test_*.py'."""

from __future__ import annotations

import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

import rating
import summarize


class RatingTests(unittest.TestCase):
    def test_blind_hides_the_mode_and_scores_join_it_back(self) -> None:
        script = summarize.load_scripts()[0]
        log = {
            "languages": {"a": script["lang"], "b": script["target"]},
            "providers": {},
            "modes": [],
            "utterances": [
                {
                    "mode": "realtime",
                    "side": "A",
                    "source": {"text": script["text"], "final": True},
                    "target": {"text": script["reference"], "final": True},
                    "breakdown": {"totalMs": 1000, "stages": []},
                    "checks": [],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / "log.json"
            log_path.write_text(json.dumps(log), encoding="utf-8")
            key_path = Path(d) / "key.csv"
            sheet = io.StringIO()
            with contextlib.redirect_stdout(sheet):
                rating.blind([str(log_path)], 5, str(key_path))
            rows = list(csv.DictReader(io.StringIO(sheet.getvalue())))
            self.assertEqual(len(rows), 1)
            self.assertNotIn("mode", rows[0])
            self.assertEqual(rows[0]["output"], script["reference"])

            rows[0].update(accuracy="4", fluency="5", register_ok="y", entities_ok="")
            sheet_path = Path(d) / "sheet.csv"
            with sheet_path.open("w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=rating.FIELDS)
                w.writeheader()
                w.writerows(rows)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rating.scores(str(sheet_path), str(key_path))
            self.assertIn("| Realtime | 1 | 4.0 | 5.0 | 1/1 | – |", out.getvalue())


if __name__ == "__main__":
    unittest.main()
