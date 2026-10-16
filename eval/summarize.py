"""Builds eval/results/summary.md from exported session logs (T4.3).

Usage: python3 eval/summarize.py LOG.json [LOG.json ...] [--out eval/results/summary.md]
       [--prices config/prices.json] [--stt-minutes-from-session] [--allow-mixed]
The committed eval/results/summary.md comes from the four 2026-10-15 replay logs:
    python3 eval/summarize.py eval/results/logs/2026-10-15-*-replay-*.json

Per mode it reports latency p50/p95 per stage, quality against the scripted references, glossary
accuracy, output-check flags and cost per minute. Rules it follows (docs/GUARDRAILS.md):
- WER is STT only, on cascade source text. Realtime and Realtime translate source text comes from a
  separate or model-side transcript and is never scored as recognition.
- Latency and WER from runs whose STT was Deepgram are withheld: its terms bar benchmarking.
- Translation quality is chrF against references the model wrote and Paawan reviewed (no rubric
  scores); it is a rough signal, and comparing the two modes' outputs to each other is not a quality
  metric.
- Utterances are matched to script lines by text similarity, so a cascade line split by clause
  flushing may go unmatched. The counts say how many matched.
- Cost is repriced here: each log's cost lines (quantity in MTok, k chars or min, as the browser
  exported them) times the matching price in config/prices.json, mapped exactly as
  web/src/session/cost.ts does. Filling a price and re-running changes the cost column without
  re-exporting. A null price leaves its component unpriced and the mode without a cost per minute;
  nothing is ever estimated. A billed component the log has no quantity for (REQUIRED_LINES) is
  named in the cost column, not counted as free. The logs on disk are never modified.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

import jiwer
from sacrebleu.metrics import CHRF

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "eval" / "replay" / "scripts.jsonl"
GLOSSARY = ROOT / "config" / "glossary.json"
PRICES = ROOT / "config" / "prices.json"
REPLAY_LOGS = "eval/results/logs/2026-10-15-*-replay-*.json"
MATCH_MIN = 0.6
MODE_NAMES = {
    "translate": "Realtime translate",
    "realtime": "Realtime",
    "cascade": "Cascade",
}
# Cost line component -> price entry key and field, the names web/src/session/cost.ts computeCost()
# gives them. `name` is the provider and fills the key; `model` must equal the entry's model, since
# Realtime has one entry per model (cost.ts find()).
LINE_PRICES: list[tuple[re.Pattern[str], str, str]] = [
    (
        re.compile(r"^STT \((?P<name>[^)]+)\)(?: upper bound: session minutes)?$"),
        "stt:{name}",
        "perMinute",
    ),
    (
        re.compile(r"^Translation input \((?P<name>[^)]+)\)$"),
        "translator:{name}",
        "inputPerMTok",
    ),
    (
        re.compile(r"^Translation output \((?P<name>[^)]+)\)$"),
        "translator:{name}",
        "outputPerMTok",
    ),
    (re.compile(r"^TTS \((?P<name>[^)]+)\)$"), "tts:{name}", "perThousandCharacters"),
    (
        re.compile(r"^Realtime translate \(session time\)$"),
        "realtime-translate:openai",
        "perMinute",
    ),
    (
        re.compile(r"^Realtime audio input \((?P<model>[^)]+)\)$"),
        "realtime:openai",
        "audioInputPerMTok",
    ),
    (
        re.compile(r"^Realtime audio output \((?P<model>[^)]+)\)$"),
        "realtime:openai",
        "audioOutputPerMTok",
    ),
    (
        re.compile(r"^Realtime text input \((?P<model>[^)]+)\)$"),
        "realtime:openai",
        "textInputPerMTok",
    ),
    (
        re.compile(r"^Realtime text output \((?P<model>[^)]+)\)$"),
        "realtime:openai",
        "textOutputPerMTok",
    ),
    (
        re.compile(r"^Realtime cached input \((?P<model>[^)]+)\)$"),
        "realtime:openai",
        "cachedInputPerMTok",
    ),
]
# Billed components a mode's export may lack a quantity for: line prefix -> what to call it. A
# missing quantity is not a zero cost, so the cost column names what it leaves out.
REQUIRED_LINES: dict[str, list[tuple[str, str]]] = {
    "cascade": [("STT (", "STT")],
    # Realtime bills its input transcription separately; the browser never exported a line for it.
    "realtime": [("Realtime input transcription", "input transcription")],
}
# The unit each price field is quoted in; a line in any other unit stays unpriced, never rescaled.
PRICE_UNITS = {"perMinute": "min", "perThousandCharacters": "k chars"}  # else MTok
STT_UPPER_BOUND = "upper bound: session minutes"


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


def load_prices(path: Path = PRICES) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def find_price(prices: dict, key: str, model: str | None = None) -> dict | None:
    """The first entry with this key (and this model, when given): cost.ts find()."""
    for entry in prices.get("entries", []):
        if entry.get("key") == key and (model is None or entry.get("model") == model):
            return entry
    return None


def unit_price(
    component: str, unit: str, prices: dict
) -> tuple[float | None, dict | None]:
    """The price per `unit` of a cost line's component, or None when the component is unknown,
    the entry is missing, the price is null, or the entry quotes another unit."""
    for pattern, key, field in LINE_PRICES:
        match = pattern.match(component)
        if match is None:
            continue
        groups = match.groupdict()
        entry = find_price(prices, key.format(**groups), groups.get("model"))
        price = (entry or {}).get(field)
        if price is None or unit != PRICE_UNITS.get(field, "MTok"):
            return None, entry
        return float(price), entry
    return None, None


def reprice(cost: dict, prices: dict, minutes: float) -> dict:
    """A mode's cost block recomputed from its lines' quantities, the way cost.ts computeCost()
    built it at export time but with `prices` as they are now. Returns a copy; `cost` is untouched."""
    lines = []
    for raw in cost.get("lines", []):
        price, entry = unit_price(raw["component"], raw["unit"], prices)
        source = (
            f"{entry['source']} (checked {entry.get('checkedOn') or 'never'})"
            if price is not None and entry is not None
            else None
        )
        lines.append(
            {
                **raw,
                "unitPrice": price,
                "cost": None if price is None else raw["quantity"] * price,
                "priceSource": source,
            }
        )
    unpriced = [x["component"] for x in lines if x["cost"] is None]
    total = sum(x["cost"] for x in lines if x["cost"] is not None)
    return {
        **cost,
        "lines": lines,
        "pricedTotal": total,
        "unpriced": unpriced,
        "perMinute": total / minutes
        if minutes > 0 and lines and not unpriced
        else None,
    }


def with_stt_upper_bound(cost: dict, provider: str | None, minutes: float) -> dict:
    """Adds an STT line that charges the whole session when the export has no STT line (the browser
    emitted STT seconds only on End, so exports taken before End have none). It is an explicit upper
    bound, labelled as such in the component name, never a measurement. Returns a copy."""
    lines = cost.get("lines", [])
    if (
        not provider
        or minutes <= 0
        or any(x["component"].startswith("STT (") for x in lines)
    ):
        return cost
    line = {
        "component": f"STT ({provider}) {STT_UPPER_BOUND}",
        "quantity": minutes,
        "unit": "min",
        "unitPrice": None,
        "cost": None,
        "priceSource": None,
    }
    return {
        **cost,
        "lines": [line, *lines],
        "unpriced": [line["component"], *cost.get("unpriced", [])],
        "perMinute": None,
    }


def summarize(
    logs: list[dict],
    scripts: list[dict],
    prices: dict | None = None,
    stt_upper_bound: bool = False,
) -> dict:
    """Pools every log's utterances per mode. With `prices`, each mode's cost is repriced from its
    lines; without, the export-time totals are used as they are."""
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
            "missing": set(),
            "stt_upper_bound": False,
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
            minutes = m.get("minutes", 0)
            agg["minutes"] += minutes
            cost = m.get("cost") or {}
            if stt_upper_bound and m["mode"] == "cascade":
                cost = with_stt_upper_bound(cost, cascade.get("stt"), minutes)
            if prices is not None and "lines" in cost:
                cost = reprice(cost, prices, minutes)
            agg["cost"] += cost.get("pricedTotal", 0)
            agg["unpriced"].update(cost.get("unpriced", []))
            components = [x["component"] for x in cost.get("lines", [])]
            for prefix, label in REQUIRED_LINES.get(m["mode"], []):
                if not any(c.startswith(prefix) for c in components):
                    agg["missing"].add(label)
            agg["stt_upper_bound"] |= any(
                STT_UPPER_BOUND in x["component"] for x in cost.get("lines", [])
            )
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
    # Every acceptable rendering counts (the reference plus its alternatives), so a correct paraphrase or
    # the other register is not scored as an error. sacrebleu pads a line with fewer references with None.
    per_line = [[row["reference"], *row.get("alternatives", [])] for _, row in matched]
    width = max((len(r) for r in per_line), default=1)
    streams = [[r[i] if i < len(r) else None for r in per_line] for i in range(width)]
    out: dict = {"n": len(matched)}
    if matched:
        out["chrf"] = CHRF().corpus_score(hyps, streams).score
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
        "Synthetic or scripted audio only. References and glossary terms were written by the model and",
        "reviewed by Paawan (all sampled outputs judged acceptable, no rubric scores); quality numbers are",
        "a rough signal.",
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
            if agg["stt_upper_bound"]:
                cost = f"≤ {cost} (upper bound: STT charged for the whole session)"
            if agg["missing"]:
                cost += f" (excludes {', '.join(sorted(agg['missing']))}: no quantity in the log)"
        else:
            cost = "–"
        lines.append(
            f"| {name_of(mode)} | {agg['finals']} of {agg['utterances']} | {q['n']} | {chrf} | {wer} | {gloss} | {flags} | {cost} |"
        )
    lines += [
        "",
        "WER compares cascade STT text with the script line (normalised: lower case, no punctuation).",
        "chrF compares the translation with the script's reference and its alternatives. Neither is computed between modes.",
        "",
    ]
    return "\n".join(lines)


def mixed_inputs(paths: list[Path]) -> bool:
    """True when red-team logs (file names containing `redteam`) are pooled with other logs."""
    redteam = [p for p in paths if "redteam" in p.name]
    return 0 < len(redteam) < len(paths)


EPILOG = f"""\
The committed eval/results/summary.md was built from the four 2026-10-15 replay logs:
  python3 eval/summarize.py {REPLAY_LOGS}
Red-team logs (file names containing 'redteam') are scored by eval/adversarial/score.py; pooling
them with other logs is refused unless --allow-mixed is passed, because the pooled numbers then
describe no single run.
Cost: every cost line in a log is repriced as quantity x the matching price in --prices (the
mapping of web/src/session/cost.ts), so a price filled in after the export counts. A null price
leaves that line unpriced and the mode without a cost per minute; nothing is estimated.
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Pools exported session logs into one Markdown summary per mode.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "logs",
        nargs="+",
        type=Path,
        help="exported session logs (JSON); a shell glob works",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "eval" / "results" / "summary.md",
        help="output file (default: eval/results/summary.md)",
    )
    parser.add_argument(
        "--prices",
        type=Path,
        default=PRICES if PRICES.exists() else None,
        help=(
            "price list to reprice the cost lines with (default: config/prices.json when it exists;"
            " without one the browser's export-time totals are reported as they are)"
        ),
    )
    parser.add_argument(
        "--stt-minutes-from-session",
        action="store_true",
        help=(
            "for a cascade mode whose export has no 'STT (<provider>)' line, add one that charges"
            " the whole session's minutes, labelled as an upper bound (off by default)"
        ),
    )
    parser.add_argument(
        "--allow-mixed",
        action="store_true",
        help="pool red-team logs (file names containing 'redteam') with other logs",
    )
    args = parser.parse_args(argv)
    if mixed_inputs(args.logs) and not args.allow_mixed:
        print(
            "summarize: red-team logs mixed with other logs; the committed summary.md uses"
            f" {REPLAY_LOGS} only. Pass --allow-mixed to pool them anyway.",
            file=sys.stderr,
        )
        return 2
    if args.prices is not None and not args.prices.is_file():
        print(f"summarize: price list not found: {args.prices}", file=sys.stderr)
        return 2
    prices = load_prices(args.prices) if args.prices is not None else None
    logs = [json.loads(p.read_text(encoding="utf-8")) for p in args.logs]
    modes = summarize(
        logs, load_scripts(), prices, stt_upper_bound=args.stt_minutes_from_session
    )
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
