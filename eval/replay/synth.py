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
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "synthetic"
URL = "https://api.openai.com/v1/audio/speech"
# Stock voice and model the app itself uses (server ElevenLabsOptions).
ELEVEN_URL = (
    "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=pcm_24000"
)
ELEVEN_VOICE = "JBFqnCBsd6RMkjVDRZzb"
ELEVEN_MODEL = "eleven_flash_v2_5"


def eleven_request(key: str, text: str) -> urllib.request.Request:
    body = json.dumps({"text": text, "model_id": ELEVEN_MODEL}).encode()
    return urllib.request.Request(
        ELEVEN_URL.format(voice=ELEVEN_VOICE),
        data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )


def write_pcm_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="only the first N rows")
    parser.add_argument("--voice", default="alloy")
    parser.add_argument(
        "--model", default=os.environ.get("SYNTH_TTS_MODEL", "gpt-4o-mini-tts")
    )
    parser.add_argument(
        "--provider", choices=["openai", "elevenlabs"], default="openai"
    )
    parser.add_argument("--only", default="", help="only ids starting with this prefix")
    args = parser.parse_args()
    env = "ELEVENLABS_API_KEY" if args.provider == "elevenlabs" else "OPENAI_API_KEY"
    key = os.environ.get(env)
    if not key:
        print(f"{env} is not set", file=sys.stderr)
        return 2
    rows = [
        json.loads(x)
        for x in (HERE / "scripts.jsonl").read_text(encoding="utf-8").splitlines()
        if x.strip()
    ]
    rows = [r for r in rows if r["id"].startswith(args.only)]
    if args.limit:
        rows = rows[: args.limit]
    OUT.mkdir(exist_ok=True)
    for row in rows:
        path = OUT / f"{row['id']}.wav"
        if path.exists():
            continue
        if args.provider == "elevenlabs":
            with urllib.request.urlopen(
                eleven_request(key, row["text"]), timeout=60
            ) as resp:
                write_pcm_wav(path, resp.read())
            print(f"wrote {path.name}")
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
        f"Synthetic TTS clips ({args.provider}). Not the measured replay set.\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
