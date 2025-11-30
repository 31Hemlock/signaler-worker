// index.js
// Single-room WebRTC signaling server using a Cloudflare Durable Object.
//
// External API (same as before):
//   - GET  /health       -> { ok, hostConnected, clients: string[] }
//   - WS   /ws           -> WebSocket signaling
//
// Top-level Worker just forwards all requests to the single RoomDO instance.
// The Durable Object holds the host + clients maps and does all the routing.

export default {
  async fetch(request, env, ctx) {
    // Always talk to the SAME room instance (single room forever).
    const id = env.ROOM.idFromName("only-room");
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

// Durable Object class: one instance per "only-room".
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {WebSocket | null} */
    this.host = null;

    /** @type {Map<string, WebSocket>} */
    this.clients = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Health endpoint
    if (url.pathname === "/health" && request.method === "GET") {
      const body = JSON.stringify({
        ok: true,
        hostConnected: !!this.host,
        clients: Array.from(this.clients.keys()),
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // WebSocket endpoint
    if (
      url.pathname === "/ws" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      return this.handleWebSocket(request);
    }

    return new Response("Not found", { status: 404 });
  }

  handleWebSocket(request) {
    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const ws = server;

    ws.accept();

    /** @type {{ role: "host" | "client" | null, clientId: string | null }} */
    const meta = {
      role: null,
      clientId: null,
    };

    ws.addEventListener("message", (event) => {
      let text;
      try {
        if (typeof event.data === "string") {
          text = event.data;
        } else {
          text = new TextDecoder().decode(event.data);
        }
      } catch {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(text);
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
          // ignore unknown types
          break;
      }
    });

    const cleanup = () => {
      // Host went away
      if (meta.role === "host") {
        if (this.host === ws) {
          this.host = null;
          // notify all clients that host disappeared
          for (const [, cws] of this.clients.entries()) {
            this.safeSend(
              cws,
              JSON.stringify({
                type: "host-disconnected",
              })
            );
          }
        }
      }
      // Client went away
      else if (meta.role === "client" && meta.clientId) {
        const existing = this.clients.get(meta.clientId);
        if (existing === ws) {
          this.clients.delete(meta.clientId);
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

    return new Response(null, { status: 101, webSocket: client });
  }

  handleRegisterHost(ws, meta) {
    meta.role = "host";
    meta.clientId = null;

    // If another host existed, kick it.
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
      // If this socket already registered as host, ignore.
      return;
    }

    const clientId = this.generateClientId();
    meta.role = "client";
    meta.clientId = clientId;

    // If an existing socket somehow had same id, drop it.
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

    // Tell client its id and whether host is present
    this.safeSend(
      ws,
      JSON.stringify({
        type: "client-welcome",
        clientId,
        hasHost: !!this.host,
      })
    );

    // Notify host, if present
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
      // Client -> Host
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
      // Host -> specific client
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
    // Simple random id is fine for this use-case.
    return Math.random().toString(36).slice(2, 10);
  }
}
