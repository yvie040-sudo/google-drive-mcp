import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { forwardBridgeRequest } from "../src/bridge-client.mjs";

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("local bridge preserves manual redirects and request identity headers", async () => {
  await withServer((req, res) => {
    assert.equal(req.url, "/authorize?x=1");
    assert.equal(req.headers.authorization, "Bearer abc");
    assert.equal(req.headers["x-forwarded-for"], "203.0.113.9");
    res.writeHead(302, { location: "https://accounts.google.com/example" });
    res.end();
  }, async (port) => {
    const frames = [];
    await forwardBridgeRequest({
      type: "request",
      id: "r1",
      method: "GET",
      path: "/authorize?x=1",
      headers: [
        ["authorization", "Bearer abc"],
        ["x-forwarded-for", "203.0.113.9"],
        ["x-forwarded-proto", "https"]
      ],
      bodyBase64: ""
    }, {
      localOrigin: `http://127.0.0.1:${port}`,
      send: (frame) => frames.push(frame)
    });

    assert.equal(frames[0].type, "response_start");
    assert.equal(frames[0].status, 302);
    assert.equal(new Map(frames[0].headers).get("location"), "https://accounts.google.com/example");
    assert.equal(frames.at(-1).type, "response_end");
  });
});

test("local bridge streams response chunks in protocol order", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ping\ndata: one\n\n");
    setTimeout(() => res.end("event: ping\ndata: two\n\n"), 15);
  }, async (port) => {
    const frames = [];
    await forwardBridgeRequest({
      type: "request",
      id: "r2",
      method: "GET",
      path: "/mcp",
      headers: [["accept", "text/event-stream"]],
      bodyBase64: ""
    }, {
      localOrigin: `http://127.0.0.1:${port}`,
      send: (frame) => frames.push(frame)
    });

    assert.equal(frames[0].type, "response_start");
    assert.equal(frames[0].status, 200);
    assert.ok(frames.slice(1, -1).every((frame) => frame.type === "response_chunk"));
    const body = Buffer.concat(frames.filter((frame) => frame.type === "response_chunk").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8");
    assert.equal(body, "event: ping\ndata: one\n\nevent: ping\ndata: two\n\n");
    assert.equal(frames.at(-1).type, "response_end");
  });
});
