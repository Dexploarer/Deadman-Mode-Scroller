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
