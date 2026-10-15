"""Builds eval/results/summary.md from exported session logs (T4.3).

Usage: python3 eval/summarize.py LOG.json [LOG.json ...] [--out eval/results/summary.md]

Per mode it reports latency p50/p95 per stage, quality against the scripted references, glossary
accuracy, output-check flags and cost per minute. Rules it follows (docs/GUARDRAILS.md):
- WER is STT only, on cascade source text. Realtime and Realtime translate source text comes from a
  separate or model-side transcript and is never scored as recognition.
- Latency and WER from runs whose STT was Deepgram are withheld: its terms bar benchmarking.
- Translation quality is chrF against references the model wrote; it is a rough signal until Paawan
  checks the references, and comparing the two modes' outputs to each other is not a quality metric.
- Utterances are matched to script lines by text similarity, so a cascade line split by clause
  flushing may go unmatched. The counts say how many matched.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

import jiwer
from sacrebleu.metrics import CHRF

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "eval" / "replay" / "scripts.jsonl"
GLOSSARY = ROOT / "config" / "glossary.json"
MATCH_MIN = 0.6
MODE_NAMES = {
    "translate": "Realtime translate",
    "realtime": "Realtime",
    "cascade": "Cascade",
}


def normalize(text: str) -> str:
    """Lower case, no punctuation, single spaces. Used for WER and matching only."""
    text = unicodedata.normalize("NFC", text).lower()
    text = re.sub(r"[^\w\s']", " ", text)
    return " ".join(text.split())


def percentile(values: list[float], p: float) -> float | None:
    """Nearest rank, the same definition as web/src/session/latency.ts."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, min(len(ordered), -(-p * len(ordered) // 100)))
    return ordered[int(rank) - 1]


def load_scripts(path: Path = SCRIPTS) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(x) for x in lines if x.strip()]


def best_script(text: str, lang: str, scripts: list[dict]) -> tuple[dict | None, float]:
    norm = normalize(text)
    best, best_score = None, 0.0
    for row in scripts:
        if row["lang"] != lang:
            continue
        score = SequenceMatcher(None, norm, normalize(row["text"])).ratio()
        if score > best_score:
            best, best_score = row, score
    return best, best_score


def match_script(text: str, lang: str, scripts: list[dict]) -> dict | None:
    """The script line in `lang` closest to `text`, if close enough."""
    best, score = best_script(text, lang, scripts)
    return best if score >= MATCH_MIN else None


def glossary_targets() -> dict[str, dict[str, str]]:
    """term -> {lang: translation} for every glossary entry."""
    data = json.loads(GLOSSARY.read_text(encoding="utf-8"))
    out: dict[str, dict[str, str]] = {}
    for entry in data["entries"]:
        for term in entry.values():
            out[term.lower()] = {k: v for k, v in entry.items()}
    return out


def summarize(logs: list[dict], scripts: list[dict]) -> dict:
    """Pools every log's utterances per mode."""
    gloss = glossary_targets()
    modes: dict[str, dict] = defaultdict(
        lambda: {
            "utterances": 0,
            "finals": 0,
            "stages": defaultdict(list),
            "latency_withheld": 0,
            "matched": [],
            "flags": defaultdict(int),
            "glossary": [0, 0],
            "minutes": 0.0,
            "cost": 0.0,
            "unpriced": set(),
            "providers": set(),
        }
    )
    for log in logs:
        langs = log["languages"]
        cascade = (log.get("providers") or {}).get("cascade") or {}

        # Cascade runs with different translators are different systems: keep them apart.
        translator = cascade.get("translator")

        def key(mode: str, t: str | None = translator) -> str:
            return f"cascade:{t}" if mode == "cascade" and t else mode

        for m in log.get("modes", []):
            agg = modes[key(m["mode"])]
            agg["minutes"] += m.get("minutes", 0)
            cost = m.get("cost") or {}
            agg["cost"] += cost.get("pricedTotal", 0)
            agg["unpriced"].update(cost.get("unpriced", []))
        for u in log["utterances"]:
            mode = u["mode"]
            agg = modes[key(mode)]
            agg["utterances"] += 1
            if mode == "cascade":
                agg["providers"].add(
                    f"{cascade.get('stt')} / {cascade.get('translator')} / {cascade.get('tts')}"
                )
            if not (u["source"]["final"] and u["target"]["final"]):
                continue
            agg["finals"] += 1
            for flag in u.get("checks") or []:
                agg["flags"][flag] += 1
            if mode == "cascade" and cascade.get("stt") == "deepgram":
                agg["latency_withheld"] += 1
            else:
                breakdown = u.get("breakdown") or {}
                if breakdown.get("totalMs") is not None:
                    agg["stages"]["Total (speech end → first audio)"].append(
                        breakdown["totalMs"]
                    )
                for stage in breakdown.get("stages", []):
                    if stage.get("ms") is not None:
                        agg["stages"][stage["label"]].append(stage["ms"])

        finals = [
            u
            for u in log["utterances"]
            if u["source"]["final"] and u["target"]["final"]
        ]
        by_mode: dict[str, list[dict]] = defaultdict(list)
        for u in finals:
            by_mode[u["mode"]].append(u)
        for mode, utts in by_mode.items():
            agg = modes[key(mode)]
            for u in utts:
                score_line(agg, u, mode, cascade, langs, scripts, gloss)
    return modes


def score_line(
    agg: dict,
    u: dict,
    mode: str,
    cascade: dict,
    langs: dict,
    scripts: list[dict],
    gloss: dict,
) -> None:
    """Matches one (re-joined) line to the script and records it for chrF, WER and glossary."""
    src_lang = langs["a"] if u["side"] == "A" else langs["b"]
    tgt_lang = langs["b"] if u["side"] == "A" else langs["a"]
    row = match_script(u["source"]["text"], src_lang, scripts)
    if row is None or row.get("target") != tgt_lang:
        return
    u = {**u, "_deepgram": mode == "cascade" and cascade.get("stt") == "deepgram"}
    agg["matched"].append((u, row))
    for term in row.get("terms", []):
        want = gloss.get(term.lower(), {}).get(tgt_lang)
        if want:
            agg["glossary"][1] += 1
            agg["glossary"][0] += want.lower() in u["target"]["text"].lower()


def quality(matched: list[tuple[dict, dict]], mode: str) -> dict:
    mode = mode.split(":")[0]
    hyps = [u["target"]["text"] for u, _ in matched]
    refs = [row["reference"] for _, row in matched]
    out: dict = {"n": len(matched)}
    if matched:
        out["chrf"] = CHRF().corpus_score(hyps, [refs]).score
    stt = [(u, row) for u, row in matched if not u.get("_deepgram")]
    out["wer_withheld"] = len(matched) - len(stt)
    if mode == "cascade" and stt:
        out["wer"] = jiwer.wer(
            [normalize(row["text"]) for _, row in stt],
            [normalize(u["source"]["text"]) for u, _ in stt],
        )
    return out


def name_of(mode: str) -> str:
    base, _, translator = mode.partition(":")
    name = MODE_NAMES.get(base, base)
    return f"{name} ({translator} translator)" if translator else name


def fmt(ms: float | None) -> str:
    return "–" if ms is None else f"{ms:.0f}"


def render(modes: dict, inputs: list[str]) -> str:
    lines = [
        "# Evaluation summary",
        "",
        "Generated by `python3 eval/summarize.py` from:",
        *[f"- `{p}`" for p in inputs],
        "",
        "Synthetic or scripted audio only. References and glossary terms were written by the model and are",
        "unverified; quality numbers are a rough signal until Paawan checks them and scores blind (T4.2).",
        "",
        "## Latency (client ms)",
        "",
    ]
    for mode, agg in sorted(modes.items()):
        name = name_of(mode)
        if agg["latency_withheld"]:
            lines += [
                (
                    f"**{name}:** latency withheld for {agg['latency_withheld']} utterances"
                    " run on Deepgram STT (its terms bar benchmarking)."
                ),
                "",
            ]
        if not agg["stages"]:
            continue
        lines += [
            f"**{name}** ({', '.join(sorted(agg['providers'])) or 'OpenAI'})",
            "",
            "| Stage | n | p50 | p95 |",
            "|---|---|---|---|",
        ]
        for label, values in agg["stages"].items():
            lines.append(
                f"| {label} | {len(values)} | {fmt(percentile(values, 50))} | {fmt(percentile(values, 95))} |"
            )
        lines.append("")
    lines += [
        "## Quality, flags and cost",
        "",
        "| Mode | Lines (final) | Matched to script | chrF | STT WER | Glossary | Output-check flags | Cost/min |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for mode, agg in sorted(modes.items()):
        q = quality(agg["matched"], mode)
        chrf = f"{q['chrf']:.1f}" if "chrf" in q else "–"
        if not mode.startswith("cascade"):
            wer = "n/a (not STT)"
        elif "wer" in q:
            wer = f"{q['wer']:.1%}"
        else:
            wer = "withheld (Deepgram)" if q.get("wer_withheld") else "–"
        hit, total = agg["glossary"]
        gloss = f"{hit}/{total}" if total else "–"
        flags = ", ".join(f"{k} {v}" for k, v in sorted(agg["flags"].items())) or "none"
        if agg["unpriced"]:
            cost = "unpriced: " + ", ".join(sorted(agg["unpriced"]))
        elif agg["minutes"] > 0 and agg["cost"] > 0:
            cost = f"${agg['cost'] / agg['minutes']:.4f}"
        else:
            cost = "–"
        lines.append(
            f"| {name_of(mode)} | {agg['finals']} of {agg['utterances']} | {q['n']} | {chrf} | {wer} | {gloss} | {flags} | {cost} |"
        )
    lines += [
        "",
        "WER compares cascade STT text with the script line (normalised: lower case, no punctuation).",
        "chrF compares the translation with the script's reference. Neither is computed between modes.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("logs", nargs="+", type=Path)
    parser.add_argument(
        "--out", type=Path, default=ROOT / "eval" / "results" / "summary.md"
    )
    args = parser.parse_args()
    logs = [json.loads(p.read_text(encoding="utf-8")) for p in args.logs]
    modes = summarize(logs, load_scripts())
    inputs = [
        str(p.resolve().relative_to(ROOT))
        if p.resolve().is_relative_to(ROOT)
        else p.name
        for p in args.logs
    ]
    args.out.write_text(render(modes, inputs), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
