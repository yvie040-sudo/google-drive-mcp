#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const distDir = join(__dirname, '../dist');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [
    join(__dirname, '../src/index.ts'),
    join(__dirname, '../src/hosted-env.ts'),
  ],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: distDir,
  format: 'esm',
  // Remove banner for ESM format - shebang will be added by npm/npx
  // banner: {
  //   js: '#!/usr/bin/env node\n',
  // },
  packages: 'external', // Don't bundle node_modules
  sourcemap: true,
};

if (isWatch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);

  // Make the CLI entrypoint executable on non-Windows platforms.
  if (process.platform !== 'win32') {
    const { chmod } = await import('fs/promises');
    await chmod(join(distDir, 'index.js'), 0o755);
  }
  console.log('Build complete!');
}
