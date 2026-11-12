import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {acquireLock, runRelease, shouldDeliver, snapshotCatalog, verifyPublication, watchReleases} from '../scripts/release.mjs';
import {digest} from '../scripts/content-lib.mjs';

const head = 'a'.repeat(40);
const json = value => 'window.WARDROBE = ' + JSON.stringify(value) + ';\n';
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yixu-release-'));
  const root = path.join(directory, 'source');
  const state = path.join(directory, 'private');
  fs.mkdirSync(root);
  fs.mkdirSync(state, {mode: 0o700});
  const image = Buffer.from('RIFF-test-image');
  const asset = {sha256: digest(image), bytes: image.length};
  const expected = {revision: 'b'.repeat(64), home: {featured_look_id: 101}, looks: [{id: 101, source_url: '/api/content/assets/look-101', versions: {v2: {asset}}}]};
  const oldCatalog = {...expected, revision: 'c'.repeat(64)};
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public/catalog.js'), json(oldCatalog));
  const staticFiles = {'index.html': '<html>new homepage</html>', 'app.js': 'window.current=true;'};
  const commands = [];
  function execute(command, args) {
    commands.push([command, args]);
    if (args[0] === 'scripts/build.mjs') {
      const output = args[2];
      fs.mkdirSync(output);
      for (const [name, body] of Object.entries(staticFiles)) fs.writeFileSync(path.join(output, name), body);
      fs.writeFileSync(path.join(output, 'catalog.js'), json(expected));
    }
    return '';
  }
  const options = {root, dataDir: state, publicUrl: 'http://localhost:12345/', apiUnit: 'yixu-test-api.service', systemdUser: true, activate: true};
  const fetcher = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/content/catalog') return Response.json(expected);
    if (pathname === '/api/content/assets/look-101') return new Response(image, {headers: {'content-type': 'image/webp'}});
    if (pathname === '/catalog.js') return new Response(json(expected));
    if (pathname === '/') return new Response(staticFiles['index.html']);
    if (pathname === '/app.js') return new Response(staticFiles['app.js']);
    return new Response('', {status: 404});
  };
  const dependencies = {execute, loadContent: () => ({catalog: expected}), cleanHead: () => head, fetcher, attempts: 1};
  return {root, state, directory, options, expected, oldCatalog, image, staticFiles, commands, execute, fetcher, dependencies};
}

async function useFixture(action) {
  const f = fixture();
  try { await action(f); } finally { fs.rmSync(f.directory, {recursive: true, force: true}); }
}

test('explicit delivery checks source/static/API before writing private publication proof', async () => useFixture(async f => {
  const receipt = await runRelease(f.options, f.dependencies);
  assert.equal(receipt.featured_look_id, 101);
  assert.equal(receipt.git_head, head);
  assert.deepEqual(f.commands.find(([command]) => command === 'systemctl')[1], ['--user', 'restart', 'yixu-test-api.service']);
  const proof = JSON.parse(fs.readFileSync(path.join(f.state, 'publication.json')));
  assert.equal(proof.source_sha256, digest(f.image));
  assert.equal(fs.statSync(path.join(f.state, 'publication.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(proof).includes(f.directory), false);
  assert.equal(fs.existsSync(path.join(f.state, 'release.lock')), false);
}));

test('validation failure retains prior public and proof without restart', async () => useFixture(async f => {
  fs.writeFileSync(path.join(f.state, 'publication.json'), '{"status":"previous"}');
  await assert.rejects(runRelease(f.options, {...f.dependencies, loadContent: () => { throw new Error('missing asset'); }}), /missing asset/);
  assert.equal(snapshotCatalog(fs.readFileSync(path.join(f.root, 'public/catalog.js'), 'utf8')).revision, f.oldCatalog.revision);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'publication.json'))).status, 'previous');
  assert.equal(f.commands.length, 0);
}));

test('bad deployed image rolls static back and invalidates current proof without touching private db', async () => useFixture(async f => {
  fs.writeFileSync(path.join(f.state, 'publication.json'), '{"status":"previous"}');
  fs.writeFileSync(path.join(f.state, 'content.sqlite3'), 'private-state-sentinel');
  const fetcher = async (url, options) => new URL(url).pathname.includes('/assets/') ? new Response('corrupt', {headers: {'content-type': 'image/webp'}}) : f.fetcher(url, options);
  await assert.rejects(runRelease(f.options, {...f.dependencies, fetcher}), /byte count/);
  assert.equal(snapshotCatalog(fs.readFileSync(path.join(f.root, 'public/catalog.js'), 'utf8')).revision, f.oldCatalog.revision);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'publication.json'))).status, 'activation_failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'publication.previous.json'))).status, 'previous');
  assert.equal(fs.readFileSync(path.join(f.state, 'content.sqlite3'), 'utf8'), 'private-state-sentinel');
}));

test('API/snapshot skew is rejected even when total and newest ID match', async () => useFixture(async f => {
  const fetcher = async (url, options) => new URL(url).pathname === '/catalog.js' ? new Response(json(f.oldCatalog)) : f.fetcher(url, options);
  await assert.rejects(runRelease(f.options, {...f.dependencies, fetcher}), /Static snapshot differs/);
}));

test('dry run and dirty source never activate; lock serializes explicit deliveries', async () => useFixture(async f => {
  const result = await runRelease({...f.options, activate: false}, f.dependencies);
  assert.equal(result.status, 'validated');
  assert.equal(f.commands.some(([command]) => command === 'systemctl'), false);
  assert.equal(fs.existsSync(path.join(f.state, 'publication.json')), false);
  const unlock = acquireLock(f.state);
  await assert.rejects(runRelease(f.options, f.dependencies), /Another delivery/);
  unlock();
  await assert.rejects(runRelease(f.options, {...f.dependencies, cleanHead: () => { throw new Error('dirty'); }}), /dirty/);
}));

test('watch dispatch ignores dirty sources, verified commits and already failed attempts', () => {
  assert.equal(shouldDeliver({head, dirty: true}), false);
  assert.equal(shouldDeliver({head, dirty: false, verifiedHead: head}), false);
  assert.equal(shouldDeliver({head, dirty: false, attemptedHead: head}), false);
  assert.equal(shouldDeliver({head, dirty: false, verifiedHead: 'old'}), true);
});

test('HTTP probe uses actual public routes and validates byte hash without CDN', async () => useFixture(async f => {
  const publicRoot = path.join(f.root, 'public');
  for (const [name, value] of Object.entries(f.staticFiles)) fs.writeFileSync(path.join(publicRoot, name), value);
  const server = createServer(async (request, response) => {
    const result = await f.fetcher('http://localhost:12345' + request.url);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const receipt = await verifyPublication({origin, expected: f.expected, publicRoot});
    assert.equal(receipt.source_verified, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('admin separates imported content, publication proof and CDN availability', async () => {
  const {createRequire} = await import('node:module');
  const require = createRequire(new URL('../admin/package.json', import.meta.url));
  const {parseHTML} = require('linkedom');
  const {createAdminApp} = await import('../admin/app.mjs');
  const html = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  for (const verified of [false, true]) {
    const {document} = parseHTML(html);
    const content = {
      revision: 'fixture-active', content_ready: true, look_count: 101, model_count: 1,
      home: {featured_look_id: 101}, featured_title: '秋日散步',
      publication: {status: verified ? 'verified' : 'not_verified', verified_at: '2026-11-12T08:30:00.000Z'},
      cdn: {config: {configured: false}, counts: {}, total: 0, jobs: []},
    };
    const routes = {
      '/api/admin/bootstrap': {authenticated: true, csrf_token: 'fixture'},
      '/api/admin/overview': {popular_looks: [], recent_jobs: []},
      '/api/admin/results?offset=0&limit=24': {items: [], has_more: false},
      '/api/admin/settings': {},
      '/api/admin/content/overview': content,
      '/api/admin/content/models': {models: []},
    };
    const app = createAdminApp({document, confirm: () => true, fetch: async url => {
      assert.ok(routes[url], url);
      return Response.json(routes[url]);
    }});
    await app.start();
    assert.match(document.querySelector('#content-status').textContent, /101 套穿搭/);
    assert.match(document.querySelector('#publication-status').textContent, /首页主推：101「秋日散步」/);
    assert.match(document.querySelector('#publication-status').textContent, verified ? /网站交付已验证/ : /网站交付尚未验证/);
    assert.match(document.querySelector('#cdn-status').textContent, /CDN 未配置/);
  }
});

test('watcher writes failed attempt state, skips dirty sources and skips verified HEAD', async () => useFixture(async f => {
  let deliveries = 0;
  const dependencies = {once: true, cleanHead: () => head, runRelease: async () => {
    deliveries++;
    throw new Error('fixture rejected activation');
  }};
  await watchReleases(f.options, dependencies);
  assert.equal(deliveries, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'release-watch.json'))).status, 'failed');
  assert.equal(fs.existsSync(path.join(f.state, 'publication.json')), false);
  await watchReleases(f.options, {...dependencies, cleanHead: () => { throw new Error('dirty'); }});
  assert.equal(deliveries, 1);
  fs.writeFileSync(path.join(f.state, 'publication.json'), JSON.stringify({status: 'verified', git_head: head}));
  await watchReleases(f.options, dependencies);
  assert.equal(deliveries, 1);
}));

test('watcher records the commit actually verified when HEAD advances before delivery', async () => useFixture(async f => {
  const deliveredHead='b'.repeat(40);
  await watchReleases(f.options, {once:true, cleanHead:()=>head, runRelease:async()=>({status:'verified',git_head:deliveredHead})});
  const receipt=JSON.parse(fs.readFileSync(path.join(f.state,'release-watch.json')));
  assert.equal(receipt.status,'verified');
  assert.equal(receipt.git_head,deliveredHead);
}));
