# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Vite + React + TypeScript SPA that lets caregivers describe a rehab/group activity in natural language; Gemini turns the description into a JSON game spec; a Pixi.js engine plays it. Input comes from BLE pressure sensors — up to **4 players × 2 balls (left + right hand) = 8 pressure channels**.

There is no backend, no DB, no tests. The whole thing is browser-side, including the Vite middleware that saves AI-generated images to `public/assets/generated/`.

## Commands

```bash
npm install            # install deps
npm run dev            # vite dev server on :8000 (requires VITE_GEMINI_API_KEY in .env.local)
npm run build          # vite build → dist/
npm run preview        # serve dist/

docker compose up      # alternative dev runner; reads GEMINI_API_KEY from shell, mounts .env.local

node scripts/test_team_prompt.mjs   # ad-hoc: extracts SYSTEM_INSTRUCTION from geminiService.ts and asks Gemini to generate AUGP JSON for a fixed team-binding prompt. Use to sanity-check prompt changes without launching the UI.
```

No lint, no test runner. Type checking is implicit via Vite (`tsconfig.json` sets `noEmit: true`).

## Architecture: how a "game" flows through the system

The pipeline is **two-stage** — caregivers don't generate a full game in one shot. They first see a proposal card and confirm.

```
user prompt
    │
    ▼
[Stage 1] mechanicProposer.proposeMechanic ─► MechanicProposal {mechanic_id, theme, player_count, duration, caveats}
    │
    ▼
PlayProposalCard (UI: confirm / regenerate / edit-prompt; duration adjustable -30s/+30s)
    │ confirm
    ▼
[Stage 2] geminiService.generateGame(prompt, history, confirmedMechanic) ─► AUGP JSON
    │
    ▼
GameView.tsx (Pixi.js) reads AUGP, drives entities by BLE pressure, runs timer ─► SessionMetrics
```

Stage 1's job is to bound AI hallucination — by the time Stage 2 runs, AI knows the mechanic, theme, and player count, so it only fills in entity details. This narrows AI's freedom and removes the "guess the whole game" failure mode that the one-shot flow had.

### 1. The proposal-confirm-generate flow

- **`services/mechanicProposer.ts`** — Stage 1. Reads `MECHANICS` from the capability manifest, sends a compact prompt to Gemini at `temperature: 0.3`, returns `MechanicProposal` (matched mechanic id, confidence, friendly title/summary, player_count + reasoning, caveats, alternatives, activity_theme, recommended_duration_seconds). The `matched_mechanic_id` enum in the response schema is generated from `MECHANICS.map(m => m.id)`, so AI can't invent unknown mechanic ids — and the result's `mechanic_name` is overwritten from the manifest for safety.
- **`components/PlayProposalCard.tsx`** — the modal between Stage 1 and Stage 2. Three actions: confirm (passes proposal + adjusted duration to Stage 2), regenerate (re-runs Stage 1 with same prompt), edit-prompt (closes card, returns to textarea). Duration is locally adjustable via `-30s` / `+30s` (range 30–600s).
- **`services/geminiService.ts:generateGame`** now accepts an optional `confirmedMechanic: { mechanic_id, activity_theme, player_count }`. When present, the prompt prepends a "🎯 [使用者已確認玩法]" block with the mechanic's `engine_features`, `requires_metadata`, and `canonical_entities` (when defined), and temperature drops to `0.4`. Without `confirmedMechanic`, generateGame falls back to the original one-shot behavior — useful for legacy callers and direct-API testing.
- **`App.tsx` flow**: the "生成遊戲" button now calls `handleGenerateGame` → `proposeMechanic` (Stage 1). After the user confirms, `handleConfirmProposal(p)` fires Stage 2. Loading state has two phases: `proposing` (button text: "分析玩法中…") and `loading` (button text: "生成中…"). `sessionDurationSeconds` state flows from the confirmed proposal into `<GameView durationSeconds={...}>`.

### 2. AUGP — the contract between AI and engine

**AUGP (AIGrip Universal Game Protocol)** is the JSON schema in `services/geminiService.ts` and `types.ts` (`GameConfig`). Everything the AI produces and everything the engine reads is shaped by this schema. When extending the system, **you almost always update four places together**:

1. `services/engineCapabilities.ts` — the manifest (see section 3) declaring the new mechanic / atomic_action / role / collision_logic / metadata_flag.
2. `services/geminiService.ts` — the `SYSTEM_INSTRUCTION` prompt rules and the `responseSchema` enums/required fields.
3. `types.ts` — TypeScript shape mirrors the schema.
4. `components/GameView.tsx` — the engine that interprets the JSON.

If only some are updated, AI output and engine behavior drift. The system_instruction has explicit numbered rules (1–9 in section 二) plus a "團康活動模板庫" (section 四) of activity → mechanic mappings; treat it as authoritative when interpreting user prompts. The capability manifest is intended to gradually become the single source of truth that the other three derive from (steps 2–5 of that migration are not yet done).

Key AUGP concepts:

- **`atomic_action`** (`DRIVE` / `PULSE` / `NAVIGATE` / `SEQUENCE`): the only motion primitives the engine implements. `DRIVE` = pressure→Y acceleration (Y axis only). `PULSE` = burst pressure→upward impulse to same-sector + same-layout targets/obstacles (left hand only impulses left-side targets). `NAVIGATE` = R−L pressure diff→X position. `SEQUENCE` = step-gated by `metadata.sequence_pattern`.
- **`interaction_type`** (`DRIVE` / `PULSE` / `NAVIGATE` / `SEQUENCE` / `MIXED`): top-level mode that selects engine code paths in `GameView.tsx`.
- **`sector`** (`p1` … `p4` | `shared`): which player owns this entity. Drives 4-column layout, scoring, sector-locked PULSE impulse, and SEQUENCE wrong-side suppression.
- **`ball_binding`**: pressure source. Standard format `"p{N}_{left|right|both}"` (e.g. `p3_left`). Team-coop format `"team_a_all"` / `"team_b_all"` sums all members of team A/B (player_count auto-partitioned: 2P→1-per-team, 4P→2-per-team) — used for cooperative DRIVE games (划龍舟). Engine auto-switches DRIVE pawns with `team_*` binding to **rowing sub-mode**: rising-edge impulse instead of continuous thrust, no gravity, water damping only. Legacy `ball_1` / `p1` / `left` / `right` still parsed for back-compat. Resolver lives in the binding section of the per-entity ticker loop.
- **`metadata.taiko_sync_pattern`** (optional, `('left' | 'right' | 'both')[]`): opt-in for synchronized taiko-style group falling. Each element is a beat: `'left'` = all sectors' layout=left targets fall together; `'right'` = same for right; `'both'` = all sides fall simultaneously (typically used as a "downbeat"). Engine activates only when this array is non-empty; otherwise targets fall independently. Targets are consumed (hidden) on hit and reappear at next beat.
- **`collision_handlers[*].between`**: must use real entity `id`s — not `type` names. The engine validates this on config load and `console.warn`s mismatches.

### 3. Engine capability manifest (`services/engineCapabilities.ts`)

A consolidated TypeScript const that lists everything the engine can do: `ATOMIC_ACTIONS`, `INTERACTION_TYPES`, `ENTITY_TYPES`, `ENTITY_ROLES` (with `renders_as` tags), `LAYOUT_HINTS`, `SECTORS`, `LAYOUT_RULE`, `BALL_BINDINGS` (standard / team_coop / legacy formats and their constraints), `COLLISION_LOGIC` (on_match + penalty enums), `RENDER_MODES`, `METADATA_FLAGS`, `PLAYER_COUNT`, `MECHANICS` (the 7 mechanic-named templates), `UNSUPPORTED` (out-of-scope categories with reasons), `BEHAVIORAL_RULES` (AI-style prose indexed for navigation).

Important design choice: **mechanics are named for what the engine does, not for specific activities**. So `TEAM_COOP_RACE` (not `DRAGON_BOAT`) covers 划龍舟 / 扛轎 / 推車 / 登山賽 / 兩隊送貨 — each mechanic has an `activity_examples` array that caregivers/AI can extend without touching engine code. Same for `GROUP_RHYTHM` (太鼓 / 節奏 / 合奏), `FALL_CATCH` (接糖果 / 接氣球 / 打地鼠改編), etc.

The manifest also exports validation helpers (`isAtomicActionAxisValid`, `isBallBindingValid`) for engine-side guards. `mechanicProposer.ts` reads `MECHANICS` directly to construct its prompt and response enum. Currently the manifest is **additive** — the schema/prompt/engine still hold their own copies and stay in sync by discipline. Steps 2–5 of the migration (derive `types.ts`, derive `responseSchema` enums, derive prompt blocks, derive engine switches) are pending.

### 4. The engine (`components/GameView.tsx`)

This file is large (~1.5k lines) and contains the entire game loop. The structure is:

- **Top-level helpers** (lines ~50–110): `getEntityRole`, `getEntityLayout`, `getEntitySector`, `getLayoutX`, `getMixedPawnY`, `lerp`. `getLayoutX` is **player-count-aware**: 1–4 players all use the same rule — divide screen into `player_count` equal columns by `sector` (p1 leftmost, pN rightmost), `layout` offsets ±20% column width within each column. The 0.2 (not 0.25 or 0.3) is deliberate: it makes intra-column distance < inter-column distance, so a player's two hands appear visually paired rather than mis-grouped with the neighboring player. `sector: "shared"` falls back to legacy 25%/50%/75%.
- **Initial entity placement** (~340–410): geometric shapes per `role` (mushroom=red circle, basket=blue rect, paddle=blue rounded rect, target=yellow circle, obstacle=dark grey circle with white X, decoration=skipped). `role === 'mushroom'` is matched **before** `type === 'target'` in the render chain — pick `role: "decoration"` on a target to fall through to the yellow target render. Initial Y differs by mode: team-bound boats start at `screen*0.92` (very bottom), PULSE/NAVIGATE pawns at `screen*0.82` (catch-paddle position), DRIVE pawns at `screen*0.8`, others at `screen/2`. `themed` mode swaps in AI-generated images via `applyTheme`.
- **Ticker callback** (the per-frame physics): per-entity binding resolution → atomic_action handling → unified target/obstacle drop logic. Two synchronized-group modes activate based on entity/metadata signals before per-entity processing: (1) **rowing mode** for `team_*_all`-bound DRIVE pawns (no gravity, rising-edge impulse, water damping); (2) **taiko sync** when `metadata.taiko_sync_pattern` is non-empty — a global `taikoSyncRef` tracks `leftY` / `rightY` and a `patternIndex` cycling through the user-supplied pattern; same-layout targets across sectors share the corresponding group Y; `consumedThisBeat` set hides drums after a SCORE_HIT and resets at beat transitions. SEQUENCE mode has special X tracking (single target alternates by `sequenceStepRef`; multi-target locks each to its sector column).
- **Collision loop**: iterates `cfg.collision_handlers`, applies SEQUENCE wrong-turn suppression (only blocks pawn↔target, never pawn↔obstacle so pressure-trap penalties still fire), then `on_match_logic` / `penalty_logic`. `GAME_WIN` self-increments score before checking `target_score`, so first collision triggers win when `target_score: 1`. Pawn nudge feedback uses scale flash (no Y offset) to avoid drift accumulation across rapid hits.
- **Score state**: `scoreRefs.current = { global, p1, p2, p3, p4 }`. The display string loops up to `player_count`. Team races (划龍舟) end via `GAME_WIN` collision; per-team aggregate score is not tracked — first finish line touch wins regardless of which player triggered it.
- **Session timer** (top-right `⏱ M:SS`): `<GameView durationSeconds={...}>` enables a per-frame countdown. When `remaining <= 0`, the engine fires `onSessionEnd(metrics)` (the same path as `GAME_WIN`). Last 10 seconds the text turns red. Without a `durationSeconds` prop, the timer is hidden and the session is open-ended. Race-type games still end early via `GAME_WIN` if someone reaches the finish line first; the timer is the upper bound, not a forced duration.
- **PULSE-mode collision gating**: collisions for `paddle` entities in PULSE mode require `phys.hasFired === true`, otherwise drums/targets passively falling through unpressed paddles would auto-score. `hasFired` is set when pressure crosses 0.6 and reset when it drops below 0.15 (the same require_reset machinery that gates the impulse).
- **Taiko sync vs PULSE impulse**: in taiko-sync mode, the per-frame `phys.vy = 0` override is skipped while `phys.vy < 0` (just got impulsed), so the drum visibly bounces upward before the `consumedThisBeat` set hides it.
- **Paddle width is player-count-adaptive**: 150 / 130 / 110 px for 1–2 / 3 / 4 players, to prevent visual overlap when 4P × 2 hands fit into 4 columns.

### 5. Image generation

`services/imageService.ts` generates entity sprites and backgrounds via Gemini image models. Generated images are POSTed to a Vite middleware (`vite.config.ts` `save-generated-image` plugin) that writes them under `public/assets/generated/` so they persist across reloads. The same plugin also serves `GET /api/list-images` for browsing the cached set. `render_mode: "geometric"` (default) skips this; `themed` triggers it.

### 6. Sensor input

BLE service/characteristic UUIDs are hardcoded in `App.tsx` (`BLE_SERVICE_UUID`, `BLE_CHARACTERISTIC_UUID`). The `pressures` prop passed into `<GameView>` is keyed by player ID with `{ left, right }` per player. Calibration produces `mvcL` / `mvcR` for normalization.

### 7. Patient & prescription state

`App.tsx` is large (~1.5k lines) because it also owns localStorage-backed **Patient profiles** and **SavedPrescription history** alongside BLE/calibration. Shapes live in `types.ts` (`Patient`, `SavedPrescription`, `SessionMetrics`). The UIs over those are `components/PatientManagementModal.tsx` (CRUD + daily MVC), `components/SummaryView.tsx` (post-session metrics + save), and `components/AISuggestionModal.tsx` (next-session recommendation). When changing the data shapes, remember nothing migrates localStorage — older saved prescriptions can break silently.

## Important conventions

- **New mechanics start in the manifest**. When adding a new engine capability (atomic action, role, on_match logic, metadata flag, mechanic template), update `services/engineCapabilities.ts` first — it's the canonical inventory and the proposer reads from it. Then propagate to `geminiService.ts` (prompt rules + responseSchema enum), `types.ts` (union types), and `GameView.tsx` (interpretation). The proposer will silently fail to expose a new mechanic if it isn't in `MECHANICS`.
- **Mechanic naming is generic, activities are extensible**. Don't name a mechanic after a single activity (no `DRAGON_BOAT`); name it for what the engine does (`TEAM_COOP_RACE`) and add the activity under `activity_examples`. New themes (e.g., 推消防栓、運送神轎) should usually only require a new entry in an existing mechanic's examples, not a new mechanic.
- **Layout limitations are real**: N columns for `player_count` players (1–4), no top/bottom row split, no 2×2 grid, no random pop-up spawn. Section 四 of system_instruction lists what the engine can and can't do — keep it in sync when adding features.
- **HMR is reliable for engine and prompt edits**. Editing `GameView.tsx` or `geminiService.ts` while the dev server runs is the normal iteration loop; no rebuild needed. The proposal flow also hot-reloads cleanly.
- **The proposer is a small, fast call by design** (`gemini-2.5-flash`, `temperature: 0.3`, MECHANICS list as system instruction). Don't bloat its prompt — its job is to pick a mechanic, not to design the game. Game design happens in Stage 2.
