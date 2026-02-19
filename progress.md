Original prompt: please continue building the runescape version of this https://www.agentarena.space/

we want a duel arena and an open world side scroller for agents

## 2026-02-18
- Investigated current codebase state.
- Found existing duel backend + two frontends (`/` React dashboard, `/game.html` side-scroller).
- Identified side-scroller integration bugs with backend API contract:
  - registration response field mismatch
  - invalid action/special/food IDs
  - wrong tick result parsing
- Planned implementation:
  1) fix duel loop wiring
  2) add event-driven world-agent presence via WebSocket
  3) render connected agents in side-scroller
  4) add backend tests

### Completed in this pass
- Added backend open-world presence model:
  - `worldAgents` store with TTL pruning.
  - `worldSubscribers` WebSocket subscriber set.
  - helpers: `upsertWorldAgent`, `removeWorldAgent`, `getActiveWorldAgents`.
- Added API endpoint: `GET /api/v1/world/agents`.
- Extended `/ws/arena` protocol with world events:
  - `world_subscribe` -> snapshot payload `{ type: 'world_state', agents }`
  - `world_update` -> broadcast `{ type: 'world_update', agent }`
  - `world_leave` -> broadcast `{ type: 'world_leave', agent_id }`
- Fixed WebSocket route finalization bug by returning concrete responses in `/ws/arena` upgrade handler.
- Updated side-scroller (`public/game.html`):
  - Fixed registration response handling (`status` + `agent`).
  - Fixed duel AI to use valid backend action/special/prayer/food IDs.
  - Fixed tick result parsing (`result` instead of `tick_result`).
  - Added real-time world agent presence socket client and rendering of connected agents.
  - Added movement broadcasting to backend world channel (throttled, event-driven).
  - Added `window.render_game_to_text` and `window.advanceTime(ms)` hooks.
- Added dashboard nav link from arena console to side-scroller (`/game.html`).
- Added deterministic tests for world presence store (`src/__tests__/store.test.ts`).

### Validation run
- `bun test` -> PASS (3 tests).
- Server boot smoke test -> PASS.
- `curl http://localhost:3000/ws/arena` -> `426 Expected WebSocket upgrade request` (expected).
- Browser smoke via Playwright MCP:
  - Registered from side-scroller successfully.
  - Duel auto-started and progressed.
  - Open-world agent presence reflected in `render_game_to_text`.

### Next TODOs
- Replace side-scroller local bot duel loop with actual remote-agent matchmaking (agent vs agent) instead of auto-spawned local bot.
- Add a small in-game panel to list nearby open-world agents and invite/challenge directly.
- Add automated integration test for WebSocket world presence (subscribe -> update -> leave).

## 2026-02-18 (Implementation pass: Al Kharid + Emir's Arena + skilling)
- Added near-authentic progression and skilling foundations:
  - Skill state + inventory models in backend.
  - OSRS-like XP table and global 1.12x XP multiplier.
  - Combat XP attribution to attack/strength/defence/ranged/magic/hitpoints.
- Added persistent storage scaffolding (optional `DATABASE_URL`):
  - `postgres` dependency.
  - DB client/schema/repository modules.
  - Durable writes for agents, skills, inventory, duel ticks, and skill events when DB is configured.
- Added duel queue and portal flow:
  - New endpoints for queue join/leave/list and portal use.
  - Matchmaking from queue to fight creation.
  - Fallback bot queue timer support.
  - WebSocket `duel_queue_update` + `duel_match_found` broadcast support.
- Added open-world skilling loops (event-driven, no polling scans):
  - Resource node catalog for mining/fishing/woodcutting tiers up to runite/magic tree/shark.
  - Start/stop interaction endpoint with distance validation + level gates.
  - Per-agent skill tick timers and per-node respawn timers.
  - Resource depletion/respawn events over WebSocket.
- Expanded WS protocol:
  - `duel_queue_subscribe`, `skill_subscribe`, `world_interact_start`, `world_interact_stop`.
  - `skill_xp`, `skill_level_up`, `inventory_update`, `resource_node_update`.
- Updated side-scroller world and duel UX:
  - Added Al Kharid zone and Emir's Arena portal landmark.
  - Added Emir's Herald NPC guidance.
  - Queue-first duel flow from portal (no auto-duel on registration).
  - Added rendering + interaction for resource nodes and gathering.
- Updated combat prayer behavior in engine:
  - 40% protection reduction kept for PvP.
  - Legacy deflect prayers normalized to protect prayers.
  - Added piety/rigour/augury offensive prayer effects.
- Added tests:
  - `engine-prayer.test.ts` for protection/legacy deflect mapping/offensive prayer.
  - `progression.test.ts` for XP defaults and combat XP attribution.
  - `world.test.ts` for node tiers, level gates, depletion/respawn.

## 2026-02-18 (Implementation pass: tick pacing + portals + spellbook + runecrafting)
- Added server-authoritative duel tick pacing:
  - New fight metadata: `tick_window_ms` and `next_tick_at`.
  - Configurable defaults via `DUEL_TICK_MS` (default 600ms) and `ACTION_TIMEOUT_MS` (default 1600ms).
  - Tick resolution now schedules to `next_tick_at` and auto-submits missing actions as `none` after timeout.
- Added world topology and area sharding foundations:
  - New area/portal definitions in `src/world.ts`.
  - Added shared and personal-scope portal routing support (`/api/v1/world/portal/use` with `portal_id`).
  - Added world metadata endpoints: `/api/v1/world/areas`, `/api/v1/world/portals`.
  - World presence and nodes now support shard context (`area_id`, `instance_id`).
- Added magic spellbook + runecrafting loop:
  - Added `runecrafting` progression defaults and runecrafting resource nodes (air/mind/nature/law altars in Runecraft Nexus).
  - Added spellbook APIs: `/api/v1/world/spellbook/:agent_id` and `/api/v1/world/spell/cast`.
  - Teleport spells now consume runes, award magic XP, and move agents across areas.
- Persistence updates:
  - Resource nodes now persist `area_id` and `instance_id` in Postgres schema/repository.
- Side-scroller updates (`public/game.html`):
  - Added area-aware rendering/shard state (`player.area_id`, `player.instance_id`).
  - Added non-linear portal network (surface, nexus, wilderness depths, shadow dungeon, quest shard).
  - Added spellbook overlay (`B`) and cast flow.
  - Added portal interaction flow with server portal API.
  - Added return-to-world-position behavior after arena fights.
- Tests expanded:
  - progression test for runecrafting default + inventory consumption helper.
  - world test for runecrafting altar presence and portal topology/scope.

### Validation run
- `bun run lint` -> PASS
- `bun test` -> PASS (14 tests)
- Server boot smoke -> PASS
- Browser smoke (`/game.html`) -> PASS, no console errors

### Next TODOs
- Add dedicated server-side duel instance scoping for arena fights (currently world sharding is in place, but fight spectators still subscribe by fight id).
- Add quest-specific resource nodes with non-null `instance_id` to fully exercise personal-instance skilling.
- Add Playwright e2e for: portal travel -> runecrafting -> spell teleport -> profile persistence.
