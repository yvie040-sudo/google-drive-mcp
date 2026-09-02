import test from "node:test";
import assert from "node:assert/strict";
import { buildForwardedRequestHeaders, sanitizeResponseHeaderPairs } from "../src/protocol.mjs";

test("request forwarding strips spoofable and hop-by-hop headers and sets one trusted proxy hop", () => {
  const headers = buildForwardedRequestHeaders([
    ["authorization", "Bearer abc"],
    ["content-type", "application/json"],
    ["connection", "keep-alive"],
    ["host", "evil.example"],
    ["x-forwarded-for", "1.2.3.4"],
    ["x-forwarded-proto", "http"],
    ["cf-connecting-ip", "5.6.7.8"],
    ["content-length", "999"]
  ], {
    clientIp: "203.0.113.9",
    publicUrl: "https://nick-drive-mcp.xvibenl.workers.dev/oauth/google/callback?code=x"
  });

  assert.equal(headers.get("authorization"), "Bearer abc");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-forwarded-for"), "203.0.113.9");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  assert.equal(headers.get("x-forwarded-host"), "nick-drive-mcp.xvibenl.workers.dev");
  assert.equal(headers.has("connection"), false);
  assert.equal(headers.has("host"), false);
  assert.equal(headers.has("cf-connecting-ip"), false);
  assert.equal(headers.has("content-length"), false);
});

test("response forwarding preserves OAuth headers while removing transport and decompression hazards", () => {
  const result = sanitizeResponseHeaderPairs([
    ["location", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["www-authenticate", "Bearer resource_metadata=\"https://issuer/.well-known/oauth-protected-resource\""],
    ["set-cookie", "a=1; HttpOnly; Secure"],
    ["set-cookie", "b=2; HttpOnly; Secure"],
    ["content-type", "text/event-stream"],
    ["content-length", "123"],
    ["content-encoding", "gzip"],
    ["transfer-encoding", "chunked"],
    ["connection", "keep-alive"]
  ]);

  assert.deepEqual(result.filter(([name]) => name === "set-cookie").map(([, value]) => value), [
    "a=1; HttpOnly; Secure",
    "b=2; HttpOnly; Secure"
  ]);
  assert.equal(new Map(result).get("location"), "https://accounts.google.com/o/oauth2/v2/auth");
  assert.match(new Map(result).get("www-authenticate"), /resource_metadata/);
  assert.equal(new Map(result).get("content-type"), "text/event-stream");
  for (const blocked of ["content-length", "content-encoding", "transfer-encoding", "connection"]) {
    assert.equal(result.some(([name]) => name === blocked), false);
  }
});
