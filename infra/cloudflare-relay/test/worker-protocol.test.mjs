import test from "node:test";
import assert from "node:assert/strict";
import { requestToBridgeFrame, isNullBodyResponse } from "../src/worker-protocol.mjs";

test("worker request frame preserves path, query and body while rebuilding proxy identity", async () => {
  const request = new Request("https://nick-drive-mcp.xvibenl.workers.dev/token?a=1&b=two", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "6.6.6.6",
      "cf-connecting-ip": "203.0.113.44"
    },
    body: "grant_type=authorization_code&code=abc"
  });

  const frame = await requestToBridgeFrame(request, { id: "req-1", maxBodyBytes: 1024 });
  assert.equal(frame.type, "request");
  assert.equal(frame.id, "req-1");
  assert.equal(frame.method, "POST");
  assert.equal(frame.path, "/token?a=1&b=two");
  assert.equal(Buffer.from(frame.bodyBase64, "base64").toString("utf8"), "grant_type=authorization_code&code=abc");
  const headers = new Map(frame.headers);
  assert.equal(headers.get("x-forwarded-for"), "203.0.113.44");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  assert.equal(headers.get("x-forwarded-host"), "nick-drive-mcp.xvibenl.workers.dev");
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
});

test("worker request frame fails closed when body exceeds the configured bound", async () => {
  const request = new Request("https://nick-drive-mcp.xvibenl.workers.dev/mcp", {
    method: "POST",
    body: "x".repeat(33)
  });
  await assert.rejects(() => requestToBridgeFrame(request, { id: "req-2", maxBodyBytes: 32 }), /too large/i);
});

test("null-body response rules cover HEAD and HTTP statuses that reject bodies", () => {
  assert.equal(isNullBodyResponse("HEAD", 200), true);
  assert.equal(isNullBodyResponse("GET", 204), true);
  assert.equal(isNullBodyResponse("GET", 205), true);
  assert.equal(isNullBodyResponse("GET", 304), true);
  assert.equal(isNullBodyResponse("GET", 302), false);
  assert.equal(isNullBodyResponse("POST", 200), false);
});
