import WebSocket from "ws";
import { forwardBridgeRequest } from "./bridge-client.mjs";
import { MAX_BRIDGE_MESSAGE_BYTES } from "./limits.mjs";

const relayUrl = process.env.DRIVE_RELAY_URL || "";
const relayKey = process.env.DRIVE_RELAY_KEY || "";
const localOrigin = process.env.DRIVE_RELAY_LOCAL_ORIGIN || "http://127.0.0.1:3100";
const logLevel = process.env.DRIVE_RELAY_LOG_LEVEL || "info";

function safeLog(level, message) {
  if (logLevel === "error" && level !== "error") return;
  const method = level === "error" ? console.error : console.log;
  method(`[drive-relay] ${message}`);
}

function validateConfig() {
  if (!relayKey || relayKey.length < 32) throw new Error("DRIVE_RELAY_KEY must contain at least 32 characters");
  const remote = new URL(relayUrl);
  const local = new URL(localOrigin);
  const loopbackRemote = (remote.hostname === "127.0.0.1" || remote.hostname === "localhost" || remote.hostname === "::1");
  if (remote.protocol !== "wss:" && !(remote.protocol === "ws:" && loopbackRemote)) throw new Error("DRIVE_RELAY_URL must use wss:// except for loopback tests");
  if (local.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(local.hostname)) throw new Error("DRIVE_RELAY_LOCAL_ORIGIN must be loopback http://");
}

validateConfig();
let stopping = false;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1_000;
let heartbeatTimer = null;
let heartbeatDeadline = null;
const active = new Map();

function clearHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (heartbeatDeadline) clearTimeout(heartbeatDeadline);
  heartbeatTimer = null;
  heartbeatDeadline = null;
}

function abortAll() {
  for (const controller of active.values()) controller.abort();
  active.clear();
}

function scheduleHeartbeat(ws) {
  clearHeartbeat();
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    if (stopping || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.ping(); } catch { return ws.terminate(); }
    heartbeatDeadline = setTimeout(() => {
      heartbeatDeadline = null;
      if (!stopping && socket === ws) ws.terminate();
    }, 10_000);
  }, 20_000);
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const wait = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function sendFrame(ws, frame) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function connect() {
  if (stopping) return;
  const ws = new WebSocket(relayUrl, {
    headers: { "X-Drive-Relay-Key": relayKey },
    maxPayload: MAX_BRIDGE_MESSAGE_BYTES
  });
  socket = ws;

  ws.on("open", () => {
    if (socket !== ws || stopping) return;
    reconnectDelay = 1_000;
    safeLog("info", "connected");
    scheduleHeartbeat(ws);
  });
  ws.on("pong", () => {
    if (socket !== ws || stopping) return;
    scheduleHeartbeat(ws);
  });
  ws.on("message", (data, binary) => {
    if (binary || socket !== ws || stopping || data.length > MAX_BRIDGE_MESSAGE_BYTES) return;
    let frame;
    try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!frame || typeof frame.id !== "string") return;
    if (frame.type === "request_cancel") {
      active.get(frame.id)?.abort();
      active.delete(frame.id);
      return;
    }
    if (frame.type !== "request" || active.has(frame.id)) return;

    const controller = new AbortController();
    active.set(frame.id, controller);
    forwardBridgeRequest(frame, {
      localOrigin,
      signal: controller.signal,
      send: (reply) => sendFrame(ws, reply)
    }).finally(() => active.delete(frame.id));
  });
  ws.on("close", () => {
    if (socket !== ws) return;
    socket = null;
    clearHeartbeat();
    abortAll();
    if (!stopping) safeLog("info", "disconnected; reconnect scheduled");
    scheduleReconnect();
  });
  ws.on("error", () => {
    if (socket === ws) ws.terminate();
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearHeartbeat();
  abortAll();
  const ws = socket;
  socket = null;
  try { ws?.close(1000, "Bridge stopping"); } catch {}
}

process.once("SIGINT", () => { stop(); process.exit(0); });
process.once("SIGTERM", () => { stop(); process.exit(0); });
connect();
