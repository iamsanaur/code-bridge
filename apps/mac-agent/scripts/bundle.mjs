// Bundles the agent into one file for npm. The workspace packages (@codebridge/protocol,
// @codebridge/shared) are private, so they are inlined; real dependencies stay external and
// are installed by npm. Native modules must stay external.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  legalComments: 'none',
  logLevel: 'info',
});
