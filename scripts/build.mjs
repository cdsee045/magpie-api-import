import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/host.ts'], outfile: 'dist/host.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: false });
console.log('Built trusted-host module: dist/host.mjs. UI assets load directly from ui/.');
