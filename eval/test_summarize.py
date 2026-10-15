"""Unit tests for eval/summarize.py: python3 -m unittest discover -s eval -p 'test_*.py'."""

from __future__ import annotations

import unittest

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


def log(stt: str, *utts: dict) -> dict:
    return {
        "languages": {"a": "en", "b": "es"},
        "providers": {
            "cascade": {"stt": stt, "translator": "openai", "tts": "elevenlabs"}
        },
        "modes": [],
        "utterances": list(utts),
    }


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
        q = summarize.quality(modes["cascade"]["matched"], "cascade")
        self.assertEqual(q["n"], 1)
        self.assertAlmostEqual(q["wer"], 0.25)
        self.assertGreater(q["chrf"], 99)

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
        agg = modes["cascade"]
        self.assertEqual(agg["latency_withheld"], 1)
        self.assertEqual(dict(agg["stages"]), {})
        self.assertNotIn("wer", summarize.quality(agg["matched"], "cascade"))
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


if __name__ == "__main__":
    unittest.main()
