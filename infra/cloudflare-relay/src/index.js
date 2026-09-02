import { DurableObject } from "cloudflare:workers";
import { appendHeaderPairs, sanitizeResponseHeaderPairs } from "./protocol.mjs";
import { isNullBodyResponse, requestToBridgeFrame } from "./worker-protocol.mjs";
import { MAX_REQUEST_BODY_BYTES, RESPONSE_START_TIMEOUT_MS } from "./limits.mjs";

const BRIDGE_PATH = "/__relay/ws";
const HEALTH_PATH = "/__relay/health";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function openSocket(socket) {
  return socket?.readyState === 1;
}

async function secureEqual(a, b) {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b)))
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function decodeBase64(value) {
  const binary = atob(value || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function responseHeaders(pairs) {
  return appendHeaderPairs(new Headers(), sanitizeResponseHeaderPairs(pairs));
}

export class DriveRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
  }

  bridgeSocket() {
    return this.ctx.getWebSockets("bridge").filter(openSocket).at(-1);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === BRIDGE_PATH) return this.acceptBridge(request);
    if (url.pathname === HEALTH_PATH && request.method === "GET") {
      return json({ status: this.bridgeSocket() ? "ready" : "degraded", bridge_connected: Boolean(this.bridgeSocket()) }, this.bridgeSocket() ? 200 : 503);
    }
    return this.forward(request);
  }

  async acceptBridge(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const supplied = request.headers.get("x-drive-relay-key") || "";
    const expected = this.env.DRIVE_RELAY_KEY || "";
    if (!(await secureEqual(supplied, expected))) {
      return new Response("Unauthorized", { status: 401 });
    }

    for (const socket of this.ctx.getWebSockets("bridge")) {
      try { socket.close(4001, "Replaced by a newer bridge connection"); } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role: "bridge", connectedAt: new Date().toISOString() });
    this.ctx.acceptWebSocket(server, ["bridge"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async forward(request) {
    const socket = this.bridgeSocket();
    if (!socket) return json({ error: "LOCAL_BRIDGE_UNAVAILABLE", retryable: true }, 503);

    const id = crypto.randomUUID();
    let frame;
    try {
      frame = await requestToBridgeFrame(request, { id, maxBodyBytes: MAX_REQUEST_BODY_BYTES });
    } catch (error) {
      return json({ error: "REQUEST_TOO_LARGE", message: error instanceof Error ? error.message : "Invalid request" }, 413);
    }

    let resolveStart;
    const startPromise = new Promise((resolve) => { resolveStart = resolve; });
    const pending = {
      id,
      method: request.method,
      socket,
      resolveStart,
      started: false,
      controller: null,
      buffered: [],
      ended: false,
      streamError: null,
      timer: null
    };
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      pending.resolveStart({ error: "LOCAL_RESPONSE_TIMEOUT", status: 504 });
      try { socket.send(JSON.stringify({ type: "request_cancel", id })); } catch {}
    }, RESPONSE_START_TIMEOUT_MS);
    this.pending.set(id, pending);

    try {
      socket.send(JSON.stringify(frame));
    } catch {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      return json({ error: "LOCAL_BRIDGE_UNAVAILABLE", retryable: true }, 503);
    }

    const start = await startPromise;
    if (start.error) return json({ error: start.error, retryable: true }, start.status || 502);

    const headers = responseHeaders(start.headers || []);
    if (isNullBodyResponse(request.method, start.status)) {
      this.pending.delete(id);
      return new Response(null, { status: start.status, headers });
    }

    const stream = new ReadableStream({
      start: (controller) => {
        pending.controller = controller;
        for (const chunk of pending.buffered) controller.enqueue(chunk);
        pending.buffered.length = 0;
        if (pending.streamError) {
          controller.error(new Error(pending.streamError));
          this.pending.delete(id);
        } else if (pending.ended) {
          controller.close();
          this.pending.delete(id);
        }
      },
      cancel: () => {
        this.pending.delete(id);
        try { socket.send(JSON.stringify({ type: "request_cancel", id })); } catch {}
      }
    });
    return new Response(stream, { status: start.status, headers });
  }

  webSocketMessage(socket, message) {
    if (socket.deserializeAttachment?.()?.role !== "bridge" || typeof message !== "string" || message.length > 1024 * 1024) return;
    let frame;
    try { frame = JSON.parse(message); } catch { return; }
    if (!frame || typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending || pending.socket !== socket) return;

    if (frame.type === "response_start") {
      if (pending.started || !Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599) return;
      pending.started = true;
      clearTimeout(pending.timer);
      pending.resolveStart({ status: frame.status, headers: Array.isArray(frame.headers) ? frame.headers : [] });
      return;
    }

    if (frame.type === "response_chunk" && pending.started && typeof frame.dataBase64 === "string") {
      let bytes;
      try { bytes = decodeBase64(frame.dataBase64); } catch { return; }
      if (pending.controller) pending.controller.enqueue(bytes);
      else pending.buffered.push(bytes);
      return;
    }

    if (frame.type === "response_end" && pending.started) {
      pending.ended = true;
      if (pending.controller) {
        pending.controller.close();
        this.pending.delete(frame.id);
      }
      return;
    }

    if (frame.type === "response_error") {
      clearTimeout(pending.timer);
      if (!pending.started) {
        this.pending.delete(frame.id);
        pending.resolveStart({ error: "LOCAL_ORIGIN_ERROR", status: Number.isInteger(frame.status) ? frame.status : 502 });
      } else {
        pending.streamError = "Local origin stream failed";
        if (pending.controller) {
          pending.controller.error(new Error(pending.streamError));
          this.pending.delete(frame.id);
        }
      }
    }
  }

  webSocketClose(socket) {
    this.failSocketPending(socket);
  }

  webSocketError(socket) {
    this.failSocketPending(socket);
    try { socket.close(1011, "Bridge error"); } catch {}
  }

  failSocketPending(socket) {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (!pending.started) pending.resolveStart({ error: "LOCAL_BRIDGE_UNAVAILABLE", status: 503 });
      else if (pending.controller) pending.controller.error(new Error("Local bridge disconnected"));
      else pending.streamError = "Local bridge disconnected";
    }
  }
}

export default {
  async fetch(request, env) {
    const id = env.DRIVE_RELAY.idFromName("primary");
    return env.DRIVE_RELAY.get(id).fetch(request);
  }
};
