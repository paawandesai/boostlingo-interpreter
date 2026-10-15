"""Validates scripts.jsonl: unique ids, known sets and languages, glossary terms in references."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = Path(__file__).with_name("scripts.jsonl")
SETS = {"conversation", "adversarial", "medical", "onboarding"}
# Languages come from the app's config, so onboarding a pair needs no change here.
LANGS = {
    lang["code"]
    for lang in json.loads(
        (ROOT / "config" / "languages.json").read_text(encoding="utf-8")
    )["languages"]
}


def glossary_pairs() -> dict[str, str]:
    data = json.loads((ROOT / "config" / "glossary.json").read_text(encoding="utf-8"))
    pairs: dict[str, str] = {}
    for entry in data["entries"]:
        pairs[entry["en"]] = entry["es"]
        pairs[entry["es"]] = entry["en"]
    return pairs


def main() -> int:
    rows = [
        json.loads(line)
        for line in SCRIPTS.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    pairs = glossary_pairs()
    problems: list[str] = []
    seen: set[str] = set()
    for row in rows:
        rid = row.get("id", "?")
        if rid in seen:
            problems.append(f"{rid}: duplicate id")
        seen.add(rid)
        if row.get("set") not in SETS:
            problems.append(f"{rid}: unknown set {row.get('set')!r}")
        if (
            row.get("lang") not in LANGS
            or row.get("target") not in LANGS
            or row["lang"] == row["target"]
        ):
            problems.append(f"{rid}: bad lang/target")
        if not rid.startswith(f"{row.get('lang')}-"):
            problems.append(f"{rid}: id must start with the language code")
        if not row.get("text") or not row.get("reference"):
            problems.append(f"{rid}: missing text or reference")
        for term in row.get("terms", []):
            if term.lower() not in row["text"].lower():
                problems.append(f"{rid}: term {term!r} not in text")
            target = pairs.get(term)
            if target is None:
                problems.append(f"{rid}: term {term!r} not in the glossary")
            elif target.lower() not in row["reference"].lower():
                problems.append(f"{rid}: reference lacks {target!r}")
    counts: dict[str, int] = {}
    for row in rows:
        key = (
            row["set"]
            if row["set"] != "conversation"
            else f"conversation-{row['lang']}"
        )
        counts[key] = counts.get(key, 0) + 1
    print(
        f"{len(rows)} rows: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
    )
    for p in problems:
        print(p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
