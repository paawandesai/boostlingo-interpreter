"""Unit tests for eval/summarize.py: python3 -m unittest discover -s eval -p 'test_*.py'."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import summarize


def utterance(
    mode: str, source: str, target: str, total: float | None = 1000.0
) -> dict:
    return {
        "mode": mode,
        "side": "A",
        "source": {"text": source, "final": True},
        "target": {"text": target, "final": True},
        "breakdown": {"totalMs": total, "stages": []},
        "checks": [],
    }


def log(stt: str, *utts: dict, modes: list[dict] | None = None) -> dict:
    return {
        "languages": {"a": "en", "b": "es"},
        "providers": {
            "cascade": {"stt": stt, "translator": "openai", "tts": "elevenlabs"}
        },
        "modes": modes or [],
        "utterances": list(utts),
    }


def cost_line(component: str, quantity: float, unit: str) -> dict:
    """An unpriced line as the browser exports it before any price is checked."""
    return {
        "component": component,
        "quantity": quantity,
        "unit": unit,
        "unitPrice": None,
        "cost": None,
        "priceSource": None,
    }


def mode_block(mode: str, minutes: float, *lines: dict) -> dict:
    return {
        "mode": mode,
        "minutes": minutes,
        "cost": {
            "mode": mode,
            "minutes": minutes,
            "lines": list(lines),
            "pricedTotal": 0,
            "unpriced": [x["component"] for x in lines],
            "perMinute": None,
        },
    }


def entry(key: str, model: str, **prices: float | None) -> dict:
    return {
        "key": key,
        "model": model,
        **prices,
        "source": f"https://example.test/{key}",
        "checkedOn": "2026-10-16",
    }


PRICES = {
    "currency": "USD",
    "entries": [
        entry("stt:openai", "stt-model", perMinute=0.006),
        entry("translator:openai", "tr-model", inputPerMTok=0.25, outputPerMTok=2.0),
        entry("tts:elevenlabs", "tts-model", perThousandCharacters=0.1),
        entry("realtime:openai", "rt-model-a", audioInputPerMTok=100.0),
        entry(
            "realtime:openai",
            "rt-model-b",
            audioInputPerMTok=32.0,
            audioOutputPerMTok=64.0,
            textInputPerMTok=4.0,
            textOutputPerMTok=16.0,
            cachedInputPerMTok=0.4,
        ),
    ],
}

CASCADE_LINES = (
    cost_line("Translation input (openai)", 0.01, "MTok"),
    cost_line("Translation output (openai)", 0.002, "MTok"),
    cost_line("TTS (elevenlabs)", 1.515, "k chars"),
)


def with_price(prices: dict, key: str, **changes: float | None) -> dict:
    entries = [{**e, **changes} if e["key"] == key else e for e in prices["entries"]]
    return {**prices, "entries": entries}


SCRIPTS = [
    {
        "id": "en-x-01",
        "lang": "en",
        "target": "es",
        "text": "Where is the pharmacy?",
        "reference": "¿Dónde está la farmacia?",
    },
]


class SummarizeTests(unittest.TestCase):
    def test_percentile_is_nearest_rank(self) -> None:
        self.assertEqual(summarize.percentile([1, 2, 3, 4], 50), 2)
        self.assertEqual(summarize.percentile([1, 2, 3, 4], 95), 4)
        self.assertIsNone(summarize.percentile([], 50))

    def test_matches_by_text_and_scores_wer_on_stt_only(self) -> None:
        modes = summarize.summarize(
            [
                log(
                    "openai",
                    utterance(
                        "cascade", "where is the farmacy", "¿Dónde está la farmacia?"
                    ),
                )
            ],
            SCRIPTS,
        )
        q = summarize.quality(modes["cascade:openai"]["matched"], "cascade:openai")
        self.assertEqual(q["n"], 1)
        self.assertAlmostEqual(q["wer"], 0.25)
        self.assertGreater(q["chrf"], 99)

    def test_chrf_accepts_an_alternative_rendering(self) -> None:
        scripts = [
            {**SCRIPTS[0], "alternatives": ["¿Dónde queda la farmacia?"]},
        ]
        modes = summarize.summarize(
            [
                log(
                    "openai",
                    utterance(
                        "cascade", "where is the pharmacy", "¿Dónde queda la farmacia?"
                    ),
                )
            ],
            scripts,
        )
        with_alt = summarize.quality(
            modes["cascade:openai"]["matched"], "cascade:openai"
        )
        modes = summarize.summarize(
            [
                log(
                    "openai",
                    utterance(
                        "cascade", "where is the pharmacy", "¿Dónde queda la farmacia?"
                    ),
                )
            ],
            SCRIPTS,
        )
        without = summarize.quality(
            modes["cascade:openai"]["matched"], "cascade:openai"
        )
        self.assertGreater(with_alt["chrf"], 99)
        self.assertLess(without["chrf"], 90)

    def test_withholds_deepgram_latency_and_wer(self) -> None:
        modes = summarize.summarize(
            [
                log(
                    "deepgram",
                    utterance(
                        "cascade", "Where is the pharmacy?", "¿Dónde está la farmacia?"
                    ),
                )
            ],
            SCRIPTS,
        )
        agg = modes["cascade:openai"]
        self.assertEqual(agg["latency_withheld"], 1)
        self.assertEqual(dict(agg["stages"]), {})
        self.assertNotIn("wer", summarize.quality(agg["matched"], "cascade:openai"))
        self.assertIn("withheld (Deepgram)", summarize.render(modes, []))

    def test_never_scores_realtime_source_as_recognition(self) -> None:
        modes = summarize.summarize(
            [
                log(
                    "openai",
                    utterance(
                        "realtime", "Where is the pharmacy?", "¿Dónde está la farmacia?"
                    ),
                )
            ],
            SCRIPTS,
        )
        self.assertNotIn(
            "wer", summarize.quality(modes["realtime"]["matched"], "realtime")
        )
        self.assertIn("n/a (not STT)", summarize.render(modes, []))

    def test_reprices_cascade_lines_from_the_price_list(self) -> None:
        block = mode_block(
            "cascade", 2.0, cost_line("STT (openai)", 2.0, "min"), *CASCADE_LINES
        )
        cost = summarize.reprice(block["cost"], PRICES, 2.0)
        self.assertEqual(
            [x["cost"] for x in cost["lines"]], [0.012, 0.0025, 0.004, 0.1515]
        )
        self.assertEqual(
            cost["lines"][0]["priceSource"],
            "https://example.test/stt:openai (checked 2026-10-16)",
        )
        self.assertEqual(cost["unpriced"], [])
        self.assertAlmostEqual(cost["pricedTotal"], 0.17)
        self.assertAlmostEqual(cost["perMinute"], 0.085)
        # The export's block is untouched: repricing never writes back.
        self.assertIsNone(block["cost"]["lines"][0]["cost"])
        modes = summarize.summarize([log("openai", modes=[block])], SCRIPTS, PRICES)
        self.assertIn("| $0.0850 |", summarize.render(modes, []))

    def test_prices_stt_by_the_model_the_log_names(self) -> None:
        prices = {
            **PRICES,
            "entries": [entry("stt:openai", "stt-new", perMinute=0.017)]
            + PRICES["entries"],
        }
        line = cost_line("STT (openai)", 2.0, "min")
        named = summarize.reprice(
            mode_block("cascade", 2.0, line)["cost"], prices, 2.0, "stt-model"
        )
        self.assertAlmostEqual(named["lines"][0]["cost"], 0.012)
        # A log without the model (before 2026-10-17) takes the first entry for the vendor.
        unnamed = summarize.reprice(
            mode_block("cascade", 2.0, line)["cost"], prices, 2.0
        )
        self.assertAlmostEqual(unnamed["lines"][0]["cost"], 0.034)

    def test_matches_realtime_prices_by_model(self) -> None:
        block = mode_block(
            "realtime",
            2.0,
            cost_line("Realtime audio input (rt-model-b)", 0.5, "MTok"),
            cost_line("Realtime cached input (rt-model-b)", 0.25, "MTok"),
        )
        cost = summarize.reprice(block["cost"], PRICES, 2.0)
        self.assertEqual([x["cost"] for x in cost["lines"]], [16.0, 0.1])
        self.assertAlmostEqual(cost["perMinute"], 8.05)
        unknown = summarize.reprice(
            mode_block(
                "realtime",
                2.0,
                cost_line("Realtime audio input (rt-model-c)", 1, "MTok"),
            )["cost"],
            PRICES,
            2.0,
        )
        self.assertEqual(unknown["unpriced"], ["Realtime audio input (rt-model-c)"])

    def test_null_price_or_other_unit_leaves_the_line_unpriced(self) -> None:
        prices = with_price(PRICES, "tts:elevenlabs", perThousandCharacters=None)
        block = mode_block(
            "cascade", 2.0, cost_line("STT (openai)", 120.0, "s"), *CASCADE_LINES
        )
        cost = summarize.reprice(block["cost"], prices, 2.0)
        self.assertEqual(cost["unpriced"], ["STT (openai)", "TTS (elevenlabs)"])
        self.assertAlmostEqual(cost["pricedTotal"], 0.0065)
        self.assertIsNone(cost["perMinute"])
        modes = summarize.summarize([log("openai", modes=[block])], SCRIPTS, prices)
        self.assertIn(
            "| unpriced: STT (openai), TTS (elevenlabs) |", summarize.render(modes, [])
        )
        # Without a price list the export-time totals are used as they are.
        modes = summarize.summarize([log("openai", modes=[block])], SCRIPTS)
        self.assertEqual(modes["cascade:openai"]["cost"], 0)

    def test_stt_upper_bound_flag_adds_a_labelled_line(self) -> None:
        block = mode_block("cascade", 2.0, *CASCADE_LINES)
        cost = summarize.with_stt_upper_bound(block["cost"], "openai", 2.0)
        self.assertEqual(
            cost["lines"][0]["component"], "STT (openai) upper bound: session minutes"
        )
        self.assertEqual(
            (cost["lines"][0]["quantity"], cost["lines"][0]["unit"]), (2.0, "min")
        )
        self.assertEqual(len(block["cost"]["lines"]), 3)
        # A mode that already has an STT line is left alone.
        measured = mode_block("cascade", 2.0, cost_line("STT (openai)", 0.5, "min"))
        self.assertIs(
            summarize.with_stt_upper_bound(measured["cost"], "openai", 2.0),
            measured["cost"],
        )
        logs = [log("openai", modes=[block])]
        off = summarize.render(summarize.summarize(logs, SCRIPTS, PRICES), [])
        self.assertNotIn("upper bound", off)
        on = summarize.render(
            summarize.summarize(logs, SCRIPTS, PRICES, stt_upper_bound=True), []
        )
        self.assertIn(
            "| ≤ $0.0850 (upper bound: STT charged for the whole session) |", on
        )
        no_stt_price = with_price(PRICES, "stt:openai", perMinute=None)
        unpriced = summarize.render(
            summarize.summarize(logs, SCRIPTS, no_stt_price, stt_upper_bound=True), []
        )
        self.assertIn("unpriced: STT (openai) upper bound: session minutes", unpriced)

    def test_a_missing_quantity_is_named_not_counted_as_free(self) -> None:
        # The cascade export has no STT line: its cost per minute says it leaves STT out.
        logs = [log("openai", modes=[mode_block("cascade", 2.0, *CASCADE_LINES)])]
        self.assertIn(
            "| $0.0790 (excludes STT: no quantity in the log) |",
            summarize.render(summarize.summarize(logs, SCRIPTS, PRICES), []),
        )
        realtime = mode_block(
            "realtime", 2.0, cost_line("Realtime audio input (rt-model-b)", 0.5, "MTok")
        )
        rendered = summarize.render(
            summarize.summarize([log("openai", modes=[realtime])], SCRIPTS, PRICES), []
        )
        self.assertIn(
            "(excludes input transcription: no quantity in the log)", rendered
        )

    def test_refuses_to_mix_redteam_and_replay_logs(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            replay = Path(d, "2026-10-15-cascade-replay-openai-synthetic.json")
            redteam = Path(d, "2026-10-15-cascade-redteam-openai-synthetic.json")
            for p in (replay, redteam):
                p.write_text(json.dumps(log("openai")), encoding="utf-8")
            out = Path(d, "summary.md")
            argv = [str(replay), str(redteam), "--out", str(out)]
            self.assertTrue(summarize.mixed_inputs([replay, redteam]))
            self.assertFalse(summarize.mixed_inputs([redteam]))
            err = io.StringIO()
            with (
                contextlib.redirect_stderr(err),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(summarize.main(argv), 2)
                self.assertFalse(out.exists())
                self.assertIn("--allow-mixed", err.getvalue())
                self.assertEqual(summarize.main([*argv, "--allow-mixed"]), 0)
            self.assertIn(f"- `{replay.name}`", out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
