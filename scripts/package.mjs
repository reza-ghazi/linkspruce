// Package dist/ into a clean, versioned Chrome Web Store ZIP with checksums and a content audit.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('dist/manifest.json version mismatch: rebuild first');

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dist, p));
  }
};
walk(dist);

// Audit: allowed file types only; no maps, tests, private data, keys or remote code.
const allowed = /\.(js|html|css|json|png)$/;
const problems = [];
for (const f of files) {
  if (!allowed.test(f)) problems.push(`unexpected file type: ${f}`);
  if (/\.map$|test|spec|fixture|private|bookmarks_\d/i.test(f)) problems.push(`development/private file: ${f}`);
  const text = /\.(js|html|css|json)$/.test(f) ? readFileSync(join(dist, f), 'utf8') : '';
  if (/AIza[0-9A-Za-z_-]{30,}/.test(text)) problems.push(`possible Google API key in ${f}`);
  if (/sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) problems.push(`possible secret in ${f}`);
  if (/\beval\s*\(|new Function\s*\(/.test(text)) problems.push(`eval/new Function in ${f}`);
  if (/<script[^>]+src=["']https?:/i.test(text) || /import\s*\(\s*["']https?:/.test(text)) problems.push(`remote script reference in ${f}`);
  if (/sourceMappingURL/.test(text)) problems.push(`source map reference in ${f}`);
}
if (problems.length) {
  console.error('Package audit failed:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}

mkdirSync(join(root, 'release'), { recursive: true });
const zipName = `linkspruce-${pkg.version}.zip`;
const zipPath = join(root, 'release', zipName);
rmSync(zipPath, { force: true });
// Deterministic-ish ordering; -X drops extra file attributes.
execFileSync('zip', ['-X', '-q', '-r', zipPath, ...files.sort()], { cwd: dist });
const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
const fileHashes = files.sort().map((f) => `${createHash('sha256').update(readFileSync(join(dist, f))).digest('hex')}  ${f}`);
writeFileSync(join(root, 'release', `${zipName}.sha256`), `${sha}  ${zipName}\n`);
writeFileSync(join(root, 'release', `linkspruce-${pkg.version}.files.sha256`), fileHashes.join('\n') + '\n');
const size = statSync(zipPath).size;
console.log(JSON.stringify({ zip: `release/${zipName}`, bytes: size, sha256: sha, files: files.length, permissions: manifest.permissions, optional_host_permissions: manifest.optional_host_permissions }, null, 2));
