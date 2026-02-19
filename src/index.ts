import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import api from "./routes";
import {
  duelQueueSubscribers,
  duelQueue,
  fightSubscribers,
  getVisibleWorldAgents,
  getResourceNodes,
  removeWorldAgent,
  type SocketLike,
  skillSubscribers,
  upsertWorldAgent,
  worldAgents,
  worldSubscribers,
} from "./store";
import type { CombatClass } from "./types";

const app = new Hono();

function isCombatClass(value: unknown): value is CombatClass {
  return value === "melee" || value === "ranged" || value === "magic";
}

function getSocketData(ws: SocketLike): Record<string, unknown> {
  const socket = ws as SocketLike & { data?: Record<string, unknown> };
  if (!socket.data) socket.data = {};
  return socket.data;
}

function normalizeAreaId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "surface_main";
}

function normalizeInstanceId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getShardNodes(areaId: string, instanceId: string | null) {
  return getResourceNodes().filter(
    (node) => node.area_id === areaId && (node.instance_id ?? null) === instanceId
  );
}

function broadcastWorld(payload: unknown, except?: SocketLike) {
  const candidate = payload as {
    area_id?: unknown;
    instance_id?: unknown;
    agent?: { area_id?: unknown; instance_id?: unknown };
  };
  const areaId = normalizeAreaId(candidate.agent?.area_id ?? candidate.area_id);
  const instanceId = normalizeInstanceId(candidate.agent?.instance_id ?? candidate.instance_id);

  const msg = JSON.stringify(payload);
  for (const ws of worldSubscribers) {
    if (except && ws === except) continue;
    const socketData = getSocketData(ws);
    const wsAreaId = normalizeAreaId(socketData.world_area_id);
    const wsInstanceId = normalizeInstanceId(socketData.world_instance_id);
    if (wsAreaId !== areaId || wsInstanceId !== instanceId) continue;
    try {
      ws.send(msg);
    } catch {}
  }
}

function subscribeSkillEvents(ws: SocketLike, agentId: string) {
  if (!skillSubscribers.has(agentId)) {
    skillSubscribers.set(agentId, new Set());
  }
  skillSubscribers.get(agentId)?.add(ws);
  const data = getSocketData(ws);
  data.skill_agent_id = agentId;
}

function removeSkillSubscription(ws: SocketLike) {
  const data = getSocketData(ws);
  const agentId = data.skill_agent_id;
  if (typeof agentId !== "string") return;
  const set = skillSubscribers.get(agentId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    skillSubscribers.delete(agentId);
  }
}

// CORS
app.use("*", cors());

// API routes
app.route("/api/v1", api);

// Static files (frontend)
app.use("/*", serveStatic({ root: "./public" }));

// Start server with WebSocket support
const port = parseInt(process.env.PORT || "3000", 10);

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket: {
    open(ws) {
      const data = getSocketData(ws);
      data.world_agent_id = null;
      data.world_area_id = "surface_main";
      data.world_instance_id = null;
      data.skill_agent_id = null;
      (ws as SocketLike & { data?: Record<string, unknown> }).data = {
        world_agent_id: null,
        world_area_id: "surface_main",
        world_instance_id: null,
        skill_agent_id: null,
      };
    },
    async message(ws, msg) {
      try {
        const data = JSON.parse(msg as string);

        if (data.type === "spectate" && data.fight_id) {
          const fightId = data.fight_id;
          if (!fightSubscribers.has(fightId)) {
            fightSubscribers.set(fightId, new Set());
          }
          fightSubscribers.get(fightId)?.add(ws);
          ws.send(JSON.stringify({ type: "subscribed", fight_id: fightId }));
        }

        if (data.type === "world_subscribe") {
          const areaId = normalizeAreaId(data.area_id);
          const instanceId = normalizeInstanceId(data.instance_id);
          const socketData = getSocketData(ws);
          socketData.world_area_id = areaId;
          socketData.world_instance_id = instanceId;
          worldSubscribers.add(ws);
          ws.send(JSON.stringify({
            type: "world_state",
            area_id: areaId,
            instance_id: instanceId,
            agents: getVisibleWorldAgents(areaId, instanceId),
            nodes: getShardNodes(areaId, instanceId),
          }));
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
            area_id: normalizeAreaId(data.area_id),
            instance_id: normalizeInstanceId(data.instance_id),
          });

          worldSubscribers.add(ws);
          const socketData = getSocketData(ws);
          socketData.world_agent_id = data.agent_id;
          socketData.world_area_id = state.area_id ?? "surface_main";
          socketData.world_instance_id = state.instance_id ?? null;

          broadcastWorld({ type: "world_update", agent: state });
        }

        if (data.type === "world_leave" && typeof data.agent_id === "string") {
          const leaving = worldAgents.get(data.agent_id);
          if (removeWorldAgent(data.agent_id)) {
            broadcastWorld({
              type: "world_leave",
              agent_id: data.agent_id,
              area_id: leaving?.area_id ?? "surface_main",
              instance_id: leaving?.instance_id ?? null,
            }, ws);
          }
        }

        if (data.type === "duel_queue_subscribe") {
          duelQueueSubscribers.add(ws);
          ws.send(JSON.stringify({ type: "duel_queue_update", queue: [...duelQueue.values()] }));
        }

        if (data.type === "skill_subscribe" && typeof data.agent_id === "string") {
          subscribeSkillEvents(ws, data.agent_id);
          ws.send(JSON.stringify({ type: "skill_subscribed", agent_id: data.agent_id }));
        }

        if ((data.type === "world_interact_start" || data.type === "world_interact_stop") && typeof data.agent_id === "string" && typeof data.node_id === "string") {
          const action = data.type === "world_interact_start" ? "start" : "stop";
          const req = new Request(`http://127.0.0.1:${port}/api/v1/world/interact`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent_id: data.agent_id,
              node_id: data.node_id,
              action,
            }),
          });
          const res = await app.fetch(req);
          const payload = await res.json();
          ws.send(JSON.stringify({ type: "world_interact_result", ok: res.ok, payload }));
        }
      } catch {}
    },
    close(ws) {
      // Remove from all subscriber sets
      for (const [, subs] of fightSubscribers) {
        subs.delete(ws);
      }
      worldSubscribers.delete(ws);
      duelQueueSubscribers.delete(ws);
      removeSkillSubscription(ws);

      // If a socket was representing an active world agent, clean it up.
      const worldAgentId = getSocketData(ws).world_agent_id;
      if (typeof worldAgentId === "string") {
        const leaving = worldAgents.get(worldAgentId);
        if (removeWorldAgent(worldAgentId)) {
          broadcastWorld({
            type: "world_leave",
            agent_id: worldAgentId,
            area_id: leaving?.area_id ?? "surface_main",
            instance_id: leaving?.instance_id ?? null,
          });
        }
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
