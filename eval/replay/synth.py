"""Writes a SYNTHETIC replay set with OpenAI text-to-speech (labelled extra set, never the measured one).

Usage: OPENAI_API_KEY=... python3 eval/replay/synth.py [--limit N] [--voice NAME]
Clips land in eval/replay/synthetic/ (gitignored) as <id>.wav. The key is read from the
environment and never printed. Each clip is a billed request.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "synthetic"
URL = "https://api.openai.com/v1/audio/speech"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="only the first N rows")
    parser.add_argument("--voice", default="alloy")
    parser.add_argument(
        "--model", default=os.environ.get("SYNTH_TTS_MODEL", "gpt-4o-mini-tts")
    )
    args = parser.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 2
    rows = [
        json.loads(x)
        for x in (HERE / "scripts.jsonl").read_text(encoding="utf-8").splitlines()
        if x.strip()
    ]
    if args.limit:
        rows = rows[: args.limit]
    OUT.mkdir(exist_ok=True)
    for row in rows:
        path = OUT / f"{row['id']}.wav"
        if path.exists():
            continue
        body = json.dumps(
            {
                "model": args.model,
                "voice": args.voice,
                "input": row["text"],
                "response_format": "wav",
            }
        ).encode()
        req = urllib.request.Request(
            URL,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            path.write_bytes(resp.read())
        print(f"wrote {path.name}")
    (OUT / "SYNTHETIC.txt").write_text(
        f"Synthetic TTS clips ({args.model}, voice {args.voice}). Not the measured replay set.\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
