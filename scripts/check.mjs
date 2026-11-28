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
const siteResources = readSiteResources(root);
const pinsContext = {window: {}};
vm.runInNewContext(read('wardrobe-lookbook-pins.js'), pinsContext, {filename: 'wardrobe-lookbook-pins.js'});
const portraits = new Map(content.catalog.looks
  .filter(look => look.editorial_asset)
  .map(look => [look.editorial_asset.asset_id, look.id]));
const linkedPieces = new Set(content.catalog.products.flatMap(product =>
  product.appearances.map(({look_id, piece_index}) => `${look_id}:${piece_index}`)));
for (const [assetId, points] of Object.entries(pinsContext.window.WardrobeLookbookPins)) {
  const lookId = portraits.get(assetId);
  assert.ok(lookId && Object.keys(points).length, `Missing portrait or placements: ${assetId}`);
  for (const [piece, point] of Object.entries(points)) {
    assert.ok(linkedPieces.has(`${lookId}:${piece}`), `Missing linked piece: ${assetId}/${piece}`);
    assert.ok(Array.isArray(point) && point.length === 2 &&
      point.every(value => Number.isInteger(value) && value > 0 && value < 100),
    `Invalid pin coordinates: ${assetId}/${piece}`);
  }
}
assert.ok(siteResources.public.includes('wardrobe-lookbook-pins.js'), 'Lookbook pins must be included in the offline build');
const designContext = {window: {}};
vm.runInNewContext(read('wardrobe-lookbook-designs.js'), designContext, {filename: 'wardrobe-lookbook-designs.js'});
const knownLookIds = new Set(content.catalog.looks.map(look => String(look.id)));
const designOptions = {
  layout: ['center', 'left', 'right', 'masthead', 'split', 'folio'],
  mood: ['light', 'grid', 'rings', 'stripe', 'edge', 'flat'],
  type: ['song', 'hei', 'kai', 'classic', 'modern'],
  frame: ['flush', 'mat', 'line', 'inset'],
};
for (const [lookId, design] of Object.entries(designContext.window.WardrobeLookbookDesigns)) {
  assert.ok(knownLookIds.has(lookId), `Unknown lookbook design: ${lookId}`);
  for (const [name, options] of Object.entries(designOptions)) {
    assert.ok(options.includes(design[name]), `Invalid lookbook ${name}: ${lookId}`);
  }
  for (const color of ['ink', 'paper', 'accent', 'glow']) {
    assert.match(design[color], /^#[0-9a-f]{6}$/i, `Invalid lookbook ${color}: ${lookId}`);
  }
  assert.ok(Number.isFinite(design.scale) && design.scale >= 0.9 && design.scale <= 1.18,
    `Invalid lookbook title scale: ${lookId}`);
  assert.ok(Number.isFinite(design.tracking) && design.tracking >= -0.045 && design.tracking <= 0.14,
    `Invalid lookbook title tracking: ${lookId}`);
  assert.ok(Number.isFinite(design.portraitWeight) && design.portraitWeight >= .95 && design.portraitWeight <= 1.4,
    `Invalid lookbook portrait column: ${lookId}`);
  assert.ok(Number.isFinite(design.titleMeasure) && design.titleMeasure >= 5 && design.titleMeasure <= 13,
    `Invalid lookbook title measure: ${lookId}`);
}
for (const file of ['wardrobe-lookbook-designs.js', 'lookbook-design.css']) {
  assert.ok(siteResources.public.includes(file), `Lookbook design requires ${file} in the offline build`);
}
const sceneContext = {window: {}};
vm.runInNewContext(read('wardrobe-scenes.js'), sceneContext, {filename: 'wardrobe-scenes.js'});
const scenes = sceneContext.window.WARDROBE_SCENES;
assert.ok(Array.isArray(scenes) && scenes.length > 0, 'Expected a list of outfit scenes');
const sceneIds = new Set();
const eligibleLooks = new Set(content.catalog.looks
  .filter(look => !look.model_only && look.versions.v2.ready)
  .map(look => look.id));
for (const {id, title, description, entries} of scenes) {
  assert.ok(typeof id === 'string' && /^[a-z]+(?:-[a-z]+)*$/.test(id), 'Invalid outfit scene ID');
  assert.ok(!sceneIds.has(id), `Duplicate outfit scene: ${id}`);
  sceneIds.add(id);
  assert.ok(typeof title === 'string' && title.trim(), `Missing outfit scene title: ${id}`);
  assert.ok(typeof description === 'string' && description.trim(), `Missing outfit scene description: ${id}`);
  assert.ok(Array.isArray(entries) && entries.length >= 4 && entries.length <= 6, `Expected 4–6 looks in scene: ${id}`);
  const lookIds = new Set();
  for (const {lookId, tip} of entries) {
    assert.ok(eligibleLooks.has(lookId), `Outfit scene ${id} references unavailable look ${lookId}`);
    assert.ok(!lookIds.has(lookId), `Outfit scene ${id} repeats look ${lookId}`);
    assert.ok(typeof tip === 'string' && tip.trim(), `Missing outfit scene tip for ${id}/${lookId}`);
    lookIds.add(lookId);
  }
}
assert.ok(siteResources.public.includes('wardrobe-scenes.js'), 'Outfit scenes must be included in the offline build');
const ideasContext = {window: {}};
vm.runInNewContext(read('wardrobe-styling-ideas.js'), ideasContext, {filename: 'wardrobe-styling-ideas.js'});
const ideaProducts = new Set();
for (const {productId, title, entries} of ideasContext.window.WardrobeStylingIdeas) {
  const product = content.catalog.products.find(item => item.product_id === productId);
  assert.ok(product && !ideaProducts.has(productId), `Invalid or duplicate styling product: ${productId}`);
  assert.ok(typeof title === 'string' && title.trim() && Array.isArray(entries) && entries.length > 0, `Invalid styling group: ${productId}`);
  ideaProducts.add(productId);
  const seenLooks = new Set();
  for (const {lookId, pieceIndex, shotIndex, referenceAssetId, tip} of entries) {
    assert.ok(eligibleLooks.has(lookId) && !seenLooks.has(lookId), `Ineligible or duplicate styling look: ${productId}/${lookId}`);
    seenLooks.add(lookId);
    const look = content.catalog.looks.find(item => item.id === lookId);
    assert.ok(Number.isInteger(pieceIndex) && pieceIndex > 0 && pieceIndex <= look.pieces.length, `Invalid styling piece: ${productId}/${lookId}`);
    assert.ok(Number.isInteger(shotIndex) && shotIndex > 0 && shotIndex <= 9, `Invalid styling shot: ${productId}/${lookId}`);
    assert.equal(referenceAssetId, look.versions.v2.asset.asset_id, `Outdated styling photo: ${productId}/${lookId}`);
    assert.ok(typeof tip === 'string' && tip.trim(), `Missing styling tip: ${productId}/${lookId}`);
  }
  assert.ok(entries.some(entry => product.appearances.some(appearance =>
    appearance.look_id === entry.lookId && appearance.piece_index === entry.pieceIndex &&
    appearance.shot_index === entry.shotIndex && appearance.reference_asset_id === entry.referenceAssetId
  )), `Styling group requires an actual appearance: ${productId}`);
}
const html = read('index.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size);
for(const file of siteResources.public.filter(name=>name.endsWith('.js'))) {
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
