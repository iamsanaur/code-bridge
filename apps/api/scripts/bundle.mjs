// Bundles the relay into one file for npm. The private workspace packages are inlined;
// real dependencies (fastify, pg, PGlite and its WASM files, …) stay external.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/relay.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(pkg.dependencies ?? {}),
  legalComments: 'none',
  logLevel: 'info',
});
