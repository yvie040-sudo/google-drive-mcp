import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REQUEST_BODY_BYTES, MAX_BRIDGE_MESSAGE_BYTES, minimumRequestFrameBytes } from "../src/limits.mjs";

test("bridge WebSocket limit can carry a maximum-sized base64 request frame", () => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 4 * 1024 * 1024);
  assert.ok(
    MAX_BRIDGE_MESSAGE_BYTES >= minimumRequestFrameBytes(MAX_REQUEST_BODY_BYTES),
    `bridge limit ${MAX_BRIDGE_MESSAGE_BYTES} is smaller than required request frame size ${minimumRequestFrameBytes(MAX_REQUEST_BODY_BYTES)}`
  );
});
