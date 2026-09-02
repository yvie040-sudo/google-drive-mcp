import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const wranglerCli = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const bridgeRunner = path.join(root, "src", "bridge-runner.mjs");
const configPath = path.join(root, "wrangler.jsonc");
const testKey = "integration-test-key-0123456789abcdef";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = response;
      if (await predicate(response)) return response;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}; last=${last instanceof Error ? last.message : last?.status}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("Durable Object relay carries OAuth redirects and streamed MCP responses through the local bridge", { timeout: 45_000 }, async () => {
  let lastRequest;
  const origin = createServer((req, res) => {
    lastRequest = { url: req.url, headers: req.headers };
    if (req.url.startsWith("/oauth/google/callback")) {
      res.writeHead(302, { location: "https://example.test/authorized", "set-cookie": ["a=1; HttpOnly", "b=2; HttpOnly"] });
      return res.end();
    }
    if (req.url === "/mcp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: one\ndata: alpha\n\n");
      return setTimeout(() => res.end("event: two\ndata: beta\n\n"), 20);
    }
    if (req.url === "/large" && req.method === "POST") {
      let bytes = 0;
      req.on("data", (chunk) => { bytes += chunk.length; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(bytes));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originPort = origin.address().port;
  const workerPort = await freePort();

  const workerLogs = [];
  const bridgeLogs = [];
  const worker = spawn(process.execPath, [wranglerCli, "dev", "--local", "--ip", "127.0.0.1", "--port", String(workerPort), "--config", configPath, "--var", `DRIVE_RELAY_KEY:${testKey}`, "--show-interactive-dev-session=false"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  worker.stdout.on("data", (chunk) => workerLogs.push(chunk.toString()));
  worker.stderr.on("data", (chunk) => workerLogs.push(chunk.toString()));

  let bridge;
  try {
    await waitFor(`http://127.0.0.1:${workerPort}/__relay/health`, async (response) => response.status === 503);

    bridge = spawn(process.execPath, [bridgeRunner], {
      cwd: root,
      env: {
        ...process.env,
        DRIVE_RELAY_URL: `ws://127.0.0.1:${workerPort}/__relay/ws`,
        DRIVE_RELAY_KEY: testKey,
        DRIVE_RELAY_LOCAL_ORIGIN: `http://127.0.0.1:${originPort}`,
        DRIVE_RELAY_LOG_LEVEL: "error"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    bridge.stdout.on("data", (chunk) => bridgeLogs.push(chunk.toString()));
    bridge.stderr.on("data", (chunk) => bridgeLogs.push(chunk.toString()));

    await waitFor(`http://127.0.0.1:${workerPort}/__relay/health`, async (response) => response.status === 200 && (await response.json()).bridge_connected === true);

    const callback = await fetch(`http://127.0.0.1:${workerPort}/oauth/google/callback?code=abc`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "https://example.test/authorized");
    assert.equal(callback.headers.getSetCookie().length, 2);
    assert.equal(lastRequest.url, "/oauth/google/callback?code=abc");
    assert.equal(lastRequest.headers["x-forwarded-proto"], "http");
    assert.equal(lastRequest.headers["x-forwarded-host"], `127.0.0.1:${workerPort}`);

    const stream = await fetch(`http://127.0.0.1:${workerPort}/mcp`, { headers: { accept: "text/event-stream" } });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    assert.equal(await stream.text(), "event: one\ndata: alpha\n\nevent: two\ndata: beta\n\n");

    const largePayload = "x".repeat(1_500_000);
    const large = await fetch(`http://127.0.0.1:${workerPort}/large`, { method: "POST", body: largePayload });
    assert.equal(large.status, 200);
    assert.equal(Number(await large.text()), Buffer.byteLength(largePayload));

    const logs = `${workerLogs.join("")}\n${bridgeLogs.join("")}`;
    assert.equal(logs.includes(testKey), false);
  } finally {
    await stop(bridge);
    await stop(worker);
    origin.close();
    await once(origin, "close");
  }
});
