import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import api from "./routes";
import { fightSubscribers, worldSubscribers, getActiveWorldAgents, upsertWorldAgent, removeWorldAgent } from "./store";
import type { CombatClass } from "./types";

const app = new Hono();

function isCombatClass(value: unknown): value is CombatClass {
  return value === "melee" || value === "ranged" || value === "magic";
}

function broadcastWorld(payload: unknown, except?: any) {
  const msg = JSON.stringify(payload);
  for (const ws of worldSubscribers) {
    if (except && ws === except) continue;
    try {
      ws.send(msg);
    } catch {}
  }
}

// CORS
app.use("*", cors());

// API routes
app.route("/api/v1", api);

// Static files (frontend)
app.use("/*", serveStatic({ root: "./public" }));

// Start server with WebSocket support
const port = parseInt(process.env.PORT || "3000");

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket: {
    open(ws) {
      // @ts-ignore - runtime WebSocket data payload
      ws.data = {
        world_agent_id: null,
      };
    },
    message(ws, msg) {
      try {
        const data = JSON.parse(msg as string);

        if (data.type === "spectate" && data.fight_id) {
          const fightId = data.fight_id;
          if (!fightSubscribers.has(fightId)) {
            fightSubscribers.set(fightId, new Set());
          }
          fightSubscribers.get(fightId)!.add(ws);
          ws.send(JSON.stringify({ type: "subscribed", fight_id: fightId }));
        }

        if (data.type === "world_subscribe") {
          worldSubscribers.add(ws);
          ws.send(JSON.stringify({ type: "world_state", agents: getActiveWorldAgents() }));
        }

        if (data.type === "world_update") {
          if (
            typeof data.agent_id !== "string" ||
            typeof data.x !== "number" ||
            typeof data.y !== "number"
          ) {
            ws.send(JSON.stringify({ type: "error", message: "world_update requires agent_id, x, y" }));
            return;
          }

          const state = upsertWorldAgent({
            agent_id: data.agent_id,
            combat_class: isCombatClass(data.combat_class) ? data.combat_class : "melee",
            x: data.x,
            y: data.y,
            zone: typeof data.zone === "string" ? data.zone : "Unknown",
          });

          worldSubscribers.add(ws);
          // @ts-ignore - runtime data payload
          ws.data.world_agent_id = data.agent_id;

          broadcastWorld({ type: "world_update", agent: state });
        }

        if (data.type === "world_leave" && typeof data.agent_id === "string") {
          if (removeWorldAgent(data.agent_id)) {
            broadcastWorld({ type: "world_leave", agent_id: data.agent_id }, ws);
          }
        }
      } catch {}
    },
    close(ws) {
      // Remove from all subscriber sets
      for (const [, subs] of fightSubscribers) {
        subs.delete(ws);
      }
      worldSubscribers.delete(ws);

      // If a socket was representing an active world agent, clean it up.
      // @ts-ignore - runtime data payload
      const worldAgentId = ws.data?.world_agent_id;
      if (typeof worldAgentId === "string" && removeWorldAgent(worldAgentId)) {
        broadcastWorld({ type: "world_leave", agent_id: worldAgentId });
      }
    },
  },
});

// Upgrade WebSocket requests
app.get("/ws/arena", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade request", 426);
  }

  const upgraded = server.upgrade(c.req.raw);
  if (!upgraded) {
    return c.text("WebSocket upgrade failed", 400);
  }
  return new Response(null);
});

console.log(`⚔️  RuneScape Agent Arena running on http://localhost:${port}`);
console.log(`📡 WebSocket at ws://localhost:${port}/ws/arena`);
console.log(`📋 API at http://localhost:${port}/api/v1`);
