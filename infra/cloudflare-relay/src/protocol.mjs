const REQUEST_BLOCKED = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "forwarded", "via"
]);

const RESPONSE_BLOCKED = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "content-encoding"
]);

function normalizedName(name) {
  return String(name || "").trim().toLowerCase();
}

export function buildForwardedRequestHeaders(entries, { clientIp, publicUrl }) {
  const headers = new Headers();
  for (const [rawName, rawValue] of entries || []) {
    const name = normalizedName(rawName);
    if (!name || REQUEST_BLOCKED.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-")) continue;
    headers.append(name, String(rawValue));
  }

  const url = new URL(publicUrl);
  if (clientIp) headers.set("x-forwarded-for", String(clientIp));
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-host", url.host);
  headers.set("accept-encoding", "identity");
  return headers;
}

export function sanitizeResponseHeaderPairs(entries) {
  const result = [];
  for (const [rawName, rawValue] of entries || []) {
    const name = normalizedName(rawName);
    if (!name || RESPONSE_BLOCKED.has(name)) continue;
    result.push([name, String(rawValue)]);
  }
  return result;
}

export function responseHeaderPairs(response) {
  const pairs = [];
  for (const [name, value] of response.headers.entries()) {
    if (normalizedName(name) !== "set-cookie") pairs.push([name, value]);
  }
  if (typeof response.headers.getSetCookie === "function") {
    for (const cookie of response.headers.getSetCookie()) pairs.push(["set-cookie", cookie]);
  } else {
    const cookie = response.headers.get("set-cookie");
    if (cookie) pairs.push(["set-cookie", cookie]);
  }
  return sanitizeResponseHeaderPairs(pairs);
}

export function appendHeaderPairs(headers, pairs) {
  for (const [name, value] of pairs || []) headers.append(name, value);
  return headers;
}
