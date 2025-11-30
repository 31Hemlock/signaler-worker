// Single-room WebRTC signaling server for Cloudflare Workers.
// Exactly one host, many clients (controllers) at once.
// Host and clients exchange SDP/ICE for WebRTC via this signaler.

let host = null; // WebSocket | null
const clients = new Map(); // clientId -> WebSocket

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          hostConnected: !!host,
          clients: Array.from(clients.keys()),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (
      url.pathname === "/ws" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      return handleWebSocket(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

function handleWebSocket(request) {
  const upgradeHeader = request.headers.get("Upgrade") || "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const ws = server;

  ws.accept();

  const meta = {
    role: null, // "host" | "client"
    clientId: null, // string for clients, null for host
  };

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return;
    }

    switch (msg.type) {
      case "register-host":
        handleRegisterHost(ws, meta);
        break;

      case "client-hello":
        handleClientHello(ws, meta);
        break;

      case "offer":
      case "answer":
      case "ice-candidate":
        handleSignal(ws, meta, msg);
        break;

      default:
        // ignore unknown types for now
        break;
    }
  });

  const cleanup = () => {
    if (meta.role === "host") {
      if (host === ws) {
        host = null;
        // notify all clients that host disappeared
        for (const [id, cws] of clients.entries()) {
          safeSend(
            cws,
            JSON.stringify({
              type: "host-disconnected",
            })
          );
        }
      }
    } else if (meta.role === "client" && meta.clientId) {
      const existing = clients.get(meta.clientId);
      if (existing === ws) {
        clients.delete(meta.clientId);
        // notify host if present
        if (host) {
          safeSend(
            host,
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
    webSocket: client,
  });
}

function handleRegisterHost(ws, meta) {
  meta.role = "host";
  meta.clientId = null;

  if (host && host !== ws) {
    // Kick existing host
    safeSend(host, JSON.stringify({ type: "error", error: "host-replaced" }));
    try {
      host.close(1011, "host replaced");
    } catch {}
  }

  host = ws;

  // Tell new host which clients currently exist
  safeSend(
    ws,
    JSON.stringify({
      type: "host-registered",
      clients: Array.from(clients.keys()),
    })
  );
}

function handleClientHello(ws, meta) {
  if (meta.role && meta.role !== "client") {
    // Already a host, ignore.
    return;
  }

  // Assign id
  const clientId = generateClientId();
  meta.role = "client";
  meta.clientId = clientId;

  // If an existing socket somehow had same id, drop it
  const existing = clients.get(clientId);
  if (existing && existing !== ws) {
    safeSend(
      existing,
      JSON.stringify({ type: "error", error: "client-replaced" })
    );
    try {
      existing.close(1011, "client id replaced");
    } catch {}
  }

  clients.set(clientId, ws);

  // Tell client its id and whether host is present
  safeSend(
    ws,
    JSON.stringify({
      type: "client-welcome",
      clientId,
      hasHost: !!host,
    })
  );

  // Notify host, if present
  if (host) {
    safeSend(
      host,
      JSON.stringify({
        type: "client-connected",
        clientId,
      })
    );
  }
}

function handleSignal(ws, meta, msg) {
  if (!meta.role) {
    safeSend(ws, JSON.stringify({ type: "error", error: "not-registered" }));
    return;
  }

  if (meta.role === "client") {
    if (!host) {
      // host not connected; we could send an error back
      safeSend(ws, JSON.stringify({ type: "error", error: "no-host" }));
      return;
    }

    const clientId = meta.clientId;
    if (!clientId) return;

    // Forward to host
    const forwarded = {
      ...msg,
      clientId,
      from: "client",
    };
    safeSend(host, JSON.stringify(forwarded));
  } else if (meta.role === "host") {
    const clientId = String(msg.clientId || "").trim();
    if (!clientId) {
      safeSend(
        ws,
        JSON.stringify({ type: "error", error: "missing-clientId" })
      );
      return;
    }

    const target = clients.get(clientId);
    if (!target) {
      // client may have disconnected
      safeSend(ws, JSON.stringify({ type: "error", error: "unknown-client" }));
      return;
    }

    const forwarded = {
      ...msg,
      clientId,
      from: "host",
    };
    safeSend(target, JSON.stringify(forwarded));
  }
}

function safeSend(ws, data) {
  try {
    ws.send(data);
  } catch {
    // ignore send errors
  }
}

function generateClientId() {
  // Simple random id, good enough for your use-case.
  return Math.random().toString(36).slice(2, 10);
}
