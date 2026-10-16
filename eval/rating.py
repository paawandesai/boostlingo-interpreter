"""Blind human rating of translation quality (the "subjective" half of the brief's quality metric).

    python3 eval/rating.py blind --per-mode 5 --key KEY.csv LOG.json [LOG.json ...] > sheet.csv
    python3 eval/rating.py scores sheet.csv KEY.csv

`blind` takes lines that summarize.py matched to a script line, samples up to N per mode, shuffles them
and hides the mode behind a row id (the mapping goes to KEY.csv; don't open it before scoring). Each row
shows the source line as scripted, the system's output and the model-drafted reference, so the rater can
judge the output itself rather than its distance from one reference. The rater fills four columns:

- accuracy 1-5: meaning carried over (5 complete and correct, 1 wrong or missing)
- fluency 1-5: reads as natural target-language speech
- register_ok y/n: formality (usted/tú) and tone kept
- entities_ok y/n: names, numbers, doses and dates exact (blank when the line has none)

`scores` joins the sheet to the key and prints per-mode means and rates. The ratings are a person's
judgement on synthetic audio: one rater, small n, reported as such.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

import summarize

FIELDS = [
    "row",
    "direction",
    "source",
    "output",
    "reference",
    "accuracy",
    "fluency",
    "register_ok",
    "entities_ok",
    "notes",
]


def blind(paths: list[str], per_mode: int, key_path: str) -> int:
    logs = [json.loads(Path(p).read_text(encoding="utf-8")) for p in paths]
    modes = summarize.summarize(logs, summarize.load_scripts())
    rng = random.SystemRandom()
    rows: list[tuple[dict, str]] = []
    for mode, agg in sorted(modes.items()):
        # One output per script line, so a line the loop played twice is not rated twice.
        by_line: dict[str, tuple[dict, dict]] = {}
        for u, script in agg["matched"]:
            by_line.setdefault(script["id"], (u, script))
        picked = rng.sample(list(by_line.values()), min(per_mode, len(by_line)))
        for u, script in picked:
            rows.append(
                (
                    {
                        "direction": f"{script['lang']}>{script['target']}",
                        "source": script["text"],
                        "output": u["target"]["text"],
                        "reference": script["reference"],
                    },
                    mode,
                )
            )
    rng.shuffle(rows)
    out = csv.DictWriter(sys.stdout, fieldnames=FIELDS)
    out.writeheader()
    with open(key_path, "w", newline="", encoding="utf-8") as f:
        key = csv.writer(f)
        key.writerow(["row", "mode"])
        for i, (row, mode) in enumerate(rows, 1):
            out.writerow({**row, "row": i})
            key.writerow([i, mode])
    return 0


def scores(sheet_path: str, key_path: str) -> int:
    with open(key_path, encoding="utf-8") as f:
        key = {r["row"]: r["mode"] for r in csv.DictReader(f)}
    per: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    with open(sheet_path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            mode = key.get(r["row"])
            if mode is None or not r["accuracy"].strip():
                continue
            per[mode]["accuracy"].append(float(r["accuracy"]))
            if r["fluency"].strip():
                per[mode]["fluency"].append(float(r["fluency"]))
            for col in ("register_ok", "entities_ok"):
                v = r[col].strip().lower()
                if v in ("y", "n"):
                    per[mode][col].append(v == "y")
    print(
        "| Mode | Rated | Accuracy (1-5) | Fluency (1-5) | Register kept | Entities exact |"
    )
    print("|---|---|---|---|---|---|")
    for mode in sorted(per):
        d = per[mode]

        def mean(xs: list) -> str:
            return f"{sum(xs) / len(xs):.1f}" if xs else "–"

        def rate(xs: list) -> str:
            return f"{sum(xs)}/{len(xs)}" if xs else "–"

        print(
            f"| {summarize.name_of(mode)} | {len(d['accuracy'])} | {mean(d['accuracy'])} | "
            f"{mean(d['fluency'])} | {rate(d['register_ok'])} | {rate(d['entities_ok'])} |"
        )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("blind")
    b.add_argument("--per-mode", type=int, default=5)
    b.add_argument("--key", required=True)
    b.add_argument("logs", nargs="+")
    s = sub.add_parser("scores")
    s.add_argument("sheet")
    s.add_argument("key")
    args = ap.parse_args()
    if args.cmd == "blind":
        return blind(args.logs, args.per_mode, args.key)
    return scores(args.sheet, args.key)


if __name__ == "__main__":
    raise SystemExit(main())
