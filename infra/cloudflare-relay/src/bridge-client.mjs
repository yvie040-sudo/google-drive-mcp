import { responseHeaderPairs } from "./protocol.mjs";

const MAX_FRAME_CHUNK_BYTES = 48 * 1024;

function requestHeaders(entries) {
  const headers = new Headers();
  for (const [rawName, rawValue] of entries || []) {
    const name = String(rawName || "").toLowerCase();
    if (!name || name === "host" || name === "content-length" || name === "connection" || name === "transfer-encoding") continue;
    headers.append(name, String(rawValue));
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function bodyFromBase64(message) {
  if (!message.bodyBase64 || message.method === "GET" || message.method === "HEAD") return undefined;
  return Buffer.from(message.bodyBase64, "base64");
}

function sendChunked(send, id, chunk) {
  const bytes = Buffer.from(chunk);
  for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_CHUNK_BYTES) {
    send({
      type: "response_chunk",
      id,
      dataBase64: bytes.subarray(offset, offset + MAX_FRAME_CHUNK_BYTES).toString("base64")
    });
  }
}

export async function forwardBridgeRequest(message, { localOrigin = "http://127.0.0.1:3100", send, fetchImpl = fetch, signal } = {}) {
  if (!message || message.type !== "request" || typeof message.id !== "string") {
    throw new Error("Invalid relay request frame");
  }
  if (typeof send !== "function") throw new Error("send callback is required");

  const target = new URL(message.path || "/", localOrigin);
  if (target.origin !== new URL(localOrigin).origin) throw new Error("Relay path escaped local origin");

  try {
    const response = await fetchImpl(target, {
      method: message.method || "GET",
      headers: requestHeaders(message.headers),
      body: bodyFromBase64(message),
      redirect: "manual",
      signal
    });

    send({
      type: "response_start",
      id: message.id,
      status: response.status,
      headers: responseHeaderPairs(response)
    });

    if (response.body && message.method !== "HEAD") {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) sendChunked(send, message.id, value);
      }
    }
    send({ type: "response_end", id: message.id });
  } catch (error) {
    send({
      type: "response_error",
      id: message.id,
      status: 502,
      message: error instanceof Error ? error.message : "Local origin request failed"
    });
  }
}
