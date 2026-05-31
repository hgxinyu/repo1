# AGENTS.md

This repository contains a static tool site under `flipgame/` and an Idle Heroes knowledge base under `IHassistant/`. Follow these rules when making changes as an agent.

## Local Server

Use this command from the repository root when a page reads CSV/JSON:

```bash
cd flipgame && python3 -m http.server 8000
```

Open `http://localhost:8000/`. Do not validate `fetch()` pages through `file://`.

## Project Shape

- Main app files are standalone HTML pages in `flipgame/`.
- Static pages still have no build step.
- Netlify Functions live under `flipgame/netlify/functions/` and use `flipgame/package.json` for deploy dependencies.
- Shared data is stored as CSV/JSON next to the pages that load it.
- The site supports zh/en text through per-page I18N objects.
- Local and production app icons are selected by hostname in each page header.
- `IHassistant/` is the Idle Heroes knowledge base. It stores game mechanics, heroes, artifacts, soulstones, monsters, bosses, modes, lineups, screenshots, and source notes.
- `IHassistant/` is not automatically public site content. Do not copy knowledge files into `flipgame/` unless the user explicitly asks to expose them through a public or VIP page.

## Editing Rules

- Preserve existing single-file page patterns unless the user explicitly asks for a refactor.
- When changing visible text, update both Chinese and English I18N entries when present.
- When changing calculator rules, update the matching document under `docs/`.
- When changing VIP, login, admin, or permission behavior, update `docs/vip-access.md`.
- When adding or changing Idle Heroes game knowledge, update files under `IHassistant/knowledge/` and follow `IHassistant/AGENTS.md`.
- Keep facts, inferences, and unverified claims separate in knowledge files. Mark uncertain game conclusions as `待确认`.
- When future VIP knowledge-base pages are added, keep permission behavior documented in both `docs/vip-access.md` and `docs/ihassistant.md`.
- Do not commit `.DS_Store`, local spreadsheet working files, screenshots, or temporary generated files.
- Be careful with the user's dirty worktree. Do not revert unrelated user edits.

## Git / Deploy Rules

- Do not push after every small change by default. Netlify deploys consume credits on each push.
- Prefer batching related changes into one commit and one push after the user confirms the work is ready.
- If the user explicitly asks to push, push only the intended staged changes and leave unrelated dirty worktree changes alone.

## Data Rules

- Soul calculator data source: `flipgame/soul_tiers.csv`.
- Expedition calculator data source: `flipgame/seboss_all.json`.
- Guide images live under `flipgame/images/`.
- Knowledge base images and source screenshots live under `IHassistant/knowledge/`.
- If data is regenerated from Excel, keep final browser data in CSV/JSON and document the source file.

## IHassistant Rules

- Knowledge base entrypoint: `IHassistant/README.md`.
- Detailed knowledge index: `IHassistant/knowledge/README.md`.
- Agent-specific game rules: `IHassistant/AGENTS.md`.
- Prefer adding new source material to the most specific subfolder under `IHassistant/knowledge/`.
- Do not invent game mechanics or lineup conclusions. If source material is incomplete, record the gap instead of filling it by assumption.
- PVP and PVE conclusions must be recorded separately.
- Star expedition imprints only apply to star expedition / expedition boss contexts unless explicitly documented otherwise.

## Important Knowledge

- Soul stat total: `x + y + 100*z`.
- Soul stat average: `(x + y + 100*z) / 3`.
- Speed may have hidden decimals in game UI, so calculators may evaluate both `z` and `z+1`.
- X-tier soul logic is documented in `docs/soul-calculator.md`.
- Expedition score display rules are documented in `docs/expedition-calculator.md`.
- Registered-member pages currently include Soul Ascension and Expedition.
- VIP-only pages currently include Awakening Rush Simulator.
