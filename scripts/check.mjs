import {readSiteResources} from './site-resources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {loadContent} from './content-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '');
const content = loadContent(root);
const baseline = JSON.parse(read('content/catalog.json'));
const expectedIds = Array.from({length: 100}, (_, index) => index + 1);
assert.deepEqual(baseline.looks.map(look => look.id).sort((a, b) => a - b), expectedIds);
const baselineImages = new Set();
for (const look of baseline.looks) {
  const hash = look.versions.v2.asset.sha256;
  assert.ok(!baselineImages.has(hash), `Duplicate baseline photo for look ${look.id}`);
  baselineImages.add(hash);
}
readSiteResources(root);
const html = read('index.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size);
for(const file of ['app.js','tryon-storage.js','tryon.js','product-themes.js','product-page.js','site-theme.js']) {
  new vm.Script(read(file),{filename:file});
  for (const match of read(file).matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.includes(match[1]), `Missing UI target: ${match[1]}`);
  }
}
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const target = match[1];
  if (target.startsWith('#') || target === 'catalog.js') continue;
  if (target === 'https://beian.miit.gov.cn/') continue;
  assert.ok(!/^[a-z]+:/i.test(target), `Unexpected external resource: ${target}`);
  assert.ok(fs.existsSync(path.join(root, target.split('#')[0])), `Missing resource: ${target}`);
}
const docs = ['AGENTS.md', 'README.md', 'README.en.md', 'DEVELOPMENT.md'];
for (const folder of ['backend', 'deploy', 'docs']) {
  docs.push(...fs.readdirSync(path.join(root, folder), {recursive: true})
    .filter(name => name.endsWith('.md')).map(name => path.join(folder, name)));
}
for (const name of docs) {
  for (const match of read(name).matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:\/\/|#)/.test(target)) continue;
    const relative = target.split('#')[0];
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(name), relative)),
      `Missing documentation link: ${name} -> ${target}`);
  }
}
console.log(JSON.stringify({outfits: content.catalog.looks.length, collections: content.catalog.categoryOrder.length, publicAssets: content.publicAssets.length, sha256: 'passed', links: 'passed'}));
