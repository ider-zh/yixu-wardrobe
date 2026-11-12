import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const assetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (condition, message) => assert.ok(condition, message);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function publicationTime(batch) {
  const value = batch.published_at ?? batch.publish_date + 'T00:00:00+08:00';
  fail(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'Timezone-aware publication timestamp required');
  const parsed = Date.parse(value);
  const day = value.slice(0, 10);
  fail(!Number.isNaN(parsed) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60, 'Invalid publication timestamp');
  fail(new Date(parsed + 8 * 3600000).toISOString().slice(0, 10) === batch.publish_date, 'Publication timestamp must match the Shanghai publication date');
  return new Date(parsed).toISOString();
}

export function publicationProjection(looks, batches, legacyOrder) {
  const orderedBatches = [...batches].sort((a, b) => compare(b.published_at, a.published_at) || compare(b.batch_id, a.batch_id));
  const publishedIds = orderedBatches.flatMap(batch => [...batch.look_ids].sort((a, b) => a - b));
  const publishedSet = new Set(publishedIds);
  const latestOrder = [...publishedIds, ...looks.filter(look => !publishedSet.has(look.id)).map(look => look.id).sort((a, b) => a - b)];
  const featured = orderedBatches[0]?.cover_look_id ?? legacyOrder[0] ?? latestOrder[0] ?? null;
  return {
    orderedBatches, latestOrder,
    home: {featured_look_id: featured, recent_look_ids: latestOrder.filter(id => id !== featured).slice(0, 6), latest_batch_id: orderedBatches[0]?.batch_id ?? null},
  };
}

export function localFile(root, relative) {
  fail(typeof relative === 'string' && /^[A-Za-z0-9_./-]+$/.test(relative), 'Invalid resource path');
  fail(!relative.startsWith('/') && relative.split('/').every(part => part && !part.startsWith('.')), 'Unsafe resource path');
  let current = path.resolve(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    fail(!fs.lstatSync(current).isSymbolicLink(), `Symlink resource: ${relative}`);
  }
  fail(fs.statSync(current).isFile(), `Not a resource file: ${relative}`);
  return current;
}

export function verifyWebp(root, record) {
  fail(object(record) && typeof record.file === 'string' && record.file.endsWith('.webp'), 'WebP record required');
  fail(Number.isSafeInteger(record.width) && record.width > 0 && Number.isSafeInteger(record.height) && record.height > 0, 'Invalid image dimensions');
  fail(Number.isSafeInteger(record.bytes) && record.bytes >= 30 && /^[a-f0-9]{64}$/.test(record.sha256 || ''), 'Invalid image metadata');
  const bytes = fs.readFileSync(localFile(root, record.file));
  fail(bytes.length >= 30, `Truncated WebP: ${record.file}`);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8 ');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  const chunk = bytes.readUInt32LE(16);
  assert.equal(20 + chunk + chunk % 2, bytes.length);
  assert.equal(bytes.subarray(23, 26).toString('hex'), '9d012a');
  assert.equal(bytes.readUInt16LE(26) & 0x3fff, record.width);
  assert.equal(bytes.readUInt16LE(28) & 0x3fff, record.height);
  assert.equal(bytes.length, record.bytes);
  assert.equal(digest(bytes), record.sha256, `Image changed: ${record.file}`);
  return bytes;
}

export function loadContent(root) {
  const sources = [];
  function json(relative) {
    const bytes = fs.readFileSync(localFile(root, relative));
    sources.push([relative, digest(bytes)]);
    return JSON.parse(bytes.toString('utf8'));
  }
  const base = json('content/catalog.json');
  const registry = json('content/models.json');
  fail(base.schema_version === 1 && registry.schema_version === 1, 'Unsupported content schema');
  fail(Array.isArray(base.looks) && Array.isArray(base.categoryOrder), 'Invalid baseline catalog');
  fail(base.categoryOrder.every(text) && new Set(base.categoryOrder).size === base.categoryOrder.length, 'Invalid category registry');
  fail(Array.isArray(registry.models), 'Invalid model registry');
  const models = new Map();
  const assets = new Map();
  function registerAsset(record, grid = false) {
    fail(object(record) && assetId(record.asset_id), 'Invalid asset ID');
    fail(['public', 'private'].includes(record.visibility), 'Explicit asset visibility required');
    fail(record.mime === 'image/webp', 'Only WebP content assets are supported');
    fail(/^(?:images-v2\/|assets\/)/.test(record.file || ''), 'Only declared public resource trees are supported');
    fail(record.width >= 32 && record.height >= 32 && record.width <= 8000 && record.height <= 8000 && record.width * record.height <= 24000000 && record.bytes <= 50 * 1024 * 1024, 'Content image exceeds decoded limits');
    verifyWebp(root, record);
    const existing = assets.get(record.asset_id);
    fail(!existing, `Asset ID reused: ${record.asset_id}`);
    assets.set(record.asset_id, structuredClone(record));
    if (grid) {
      fail(record.visibility === 'public', 'Outfit grid must be public');
      fail(record.layout?.rows === 3 && record.layout?.columns === 3, 'A 3×3 grid is required');
      fail(Number.isInteger(record.layout.preview_panel) && record.layout.preview_panel >= 1 && record.layout.preview_panel <= 9, 'Invalid preview panel');
      fail(record.width * 3 === record.height * 2, 'Expressive montage must retain 2:3 aspect ratio');
    }
    return record;
  }
  for (const model of registry.models) {
    fail(object(model) && assetId(model.model_id) && !models.has(model.model_id) && text(model.name), 'Invalid or duplicate model');
    registerAsset(model.reference);
    fail(Array.isArray(model.views) && model.views.every(text), 'Model views required');
    models.set(model.model_id, model);
  }
  fail(models.has('female-01'), 'The first model reference must remain registered');
  const looks = new Map();
  function addLook(input, batch = null) {
    fail(object(input) && Number.isSafeInteger(input.id) && input.id > 0 && input.id <= 2147483647 && !looks.has(input.id), 'Invalid or duplicate look ID');
    fail(text(input.title) && base.categoryOrder.includes(input.category), 'Look title and registered category required');
    fail(text(input.description) && text(input.season), 'Look description and season required');
    fail(Array.isArray(input.pieces) && input.pieces.length > 0 && input.pieces.every(piece => object(piece) && text(piece.role) && text(piece.name)), 'Complete outfit pieces required');
    const model = input.model_id == null ? null : models.get(input.model_id);
    fail(input.model_id == null || model, 'Unknown model reference');
    if (batch) {
      fail(model && model.enabled !== false && input.model_reference_sha256 === model.reference.sha256, 'Missing, disabled or stale model reference');
      fail(input.edition === 'v2', 'New outfits must be expressive only');
      fail(text(input.mood) && text(input.scene) && Array.isArray(input.tags) && input.tags.length > 0 && input.tags.every(text), 'Expressive mood, scene and tags required');
    }
    const version = batch ? {
      image: input.asset?.file, asset: input.asset, shots: input.shots,
      story: input.story || input.title, summary: input.summary || input.description,
      moods: input.mood ? [input.mood] : [],
    } : input.versions?.v2;
    fail(object(version) && Array.isArray(version.shots) && version.shots.length === 9, 'Nine expressive shots required');
    fail(version.shots.every((shot, i) => object(shot) && text(shot.title) && (!batch || (shot.index === i + 1 && text(shot.emotion) && text(shot.pose) && text(shot.framing)))), 'Invalid expressive shot descriptions');
    registerAsset(version.asset, true);
    fail(version.image === version.asset.file, 'Look image and asset must agree');
    const source = version.asset.file;
    const out = {};
    for (const key of ['id', 'title', 'category', 'season', 'palette', 'description', 'pieces', 'details', 'tags', 'scene', 'editorialOrder']) {
      if (input[key] !== undefined) out[key] = structuredClone(input[key]);
    }
    Object.assign(out, {
      model_id: input.model_id ?? null,
      model_reference_sha256: input.model_reference_sha256 ?? null,
      batch_id: batch?.batch_id ?? input.batch_id ?? null,
      publish_date: batch?.publish_date ?? input.publish_date ?? null,
      published_at: batch ? publicationTime(batch) : null,
      region: structuredClone(batch?.region ?? input.region ?? null),
      image: source, source_url: source, ready: true,
      versions: {v2: {
        image: source, image_url: source, source_url: source, download_url: source,
        ready: true, previewPanel: version.asset.layout.preview_panel,
        story: version.story || input.title, summary: version.summary || input.description,
        moods: structuredClone(version.moods || []), shots: structuredClone(version.shots),
        asset: structuredClone(version.asset),
      }},
    });
    out.details ||= [];
    out.tags ||= [];
    out.palette ||= ['#d1c3ac', '#f6f0e4', '#594033'];
    looks.set(input.id, out);
  }
  for (const look of base.looks) addLook(look);
  const batches = [];
  const batchIds = new Set();
  const dates = new Set();
  const directory = path.join(root, 'content/batches');
  if (fs.existsSync(directory)) {
    fail(!fs.lstatSync(directory).isSymbolicLink(), 'Symlink batch directory');
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
      const batch = json('content/batches/' + name);
      fail(object(batch) && Object.keys(batch).every(key => ['schema_version', 'batch_id', 'publish_date', 'published_at', 'cover_look_id', 'timezone', 'title', 'region', 'research', 'looks'].includes(key)), 'Unknown batch metadata');
      fail(batch.schema_version === 1 && assetId(batch.batch_id) && !batchIds.has(batch.batch_id), 'Invalid or duplicate batch');
      fail(/^\d{4}-\d{2}-\d{2}$/.test(batch.publish_date || '') && !Number.isNaN(Date.parse(batch.publish_date + 'T00:00:00Z')) && new Date(batch.publish_date + 'T00:00:00Z').toISOString().slice(0,10) === batch.publish_date, 'Invalid publication date');
      fail(!dates.has(batch.publish_date) && batch.batch_id.startsWith(batch.publish_date+'-') && name === batch.batch_id+'.json', 'Batch date or filename conflicts');
      fail(batch.timezone === 'Asia/Shanghai' && text(batch.title), 'Batch timezone and title required');
      fail(object(batch.region) && text(batch.region.city), 'Batch city required');
      fail(object(batch.research) && text(batch.research.checked_at) && Array.isArray(batch.research.trend_sources) && batch.research.trend_sources.length >= 2, 'Research evidence required');
      const citations = batch.research.trend_sources;
      fail(citations.every(source => object(source) && /^https:\/\//.test(source.url || '') && text(source.published_at) && text(source.summary)), 'Invalid trend source');
      fail(new Set(citations.map(source => source.url)).size >= 2, 'Independent source URLs required');
      fail(object(batch.research.weather) && /^https:\/\//.test(batch.research.weather.url || '') && text(batch.research.weather.checked_at) && text(batch.research.weather.forecast_date) && text(batch.research.weather.summary) && text(batch.research.weather.styling_reason), 'Weather evidence required');
      fail(batch.research.weather.forecast_date === batch.publish_date, 'Weather must cover the publication date');
      fail([batch.research.checked_at,batch.research.weather.checked_at].every(time=>typeof time==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(time) && !Number.isNaN(Date.parse(time))), 'Timezone-aware research times required');
      fail(Array.isArray(batch.looks) && batch.looks.length > 0, 'Empty batch');
      const publishedAt = publicationTime(batch);
      fail(batch.cover_look_id == null || (Number.isSafeInteger(batch.cover_look_id) && batch.looks.some(look => look.id === batch.cover_look_id)), 'Cover must belong to this batch');
      batchIds.add(batch.batch_id);
      dates.add(batch.publish_date);
      for (const look of batch.looks) addLook(look, batch);
      batches.push({batch_id: batch.batch_id, publish_date: batch.publish_date, published_at: publishedAt, cover_look_id: batch.cover_look_id ?? batch.looks[0].id, title: batch.title, region: structuredClone(batch.region), look_ids: batch.looks.map(look => look.id)});
    }
  }
  const published = [...looks.values()];
  const legacyOrder = base.displayOrder || base.looks.map(look => look.id);
  fail(Array.isArray(legacyOrder) && legacyOrder.length === base.looks.length && new Set(legacyOrder).size === legacyOrder.length && legacyOrder.every(id => base.looks.some(look => look.id === id)), 'Invalid curated baseline order');
  const {orderedBatches, latestOrder, home} = publicationProjection(published, batches, legacyOrder);
  const displayOrder = [...orderedBatches.flatMap(batch => batch.look_ids), ...legacyOrder];
  displayOrder.forEach((id, i) => { looks.get(id).editorialOrder = i + 1; });
  const publicModels = [...models.values()].filter(model=>model.reference.visibility==='public').map(model => ({
    model_id: model.model_id, name: model.name, views: model.views,
    look_count: published.filter(look => look.model_id === model.model_id).length,
    ...(model.reference.visibility === 'public' ? {reference: {...model.reference, image_url: model.reference.file, source_url: model.reference.file}} : {}),
  }));
  const revision = digest(Buffer.from(JSON.stringify(sources.sort((a, b) => compare(a[0], b[0])))));
  return {
    catalog: {schema_version: 1, revision, target: published.length, generated: published.length, expressiveGenerated: published.length,
      planned: published.length, categoryOrder: [...base.categoryOrder], displayOrder, latestOrder, home, looks: published,
      models: publicModels, batches: orderedBatches},
    assets: [...assets.values()],
    publicAssets: [...assets.values()].filter(asset => asset.visibility === 'public'),
  };
}
