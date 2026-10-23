// Render PNG icons from the SVG sources (requires rsvg-convert).
import { execFileSync } from 'node:child_process';
const sizes = [[16, 'icon-small.svg'], [32, 'icon-small.svg'], [48, 'icon.svg'], [128, 'icon.svg']];
for (const [s, src] of sizes) {
  execFileSync('rsvg-convert', ['-w', String(s), '-h', String(s), '-o', `public/icons/icon-${s}.png`, `public/icons/${src}`]);
}
console.log('icons rendered');
