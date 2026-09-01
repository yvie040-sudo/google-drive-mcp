import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] || 'all';
const root = join(process.cwd(), '.tmp-test', 'test');

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.isFile() && entry.name.endsWith('.test.js') ? [absolute] : [];
  });
}

const all = walk(root);
const files = all.filter((file) => {
  const rel = relative(root, file).split(sep).join('/');
  if (mode === 'all') return true;
  if (mode === 'unit') return !rel.includes('/');
  if (mode === 'integration') return rel.startsWith('integration/') || rel.startsWith('schema/');
  throw new Error(`Unknown test mode: ${mode}`);
});

const args = ['--test'];
if (process.platform === 'win32') args.push('--test-skip-pattern', 'store file is created with mode 0600');
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, MCP_TESTING: '1' } });
process.exit(result.status ?? 1);
