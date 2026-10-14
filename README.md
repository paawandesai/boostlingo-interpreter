# AI Interpreter Workbench: Realtime API vs. Cascade Pipeline

A browser workbench that interprets live speech two ways and measures both:

- **Realtime mode**: OpenAI Realtime API (`gpt-realtime`), voice in, voice out, over WebRTC.
- **Cascade mode**: streaming STT → translation → TTS, with swappable providers per stage.

Built for the Boostlingo Week 4 brief. Spec: [docs/SPEC.md](docs/SPEC.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agent workflow: [AGENTS.md](AGENTS.md).

> Status: skeleton. Setup, keys, architecture overview and "Why .NET + TypeScript" are completed in T4.5.

## Prerequisites

- .NET 10 SDK
- Node 22 and npm
- Headphones (the interpreter's voice otherwise leaks back into the mic)

## Run locally

```bash
# terminal 1: backend on http://localhost:5080
dotnet run --project server/Interpreter.Api

# terminal 2: frontend on http://localhost:5173 (proxies /health, /api, /ws to the backend)
cd web && npm ci && npm run dev
```

Open http://localhost:5173. The page shows "Backend: ok" when the round trip works.

## Test

```bash
dotnet test server
cd web && npm run lint && npm run typecheck && npm test
```

## Layout

```
server/   .NET 10: Interpreter.Api, Interpreter.Core, Interpreter.Providers.*, Interpreter.Tests
web/      React + Vite + TypeScript SPA (audio/, transports/, session/, components/)
config/   languages.json (adding a language pair is config only)
docs/     spec, architecture, tasks, acceptance, decisions
```
