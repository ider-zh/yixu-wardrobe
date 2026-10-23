import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public');
// Only this dedicated generated directory can be replaced.
assert.equal(path.dirname(output), path.resolve(root));
assert.equal(path.basename(output), 'public');
assert.ok(!fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink());
fs.rmSync(output, {recursive: true, force: true});
fs.mkdirSync(output);
const files = ['index.html', 'app.js', 'catalog.js', 'style.css', 'expressive.css', 'favicon.svg'];
for (const folder of ['images', 'images-v2']) {
  fs.mkdirSync(path.join(output, folder));
  const names = fs.readdirSync(path.join(root, folder));
  assert.equal(names.length, 100);
  for (let id = 1; id <= 100; id++) files.push(`${folder}/look-${String(id).padStart(3, '0')}.png`);
}
let bytes = 0;
for (const name of files) {
  fs.copyFileSync(path.join(root, name), path.join(output, name));
  bytes += fs.statSync(path.join(output, name)).size;
}
assert.equal(files.length, 206);
console.log(JSON.stringify({output: 'public/', files: files.length, bytes}));
