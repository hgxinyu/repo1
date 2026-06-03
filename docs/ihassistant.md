# IHassistant Knowledge Base

`IHassistant/` is the internal Idle Heroes knowledge base for this repository. It is separate from the public static pages in `flipgame/`.

## Purpose

The knowledge base stores structured game information that can later support VIP-only pages, calculators, recommendations, and searchable guides.

Current scope:

- Game mechanics and formulas.
- Hero skill notes, positioning, strengths, and limitations.
- Artifacts, soulstones, monsters, awakenings, star souls, expedition imprints, and imprint infusion.
- Boss mechanics and mode-specific configuration rules.
- Lineup cases, source screenshots, and user-provided observations.

## Directory Map

- `IHassistant/README.md`: human-facing overview.
- `AGENTS.md`: root agent rules, including game-knowledge work rules.
- `IHassistant/knowledge/README.md`: knowledge index and recording rules.
- `IHassistant/knowledge/mechanics/`: common formulas, damage types, controls, and attribute rules.
- `IHassistant/knowledge/heroes/`: hero-specific files and screenshots.
- `IHassistant/knowledge/artifacts/`: artifact names, shorthand, levels, screenshots, and effects.
- `IHassistant/knowledge/soulstone/`: soulstone affixes and screenshots.
- `IHassistant/knowledge/monster/`: monster skills, auras, runes, and screenshots.
- `IHassistant/knowledge/bosses/`: boss-specific mechanics.
- `IHassistant/knowledge/modes/`: game-mode rules and context boundaries.
- `IHassistant/knowledge/lineups/`: lineup examples and scenario notes.
- `IHassistant/knowledge/templates/`: templates for adding new facts.

## Access Model

For now, `IHassistant/` is a repository knowledge source, not a public website section.

Future VIP access should expose selected knowledge through pages under `flipgame/`, guarded by the same account-permission system used by VIP tools. Do not directly publish the whole `IHassistant/knowledge/` tree unless that is intentional.

The current VIP-only Play IH with AI page (`flipgame/AIAsk.html`) can use game-related Markdown documents and selected text content from `IHassistant/knowledge/`. Website-maintenance docs such as login, VIP, PWA, admin, and deploy docs are excluded from the game knowledge index. The content is generated into the private Netlify Function module `flipgame/netlify/functions/_shared/ih-knowledge-index.mjs`, then filtered by question before being sent to the AI provider. Do not expose the raw knowledge directory as public static content unless that is intentional.

Recommended future flow:

1. Keep raw knowledge and screenshots in `IHassistant/knowledge/`.
2. Create curated VIP pages in `flipgame/`.
3. Load only the curated JSON/Markdown/export needed by those pages.
4. Gate those pages through the VIP guard.
5. Document permission changes in `docs/vip-access.md`.

## Maintenance Rules

- Keep facts, inferences, and unverified notes separate.
- Mark uncertain conclusions as `待确认`.
- Record source context when possible: game text, screenshot, battle observation, user experience, and date.
- Keep PVP and PVE conclusions separate.
- Do not apply star expedition-only systems to general PVE/PVP unless a source explicitly supports that.
- Add new screenshots next to the topic they document.

## Git Note

If `IHassistant/` is intended to become a normal subdirectory of this repo, remove its nested `.git` directory before adding it to the root repository.

If `IHassistant/` should remain an independent repository, convert it into a real Git submodule instead of committing a copied nested repo.
