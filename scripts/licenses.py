#!/usr/bin/env python3
"""Regenerate LICENSES.md (docs/GUARDRAILS.md, Dependencies).

Run from the repo root after `npm ci` in ./ and ./web and `dotnet restore server`:

    python3 scripts/licenses.py

npm licences come from license-checker-rseidelsohn (the maintained fork of
license-checker; the original has had no release since 2019). NuGet licences
come from each package's .nuspec in the local NuGet cache, for every package in
the committed packages.lock.json files (direct and transitive).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = "license-checker-rseidelsohn@5.0.1"

# Licences that may ship in this commercial app without review. Anything else is
# listed by name so a human checks it (docs/GUARDRAILS.md forbids GPL/AGPL linked
# in, NC, research-only and revenue-capped licences).
PERMISSIVE = {
    "MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0",
    "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Python-2.0",
}

# Hand-maintained: third-party services the app calls. Plan tiers are what the
# project uses; "confirm" means Paawan has not yet confirmed the tier.
PROVIDERS = """\
| Provider | Used for | Terms that matter here | Plan tier |
|---|---|---|---|
| OpenAI | Realtime (`gpt-realtime`), input transcription (`gpt-4o-mini-transcribe`); planned cascade STT fallback and translator | Usage policies; Services Agreement 3.3 (no competing models from output, no transferring keys); AI-voice disclosure to listeners | Pay-as-you-go API (confirm) |
| Deepgram | Planned cascade STT (Nova-3) | ToS clause (i): no use "for competitive purposes, including ... benchmarking" without written consent; clause (n): no implied endorsement. Consent being requested (2026-10-14); see README "Known constraints" | Pay-as-you-go API (confirm) |
| Anthropic | Planned cascade translator (Claude Haiku) | Usage Policy (AI disclosure; human review for high-risk medical and legal use); Commercial Terms D.3 and D.4 | API (confirm) |
| ElevenLabs | Planned cascade TTS (Flash) | Free plan is non-commercial and requires attribution: **a paid plan is required** (docs/GUARDRAILS.md) | Paid plan (Paawan upgraded 2026-10-14; tier name to record) |
"""


def run_checker(cwd: Path, scope: str) -> dict:
    out = subprocess.run(
        ["npx", "-y", CHECKER, "--json", "--excludePrivatePackages", f"--{scope}"],
        cwd=cwd, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def npm_section(label: str, cwd: Path, scope: str) -> tuple[str, list[str]]:
    data = run_checker(cwd, scope)
    counts: Counter[str] = Counter()
    flagged: list[str] = []
    for name_ver, info in sorted(data.items()):
        lic = info.get("licenses", "UNKNOWN")
        lic = " OR ".join(lic) if isinstance(lic, list) else str(lic)
        counts[lic] += 1
        if not any(p in PERMISSIVE for p in re.split(r"\s+(?:OR|AND)\s+|[()]", lic) if p):
            flagged.append(f"{name_ver} ({lic})")
    lines = [f"### {label}", "", "| Licence | Packages |", "|---|---|"]
    lines += [f"| {lic} | {n} |" for lic, n in counts.most_common()]
    lines.append("")
    return "\n".join(lines), flagged


def nuget_packages() -> dict[str, tuple[str, set[str]]]:
    pkgs: dict[str, tuple[str, set[str]]] = {}
    for lock in sorted((ROOT / "server").glob("*/packages.lock.json")):
        data = json.loads(lock.read_text(encoding="utf-8-sig"))
        for deps in data.get("dependencies", {}).values():
            for pid, meta in deps.items():
                if meta.get("type") == "Project":
                    continue
                ver = meta.get("resolved")
                if not ver:
                    continue
                kinds = pkgs.setdefault(pid, (ver, set()))[1]
                kinds.add(meta.get("type", "?"))
    return pkgs


def nuspec_license(pid: str, ver: str) -> str:
    cache = Path(os.environ.get("NUGET_PACKAGES", Path.home() / ".nuget" / "packages"))
    spec = cache / pid.lower() / ver.lower() / f"{pid.lower()}.nuspec"
    if not spec.exists():
        return "UNKNOWN (not in local cache; run dotnet restore)"
    root = ET.parse(spec).getroot()
    ns = {"n": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    q = (lambda t: f"n:{t}") if ns else (lambda t: t)
    meta = root.find(q("metadata"), ns)
    lic = meta.find(q("license"), ns) if meta is not None else None
    if lic is not None and lic.get("type") == "expression":
        return lic.text or "UNKNOWN"
    if lic is not None:
        return f"file: {lic.text}"
    url = meta.find(q("licenseUrl"), ns) if meta is not None else None
    return f"url: {url.text}" if url is not None else "UNKNOWN"


def nuget_section() -> tuple[str, list[str]]:
    rows, flagged = [], []
    by_lic: defaultdict[str, int] = defaultdict(int)
    for pid, (ver, kinds) in sorted(nuget_packages().items(), key=lambda x: x[0].lower()):
        lic = nuget_license_cached(pid, ver)
        by_lic[lic] += 1
        kind = "direct" if "Direct" in kinds else "transitive"
        rows.append(f"| {pid} | {ver} | {kind} | {lic} |")
        if lic not in PERMISSIVE:
            flagged.append(f"{pid} {ver} ({lic})")
    out = ["### Server (NuGet, all projects, direct and transitive)", "",
           "| Licence | Packages |", "|---|---|"]
    out += [f"| {lic} | {n} |" for lic, n in sorted(by_lic.items(), key=lambda x: -x[1])]
    out += ["", "<details><summary>Every NuGet package</summary>", "",
            "| Package | Version | Reference | Licence |", "|---|---|---|---|", *rows, "", "</details>", ""]
    return "\n".join(out), flagged


_cache: dict[tuple[str, str], str] = {}


def nuget_license_cached(pid: str, ver: str) -> str:
    key = (pid, ver)
    if key not in _cache:
        _cache[key] = nuspec_license(pid, ver)
    return _cache[key]


def main() -> int:
    sections, flagged = [], []
    for label, cwd, scope in [
        ("Web app, shipped in the browser bundle (npm production)", ROOT / "web", "production"),
        ("Web app, build and test only (npm development)", ROOT / "web", "development"),
        ("Repo tooling: git hooks (npm development)", ROOT, "development"),
    ]:
        text, f = npm_section(label, cwd, scope)
        sections.append(text)
        flagged += [f"{label}: {x}" for x in f]
    text, f = nuget_section()
    sections.append(text)
    flagged += [f"Server: {x}" for x in f]

    review = "\n".join(f"- {x}" for x in flagged) or "- None."
    doc = f"""# LICENSES

Generated by `python3 scripts/licenses.py` on {date.today().isoformat()}. Re-run before submission (docs/GUARDRAILS.md).
Do not edit the generated sections by hand; edit the provider table in the script.

## Third-party services

{PROVIDERS}
## Packages needing a human look

Anything not on the permissive list ({", ".join(sorted(PERMISSIVE))}). Each needs a reason it is acceptable, recorded here.

{review}

Reviewed 2026-10-14: `lightningcss` (MPL-2.0, CSS tooling inside Vite) and `caniuse-lite` (CC-BY-4.0, browser-support data) are build-time tools only. Neither is linked into the server or included in the browser bundle, and neither is modified, so MPL's file-level copyleft and CC-BY's attribution duty are not triggered by shipping the app. If this list grows, review each new entry before merging. No GPL, AGPL, non-commercial or research-only licence appears.

## Packages

{chr(10).join(sections)}
"""
    (ROOT / "LICENSES.md").write_text(doc, encoding="utf-8")
    print(f"LICENSES.md written; {len(flagged)} package(s) listed for review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
