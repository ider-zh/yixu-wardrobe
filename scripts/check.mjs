import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '');
const manifest = JSON.parse(read('image-manifest-all.json'));
const context = {window: {}};
vm.runInNewContext(read('catalog.js'), context, {timeout: 1000});
const catalog = JSON.parse(JSON.stringify(context.window.WARDROBE));
const expectedIds = Array.from({length: 100}, (_, i) => i + 1);
const sorted = values => [...values].sort((a, b) => a - b);
assert.equal(catalog.target, 100);
assert.equal(catalog.looks.length, 100);
assert.equal(catalog.generated, 100);
assert.equal(catalog.expressiveGenerated, 100);
assert.deepEqual(sorted(catalog.looks.map(look => look.id)), expectedIds);
assert.deepEqual(sorted(catalog.displayOrder), expectedIds);
assert.equal(new Set(catalog.categoryOrder).size, 10);
for (const category of catalog.categoryOrder) {
  assert.equal(catalog.looks.filter(look => look.category === category).length, 10);
}
let images = 0;
let imageBytes = 0;
for (const version of ['v1', 'v2']) {
  const folder = version === 'v1' ? 'images' : 'images-v2';
  assert.equal(manifest[version].length, 100);
  assert.deepEqual(sorted(manifest[version].map(item => item.id)), expectedIds);
  assert.equal(fs.readdirSync(path.join(root, folder)).length, 100);
  const hashes = new Set();
  for (const look of catalog.looks) {
    const photo = look.versions[version];
    const expected = `${folder}/look-${String(look.id).padStart(3, '0')}.webp`;
    assert.equal(photo.image, expected);
    assert.equal(photo.ready, true);
    assert.equal(photo.shots.length, 9);
    const record = manifest[version].find(item => item.id === look.id);
    assert.equal(record.file, expected);
    const bytes = fs.readFileSync(path.join(root, expected));
    // These assets are single-frame, lossy WebP (RIFF + one VP8 chunk).
    assert.ok(bytes.length >= 30, `Truncated WebP: ${expected}`);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8 ');
    assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
    const chunkBytes = bytes.readUInt32LE(16);
    assert.equal(20 + chunkBytes + (chunkBytes % 2), bytes.length);
    assert.equal(bytes.subarray(23, 26).toString('hex'), '9d012a');
    assert.equal(bytes.length, record.bytes);
    assert.equal(bytes.readUInt16LE(26) & 0x3fff, record.width);
    assert.equal(bytes.readUInt16LE(28) & 0x3fff, record.height);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, record.sha256, `Image changed: ${expected}`);
    assert.ok(!hashes.has(digest), `Repeated image: ${expected}`);
    hashes.add(digest);
    images++;
    imageBytes += bytes.length;
  }
}
const html = read('index.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size);
for (const match of read('app.js').matchAll(/\$\('([^']+)'\)/g)) {
  assert.ok(ids.includes(match[1]), `Missing UI target: ${match[1]}`);
}
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const target = match[1];
  if (target.startsWith('#')) continue;
  if (target === 'https://beian.miit.gov.cn/') continue;
  assert.ok(!/^[a-z]+:/i.test(target), `Unexpected external resource: ${target}`);
  assert.ok(fs.existsSync(path.join(root, target.split('#')[0])), `Missing resource: ${target}`);
}
for (const name of ['README.md', 'README.en.md', 'DEVELOPMENT.md']) {
  for (const match of read(name).matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:\/\/|#)/.test(target)) continue;
    assert.ok(fs.existsSync(path.join(root, target)), `Missing documentation link: ${name} -> ${target}`);
  }
}
console.log(JSON.stringify({outfits: 100, collections: 10, images, imageBytes, sha256: 'passed', links: 'passed'}));
