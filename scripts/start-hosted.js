#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostedEnvironment } from '../dist/hosted-env.js';

export { resolveHostedEnvironment };

const launcherPath = fileURLToPath(import.meta.url);
const packageEntrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));

export function runHosted() {
  let env;
  try {
    env = resolveHostedEnvironment(process.env);
  } catch (error) {
    console.error(`Hosted startup configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [packageEntrypoint, 'start'], {
    stdio: 'inherit',
    env,
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === resolve(launcherPath)
  : false;
if (invokedDirectly) runHosted();
