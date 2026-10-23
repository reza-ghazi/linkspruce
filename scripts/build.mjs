// Build the extension into dist/. Usage: node scripts/build.mjs [--dev] [--watch]
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');
// --e2e: test-only build in dist-e2e/ that pre-grants the fixture hostname (never shipped).
const e2e = process.argv.includes('--e2e');
const out = join(root, e2e ? 'dist-e2e' : 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/index.ts',
    popup: 'src/ui/popup/popup.ts',
    dashboard: 'src/ui/dashboard/dashboard.ts',
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: ['chrome134'],
  // Readable output for Chrome Web Store review: whitespace/syntax minified, identifiers kept.
  minifyWhitespace: !dev,
  minifySyntax: !dev,
  minifyIdentifiers: false,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  define: { __DEV__: JSON.stringify(dev || e2e), __VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
};

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(root, 'src/static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    manifest.host_permissions = ['http://*.linkspruce-fixture.example/*'];
    manifest.name = `${manifest.name} (E2E test build)`;
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const f of ['popup.html', 'dashboard.html']) cpSync(join(root, 'src/ui', f.replace('.html', ''), f), join(out, f));
  const base = readFileSync(join(root, 'src/ui/shared/base.css'), 'utf8');
  for (const name of ['popup', 'dashboard']) {
    writeFileSync(join(out, `${name}.css`), `${base}\n${readFileSync(join(root, `src/ui/${name}/${name}.css`), 'utf8')}`);
  }
  if (!existsSync(join(root, 'public/icons/icon-128.png'))) throw new Error('Icons missing: run node scripts/icons.mjs');
  cpSync(join(root, 'public/icons'), join(out, 'icons'), { recursive: true, filter: (p) => !p.endsWith('.svg') || p.endsWith('/icons') });
}

if (watch) {
  const ctx = await esbuild.context({ ...options, plugins: [{ name: 'static', setup(b) { b.onEnd(() => copyStatic()); } }] });
  await ctx.watch();
} else {
  await esbuild.build(options);
  copyStatic();
  console.log(`Built LinkSpruce ${pkg.version}${dev ? ' (dev)' : ''}${e2e ? ' (e2e)' : ''} → ${e2e ? 'dist-e2e' : 'dist'}/`);
}
