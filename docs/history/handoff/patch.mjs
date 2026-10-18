// usage: node patch.mjs <file> <patchfile.json>   — applies [[old, new], ...] exact replacements; fails without writing if any is missing
import fs from 'node:fs';
const [file, patches] = process.argv.slice(2);
let s = fs.readFileSync(file, 'utf8');
const list = JSON.parse(fs.readFileSync(patches, 'utf8'));
for (const [a, b] of list) {
  const at = s.indexOf(a);
  if (at < 0) { console.error('MISSING:', a.slice(0, 120)); process.exit(1); }
  if (s.indexOf(a, at + 1) >= 0) { console.error('NOT UNIQUE:', a.slice(0, 120)); process.exit(1); }
  s = s.slice(0, at) + b + s.slice(at + a.length);
}
fs.writeFileSync(file, s);
console.log(`patched ${list.length} places in ${file}`);
