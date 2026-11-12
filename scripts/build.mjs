import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from './content-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public');
// Validate the complete candidate before replacing the disposable public output.
const content = loadContent(root);
// Only this dedicated generated directory can be replaced.
assert.equal(path.dirname(output), path.resolve(root));
assert.equal(path.basename(output), 'public');
assert.ok(!fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink());
fs.rmSync(output, {recursive: true, force: true});
fs.mkdirSync(output);
const files = ['index.html', 'app.js', 'style.css', 'expressive.css', 'tryon.js', 'tryon.css', 'favicon.svg', ...new Set(content.publicAssets.map(asset => asset.file))];
let bytes = 0;
for (const name of files) {
  fs.mkdirSync(path.dirname(path.join(output, name)), {recursive: true});
  fs.copyFileSync(path.join(root, name), path.join(output, name));
  bytes += fs.statSync(path.join(output, name)).size;
}
const snapshot = 'window.WARDROBE = ' + JSON.stringify(content.catalog) + ';\n';
fs.writeFileSync(path.join(output, 'catalog.js'), snapshot);
bytes += Buffer.byteLength(snapshot);
console.log(JSON.stringify({output: 'public/', files: files.length + 1, bytes, outfits: content.catalog.looks.length, revision: content.catalog.revision}));
