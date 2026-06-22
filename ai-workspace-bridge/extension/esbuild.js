import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  format: 'cjs',
  platform: 'node',
  sourcemap: !production,
  minify: production,
};

async function main() {
  if (watch) {
    const ctx = await import('esbuild').then(m => m.context(options));
    await ctx.watch();
    console.log('watching...');
  } else {
    await import('esbuild').then(m => m.build(options));
  }
}

main().catch(() => process.exit(1));
