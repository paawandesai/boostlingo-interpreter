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
# project uses; "confirm" means Paawan has not yet confirmed the tier. The
# retention column mirrors the data-flow table in docs/WRITEUP.md (G4); each
# † means checked 2026-10-16 only against search excerpts of the vendor's
# page (not fetched); Paawan confirms each before submission.
PROVIDERS = """\
| Provider | Used for | Terms that matter here | Plan tier | Default retention / zero retention / BAA |
|---|---|---|---|---|
| OpenAI | Realtime (`gpt-realtime-2.1`, `gpt-realtime` selectable), input transcription (`gpt-4o-mini-transcribe`); cascade STT fallback (`gpt-4o-transcribe`); cascade translator (`gpt-5.4-mini`); TTS for synthetic test speech in live tests | Usage policies; Services Agreement 3.3 (no competing models from output, no transferring keys); AI-voice disclosure to listeners | Pay-as-you-go API (confirm) | abuse-monitoring logs up to 30 days † / Zero Data Retention by OpenAI approval, per endpoint † / BAA; realtime and audio endpoints only with Healthcare Addendum and Modified Retention † |
| Deepgram | Cascade STT (Nova-3), `mip_opt_out=true` on every connection | ToS clause (i): no use "for competitive purposes, including ... benchmarking" without written consent; clause (n): no implied endorsement. Consent being requested (2026-10-14); see README "Known constraints" | Pay-as-you-go API (confirm) | no default figure found †; `mip_opt_out=true` sent / no policy found † / BAA on request † |
| Anthropic | Cascade translator (Claude Haiku tier; live fidelity smoke tests pass 2026-10-14) | Usage Policy (AI disclosure; human review for high-risk medical and legal use); Commercial Terms D.3 and D.4 | API (confirm) | not retained by default (Covered Models 30 days, flagged up to 2 years) / per organization via sales / BAA via Claude Console, eligible features only (all fetched 2026-10-16) |
| ElevenLabs | Cascade TTS (Flash v2.5, stream-input WebSocket); stock voices only, enforced by an allow-list (G5) | Free plan is non-commercial and requires attribution: **a paid plan is required** (docs/GUARDRAILS.md) | Starter (paid; Paawan, 2026-10-16) | no API figure found; non-enterprise data trained on unless opted out † / Zero Retention Mode, enterprise only † / BAA enterprise only † |
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


# Hand-maintained: eval/requirements.txt (offline scripts, never shipped). Licences
# from each package's PyPI metadata on the pinned version; update with the pins.
PYTHON = [
    ("jiwer", "4.0.0", "direct", "Apache-2.0"),
    ("sacrebleu", "2.5.1", "direct", "Apache-2.0"),
    ("click", "8.5.0", "transitive", "BSD-3-Clause"),
    ("colorama", "0.4.6", "transitive", "BSD-3-Clause"),
    ("lxml", "6.1.3", "transitive", "BSD-3-Clause"),
    ("numpy", "2.5.3", "transitive", "BSD-3-Clause AND 0BSD AND MIT AND Zlib"),
    ("portalocker", "4.4.0", "transitive", "BSD-3-Clause"),
    ("rapidfuzz", "3.14.6", "transitive", "MIT"),
    ("regex", "2026.9.29", "transitive", "Apache-2.0 AND CNRI-Python"),
    ("tabulate", "0.10.0", "transitive", "MIT"),
]


def python_section() -> tuple[str, list[str]]:
    flagged = []
    for name, ver, _, lic in PYTHON:
        parts = [p for p in re.split(r"\s+(?:OR|AND)\s+|[()]", lic) if p]
        if not all(p in PERMISSIVE for p in parts):
            flagged.append(f"{name} {ver} ({lic})")
    out = ["### Evaluation scripts (Python, eval/requirements.txt, not shipped)", "",
           "| Package | Version | Reference | Licence |", "|---|---|---|---|",
           *[f"| {n} | {v} | {k} | {lic} |" for n, v, k, lic in PYTHON], ""]
    return "\n".join(out), flagged


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
    text, f = python_section()
    sections.append(text)
    flagged += [f"Evaluation scripts (Python): {x}" for x in f]

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

Reviewed 2026-10-15: `numpy` bundles code under Zlib, and `regex` includes code under the CNRI Python licence (the permissive licence of Python 1.6.1). Both are permissive, used only by the offline evaluation scripts, and never shipped with the app.

## Packages

{chr(10).join(sections)}
"""
    (ROOT / "LICENSES.md").write_text(doc, encoding="utf-8")
    print(f"LICENSES.md written; {len(flagged)} package(s) listed for review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
