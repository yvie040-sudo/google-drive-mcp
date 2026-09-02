import { buildForwardedRequestHeaders } from "./protocol.mjs";

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export async function requestToBridgeFrame(request, { id, maxBodyBytes = 4 * 1024 * 1024 } = {}) {
  if (!id) throw new Error("Relay request id is required");
  const url = new URL(request.url);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new Error(`Relay request body is too large (${contentLength} > ${maxBodyBytes})`);
  }

  let bodyBase64 = "";
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > maxBodyBytes) {
      throw new Error(`Relay request body is too large (${body.byteLength} > ${maxBodyBytes})`);
    }
    if (body.byteLength) bodyBase64 = bytesToBase64(body);
  }

  const headers = buildForwardedRequestHeaders([...request.headers.entries()], {
    clientIp: request.headers.get("cf-connecting-ip") || "",
    publicUrl: request.url
  });

  return {
    type: "request",
    id,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: [...headers.entries()],
    bodyBase64
  };
}

export function isNullBodyResponse(method, status) {
  if (String(method).toUpperCase() === "HEAD") return true;
  return status === 101 || status === 204 || status === 205 || status === 304;
}
