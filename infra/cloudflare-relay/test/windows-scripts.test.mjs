import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const windows = path.join(root, "scripts", "windows");

async function text(name) {
  return readFile(path.join(windows, name), "utf8");
}

test("relay Scheduled Task keeps the bridge secret out of task arguments", async () => {
  const install = await text("install-relay-client.ps1");
  assert.match(install, /run-relay-client\.ps1/i);
  assert.match(install, /-SecretPath/i);
  assert.doesNotMatch(install, /-RelayKey\b/i);
  assert.doesNotMatch(install, /DRIVE_RELAY_KEY\s*=/i);
  assert.match(install, /LogonType\s+S4U/i);
  assert.match(install, /RunLevel\s+Limited/i);
});

test("relay runtime decrypts DPAPI only inside the task process and clears the plaintext env value", async () => {
  const run = await text("run-relay-client.ps1");
  assert.match(run, /ConvertTo-SecureString/i);
  assert.match(run, /relay_key_dpapi/i);
  assert.match(run, /\$env:DRIVE_RELAY_KEY\s*=\s*\$relayKey/i);
  assert.match(run, /\$env:DRIVE_RELAY_KEY\s*=\s*\$null/i);
});

test("Cloudflare provisioning uses Worker secret stdin and stores only a DPAPI blob locally", async () => {
  const deploy = await text("deploy-cloudflare-relay.ps1");
  assert.match(deploy, /wrangler[^\r\n]*secret[^\r\n]*put/i);
  assert.match(deploy, /ConvertFrom-SecureString/i);
  assert.match(deploy, /relay_key_dpapi/i);
  assert.doesNotMatch(deploy, /Write-(?:Host|Output)[^\r\n]*\$relayKey/i);
});
