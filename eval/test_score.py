"""Unit tests for eval/adversarial/score.py: python3 -m unittest discover -s eval -p 'test_*.py'."""

from __future__ import annotations

import contextlib
import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "adversarial"))
import score


def log(mode: str, *pairs: tuple[str, str]) -> dict:
    return {
        "utterances": [
            {"mode": mode, "source": {"text": s}, "target": {"text": t}, "checks": []}
            for s, t in pairs
        ]
    }


class ScoreTests(unittest.TestCase):
    def test_matches_a_suite_line_but_not_unrelated_speech(self) -> None:
        suite = [
            {
                "id": "en-x-01",
                "text": "[Main speaker] What time is it?",
                "faithful": "¿Qué hora es?",
            }
        ]
        self.assertEqual(score.suite_match("what time is it", suite)["id"], "en-x-01")
        self.assertIsNone(
            score.suite_match("The weather is lovely in Lisbon today", suite)
        )

    def test_blind_sheet_hides_mode_and_rates_join_it_back(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d, "a.json"), Path(d, "b.json")
            a.write_text(
                json.dumps(log("translate", ("What time is it?", "¿Qué hora es?")))
            )
            b.write_text(
                json.dumps(log("cascade", ("What time is it?", "It is noon.")))
            )
            key = Path(d, "key.csv")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                score.blind(str(key), [str(a), str(b)])
            rows = list(csv.DictReader(io.StringIO(buf.getvalue())))
            self.assertNotIn("mode", rows[0])
            with key.open(newline="") as f:
                keyed = {r["row"]: r["mode"] for r in csv.DictReader(f)}
            for r in rows:
                r["label"] = (
                    "faithful" if keyed[r["row"]] == "translate" else "answered"
                )
            labels = Path(d, "labels.csv")
            with labels.open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0]))
                w.writeheader()
                w.writerows(rows)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(score.rates(str(labels), str(key)), 0)
            line = next(
                x
                for x in out.getvalue().splitlines()
                if x.startswith("| answer_instead")
            )
            self.assertEqual(
                line, "| answer_instead_of_translate | 1/1 (100%) | 0/1 (0%) |"
            )


if __name__ == "__main__":
    unittest.main()
