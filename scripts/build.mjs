import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from './content-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output' && args[1]), 'Usage: node scripts/build.mjs [--output empty-candidate-directory]');
const candidateOnly = args.length > 0;
const output = candidateOnly ? path.resolve(args[1]) : path.join(root, 'public');
assert.notEqual(output, path.resolve(root), 'Build output cannot be the source root');
for (let current = output; ; current = path.dirname(current)) {
  assert.ok(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(), 'Build output cannot traverse a symlink');
  if (current === path.dirname(current)) break;
}
if (candidateOnly && fs.existsSync(output)) {
  assert.ok(fs.statSync(output).isDirectory() && fs.readdirSync(output).length === 0, 'Explicit build output must be empty');
}
// Validate before staging, and leave the currently served output intact until
// every file and the complete offline snapshot have been written successfully.
const content = loadContent(root);
const parent = path.dirname(output);
fs.mkdirSync(parent, {recursive: true});
const staging = fs.mkdtempSync(path.join(parent, '.yixu-build-'));
const files = ['index.html', 'app.js', 'product-themes.js', 'product-page.js', 'style.css', 'expressive.css', 'product-themes.css', 'tryon.js', 'tryon.css', 'favicon.svg', ...new Set(content.publicAssets.map(asset => asset.file))];
let bytes = 0;
let backup;
try {
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(staging, name)), {recursive: true});
    fs.copyFileSync(path.join(root, name), path.join(staging, name));
    bytes += fs.statSync(path.join(staging, name)).size;
  }
  const snapshot = 'window.WARDROBE = ' + JSON.stringify(content.catalog) + ';\n';
  fs.writeFileSync(path.join(staging, 'catalog.js'), snapshot);
  bytes += Buffer.byteLength(snapshot);
  if (candidateOnly) {
    if (fs.existsSync(output)) fs.rmdirSync(output); // Only the checked empty directory.
  } else if (fs.existsSync(output)) {
    backup = fs.mkdtempSync(path.join(parent, '.yixu-build-backup-'));
    fs.rmdirSync(backup);
    fs.renameSync(output, backup);
  }
  try { fs.renameSync(staging, output); }
  catch (error) {
    if (backup) { fs.renameSync(backup, output); backup = undefined; }
    throw error;
  }
  if (backup) fs.rmSync(backup, {recursive: true, force: true});
} finally {
  fs.rmSync(staging, {recursive: true, force: true});
}
console.log(JSON.stringify({output: candidateOnly ? output : 'public/', files: files.length + 1, bytes, outfits: content.catalog.looks.length, revision: content.catalog.revision, featured_look_id: content.catalog.home?.featured_look_id ?? null}));
