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
- When adding or changing Idle Heroes game knowledge, update files under `IHassistant/knowledge/`, follow the IHassistant rules in this file, then regenerate the AI knowledge index with `node scripts/build-ih-knowledge-index.mjs`.
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
- AI Q&A knowledge index: `flipgame/netlify/functions/_shared/ih-knowledge-index.mjs`, generated from game-related Markdown files and `IHassistant/knowledge/` text data.
- If data is regenerated from Excel, keep final browser data in CSV/JSON and document the source file.

## IHassistant Rules

- Knowledge base entrypoint: `IHassistant/README.md`.
- Detailed knowledge index: `IHassistant/knowledge/README.md`.
- Agent-specific game rules are maintained in this root `AGENTS.md`.
- Prefer adding new source material to the most specific subfolder under `IHassistant/knowledge/`.
- After updating game-related Markdown documents or `IHassistant/knowledge/` text data, regenerate `flipgame/netlify/functions/_shared/ih-knowledge-index.mjs` with `node scripts/build-ih-knowledge-index.mjs` so `flipgame/AIAsk.html` uses the latest project knowledge. Do not index website-maintenance docs such as login/VIP/PWA/admin/deploy docs unless they contain game rules.
- Do not invent game mechanics or lineup conclusions. If source material is incomplete, record the gap instead of filling it by assumption.
- Lineup advice must state the target scenario, core idea, key heroes/artifacts/positioning/speed or stat requirements, and known risks.
- Normal battles use up to 6 heroes per team. Analyze lineup advice by 6 positions unless a mode explicitly differs.
- PVP and PVE conclusions must be recorded separately.
- Star expedition imprints only apply to star expedition / expedition boss contexts unless explicitly documented otherwise.
- Star imprints, Foresight sets, Karl/Fate/Bull set bonuses, and similar expedition-only bonuses must not be applied to generic Boss, PVE, or PVP contexts by default.
- User-provided artifact screenshots should go under `IHassistant/knowledge/artifacts/`. Record screenshot filename, full artifact name, common shorthand, major tier, minor tier, and effects when organizing artifacts.

## Important Knowledge

- Soul stat total: `x + y + 100*z`.
- Soul stat average: `(x + y + 100*z) / 3`.
- Speed may have hidden decimals in game UI, so calculators may evaluate both `z` and `z+1`.
- X-tier soul logic is documented in `docs/soul-calculator.md`.
- Expedition score display rules are documented in `docs/expedition-calculator.md`.
- Registered-member pages currently include Soul Ascension and Expedition.
- VIP-only pages currently include Awakening Rush Simulator and AI Q&A.
- Each hero can choose 5 enables. Each enable slot picks 1 of 3 column options; enable 1 and enable 4 use the same three-option group. Enable tables with `lv1`/`lv2` subrows are treated as both active by default.
- In Boss formulas, `绝地` is enable 2 column 2 and currently uses the infused value `18%`.
- In Boss formulas, `均衡` is enable 5 column 1 and currently uses the infused value `45%`. Current balance-effect rule: if any normal-attack or active-skill damage segment from the same hero fails to crit in that hero's turn, the 45% extra damage applies to that turn's total damage, not only to the non-crit segment.
- Each team can carry 1 monster. Monster skills, aura, and rune upgrades can provide damage, healing, shields, or stat bonuses and must be included in lineup advice. Monster energy starts at 0, gains +10 whenever any hero casts an active skill, gains +20 at the end of each round, and casts at 100 energy.
- Each hero can wear gear and 1 artifact. Artifact stats must be included when evaluating final hero stats.
- Each hero can equip 1 soulstone. Soulstone affixes must be included when evaluating final speed, output, control, or survival.
- Each hero can have awakened copy stats. Awakening affixes must be included when evaluating final stats, control hit, control immunity, survival, or output. Awakening-copy data lives in `IHassistant/knowledge/awaken copy/`.
- Imprint infusion full configuration has 63 skill points. Each branch must be allocated top-down; each node costs 1 point except the final node, which costs 2 points. Imprint infusion data lives in `IHassistant/knowledge/imprint infusion/`.
- Artifacts have two major tiers: `辉煌神器` and `极境辉煌神器`. Each major tier has three minor tiers: `闪烁` = 1, `光辉` = 2, `璀璨` = 3. Common shorthand: `粉三` means `辉煌神器·璀璨`; `极3` means `极境辉煌神器·璀璨`.
- Artifact shorthand: `万灵秘境` is `镜子`; `断罪之剪` is `剪刀`.
- Damage formulas that mention `鹿角` default to extreme/deific tier 1 antlers' per-round damage increase coefficient. Earlier formula text saying `粉鹿角` is a typo and should be understood as `极鹿角`.
- Hero action order is determined by final speed. When a hero acts, energy below 100 uses normal attack; energy at 100 or more uses active skill.
