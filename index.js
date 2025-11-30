// index.js
// Durable Object–backed single-room WebRTC signaler.
//
// Architecture:
//   Browser client  <->  (WSS) Worker  <->  Durable Object "RoomDO"
//   Host (Node)     <->  (WSS) Worker  <->  Durable Object "RoomDO"
//
// The Durable Object holds:
//   - at most one "host" WebSocket
//   - many "client" WebSockets
// and forwards:
//   - offer/answer/ice-candidate between host and a given clientId
//   - client-connected / client-disconnected / host-disconnected notifications
//
// Endpoints:
//   GET /health     -> JSON { ok, hostConnected, clients }
//   GET /ws (WS)    -> WebSocket; first message must be
//                        { type: "register-host" }
//                        or
//                        { type: "client-hello" }
//
// NOTE: This script expects a Durable Object binding named `ROOM`
//       to be configured in Cloudflare. See comment at bottom.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Ask the Durable Object for its current state.
      const id = env.ROOM.idFromName("singleton-room");
      const stub = env.ROOM.get(id);
      const res = await stub.fetch("https://dummy.internal/health");
      return res;
    }

    if (
      url.pathname === "/ws" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      // Route WebSocket upgrade into our single room DO.
      const id = env.ROOM.idFromName("singleton-room");
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// -------- Durable Object: RoomDO --------

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {WebSocket|null} */
    this.host = null;

    /** @type {Map<string, WebSocket>} */
    this.clients = new Map();

    // Optional: an instance id for logging/debugging.
    this.instanceId = Math.random().toString(36).slice(2, 8);
  }

  /**
   * DO.fetch is used in two ways:
   *   - HTTP GET /health        -> JSON with host/client info
   *   - WebSocket upgrade /ws   -> attach a socket to this room
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return this.handleHealth();
    }

    if (
      url.pathname === "/ws" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      return this.handleWebSocket(request);
    }

    return new Response("Not found (DO)", { status: 404 });
  }

  async handleHealth() {
    const body = JSON.stringify({
      ok: true,
      instanceId: this.instanceId,
      hostConnected: !!this.host,
      clients: Array.from(this.clients.keys()),
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  handleWebSocket(request) {
    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [clientSide, serverSide] = Object.values(pair);
    const ws = serverSide;

    ws.accept();

    const meta = {
      role: null, // "host" | "client"
      clientId: null, // string for clients, null for host
    };

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        // event.data can be string or ArrayBuffer; Cloudflare
        // guarantees text frames come as strings.
        msg = typeof event.data === "string" ? JSON.parse(event.data) : null;
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        return;
      }

      switch (msg.type) {
        case "register-host":
          this.handleRegisterHost(ws, meta);
          break;

        case "client-hello":
          this.handleClientHello(ws, meta);
          break;

        case "offer":
        case "answer":
        case "ice-candidate":
          this.handleSignal(ws, meta, msg);
          break;

        default:
          // ignore unknown
          break;
      }
    });

    const cleanup = () => {
      if (meta.role === "host") {
        if (this.host === ws) {
          this.host = null;
          // notify all clients that host disappeared
          for (const [id, cws] of this.clients.entries()) {
            this.safeSend(
              cws,
              JSON.stringify({
                type: "host-disconnected",
              })
            );
          }
        }
      } else if (meta.role === "client" && meta.clientId) {
        const existing = this.clients.get(meta.clientId);
        if (existing === ws) {
          this.clients.delete(meta.clientId);
          // notify host if present
          if (this.host) {
            this.safeSend(
              this.host,
              JSON.stringify({
                type: "client-disconnected",
                clientId: meta.clientId,
              })
            );
          }
        }
      }
    };

    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);

    return new Response(null, {
      status: 101,
      webSocket: clientSide,
    });
  }

  handleRegisterHost(ws, meta) {
    meta.role = "host";
    meta.clientId = null;

    if (this.host && this.host !== ws) {
      this.safeSend(
        this.host,
        JSON.stringify({ type: "error", error: "host-replaced" })
      );
      try {
        this.host.close(1011, "host replaced");
      } catch {}
    }

    this.host = ws;

    // Tell new host which clients currently exist
    this.safeSend(
      ws,
      JSON.stringify({
        type: "host-registered",
        clients: Array.from(this.clients.keys()),
      })
    );
  }

  handleClientHello(ws, meta) {
    if (meta.role && meta.role !== "client") {
      // This socket is already the host; ignore.
      return;
    }

    const clientId = this.generateClientId();
    meta.role = "client";
    meta.clientId = clientId;

    const existing = this.clients.get(clientId);
    if (existing && existing !== ws) {
      this.safeSend(
        existing,
        JSON.stringify({ type: "error", error: "client-replaced" })
      );
      try {
        existing.close(1011, "client id replaced");
      } catch {}
    }

    this.clients.set(clientId, ws);

    this.safeSend(
      ws,
      JSON.stringify({
        type: "client-welcome",
        clientId,
        hasHost: !!this.host,
      })
    );

    if (this.host) {
      this.safeSend(
        this.host,
        JSON.stringify({
          type: "client-connected",
          clientId,
        })
      );
    }
  }

  handleSignal(ws, meta, msg) {
    if (!meta.role) {
      this.safeSend(
        ws,
        JSON.stringify({ type: "error", error: "not-registered" })
      );
      return;
    }

    if (meta.role === "client") {
      if (!this.host) {
        this.safeSend(ws, JSON.stringify({ type: "error", error: "no-host" }));
        return;
      }

      const clientId = meta.clientId;
      if (!clientId) return;

      const forwarded = {
        ...msg,
        clientId,
        from: "client",
      };
      this.safeSend(this.host, JSON.stringify(forwarded));
    } else if (meta.role === "host") {
      const clientId = String(msg.clientId || "").trim();
      if (!clientId) {
        this.safeSend(
          ws,
          JSON.stringify({ type: "error", error: "missing-clientId" })
        );
        return;
      }

      const target = this.clients.get(clientId);
      if (!target) {
        this.safeSend(
          ws,
          JSON.stringify({ type: "error", error: "unknown-client" })
        );
        return;
      }

      const forwarded = {
        ...msg,
        clientId,
        from: "host",
      };
      this.safeSend(target, JSON.stringify(forwarded));
    }
  }

  safeSend(ws, data) {
    try {
      ws.send(data);
    } catch {
      // ignore send errors
    }
  }

  generateClientId() {
    return Math.random().toString(36).slice(2, 10);
  }
}
