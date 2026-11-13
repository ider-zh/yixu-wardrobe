import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadContent, digest} from './content-lib.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);

export function snapshotCatalog(text) {
  const match = /^window\.WARDROBE = ([\s\S]+);\s*$/.exec(text);
  assert.ok(match, 'Invalid public content snapshot');
  return JSON.parse(match[1]);
}

export function cleanHead(root, command = execFileSync) {
  const options = {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']};
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=all'], options).trim(), '', 'Working tree is not clean; commit the complete release first');
  const head = command('git', ['rev-parse', 'HEAD'], options).trim();
  assert.match(head, /^[a-f0-9]{40,64}$/);
  return head;
}

export function shouldDeliver({head, dirty, verifiedHead, attemptedHead}) {
  return Boolean(head && !dirty && head !== verifiedHead && head !== attemptedHead);
}

function privateRoot(directory, root) {
  const resolved = path.resolve(directory);
  assert.ok(!inside(root, resolved), 'Delivery state must be outside the repository and public root');
  fs.mkdirSync(resolved, {recursive: true, mode: 0o700});
  assert.ok(!fs.lstatSync(resolved).isSymbolicLink() && fs.statSync(resolved).isDirectory(), 'Private data directory must be a real directory');
  assert.ok(!inside(fs.realpathSync(root), fs.realpathSync(resolved)), 'Private state must not resolve inside the repository');
  assert.equal(fs.statSync(resolved).mode & 0o077, 0, 'Private state directory permissions must be 0700');
  return resolved;
}

export function writeReceipt(directory, value, name = 'publication.json') {
  const temporary = path.join(directory, `.${name}-${crypto.randomUUID()}`);
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, path.join(directory, name));
}

export function acquireLock(directory) {
  const lock = path.join(directory, 'release.lock');
  try { fs.mkdirSync(lock, {mode: 0o700}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Another delivery owns release.lock; inspect its owner before removing a stale lock');
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, started_at: new Date().toISOString()}), {mode: 0o600});
  return () => fs.rmSync(lock, {recursive: true});
}

function originUrl(value) {
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Public URL must be an HTTP(S) origin without credentials');
  return url.origin;
}

export async function verifyPublication({origin, expected, publicRoot, fetcher = fetch}) {
  const get = async relative => {
    const url = new URL(relative, origin + '/');
    assert.equal(url.origin, origin, 'Source image must use the project origin');
    const response = await fetcher(url, {cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200, `Publication HTTP check failed: ${url.pathname}`);
    return response;
  };
  const actual = await (await get('/api/content/catalog')).json();
  const featuredId = expected.home?.featured_look_id;
  assert.ok(Number.isSafeInteger(featuredId), 'Candidate needs an explicit homepage featured look');
  assert.equal(actual.revision, expected.revision, 'API active revision differs from candidate');
  assert.equal(actual.home?.featured_look_id, featuredId, 'API homepage feature differs from candidate');
  const expectedLook = expected.looks.find(item => item.id === featuredId);
  const actualLook = actual.looks.find(item => item.id === featuredId);
  const asset = expectedLook?.versions?.v2?.asset;
  assert.ok(asset && actualLook, 'Featured look asset is missing');
  assert.equal(actualLook.versions?.v2?.asset?.sha256, asset.sha256, 'API featured asset differs from candidate');
  const publicSnapshot = snapshotCatalog(await (await get('/catalog.js')).text());
  assert.equal(publicSnapshot.revision, expected.revision, 'Static snapshot differs from API revision');
  assert.equal(publicSnapshot.home?.featured_look_id, featuredId, 'Static homepage feature differs from API');
  for (const file of ['index.html', 'app.js', 'product-themes.js', 'product-page.js', 'style.css', 'expressive.css', 'product-themes.css', 'tryon.js', 'tryon.css', 'favicon.svg']) {
    const data = Buffer.from(await (await get('/' + (file === 'index.html' ? '' : file))).arrayBuffer());
    assert.equal(digest(data), digest(fs.readFileSync(path.join(publicRoot, file))), `Public ${file} is stale`);
  }
  assert.ok(typeof actualLook.source_url === 'string', 'No project source URL provided');
  const response = await get(actualLook.source_url);
  assert.match(response.headers.get('content-type') || '', /^image\/webp(?:;|$)/i, 'Source image is not WebP');
  const image = Buffer.from(await response.arrayBuffer());
  assert.equal(image.length, asset.bytes, 'Featured source image byte count differs');
  assert.equal(digest(image), asset.sha256, 'Featured source image hash differs');
  return {
    schema_version: 1, status: 'verified', revision: expected.revision,
    featured_look_id: featuredId, verified_at: new Date().toISOString(),
    source_sha256: asset.sha256, source_bytes: asset.bytes,
    source_verified: true, static_verified: true,
  };
}

export async function runRelease(options, dependencies = {}) {
  const root = path.resolve(options.root || repository);
  const state = privateRoot(options.dataDir, root);
  const origin = originUrl(options.publicUrl);
  assert.match(options.apiUnit, /^yixu-[a-z0-9-]*api(?:\.service)?$/, 'Only an explicitly named owned yixu-*api service can restart');
  const execute = dependencies.execute || execFileSync;
  const head = dependencies.cleanHead ? dependencies.cleanHead(root) : cleanHead(root, execute);
  const releaseLock = acquireLock(state);
  const output = path.join(root, '.yixu-release-' + crypto.randomUUID());
  const live = path.join(root, 'public');
  const backup = path.join(root, '.yixu-previous-' + crypto.randomUUID());
  let swapped = false;
  let backedUp = false;
  try {
    const expected = (dependencies.loadContent || loadContent)(root).catalog;
    execute(process.execPath, ['scripts/check.mjs'], {cwd: root, stdio: 'pipe', timeout: 120000});
    execute(process.execPath, ['scripts/build.mjs', '--output', output], {cwd: root, stdio: 'pipe', timeout: 120000});
    const built = snapshotCatalog(fs.readFileSync(path.join(output, 'catalog.js'), 'utf8'));
    assert.equal(built.revision, expected.revision, 'Build revision changed while staging');
    assert.equal(built.home?.featured_look_id, expected.home?.featured_look_id);
    const currentHead = dependencies.cleanHead ? dependencies.cleanHead(root) : cleanHead(root, execute);
    assert.equal(currentHead, head, 'Commit changed while staging');
    assert.equal((dependencies.loadContent || loadContent)(root).catalog.revision, expected.revision, 'Content changed while staging');
    if (!options.activate) return {status: 'validated', revision: expected.revision, featured_look_id: expected.home?.featured_look_id, git_head: head};
    if (fs.existsSync(live)) {
      assert.ok(fs.lstatSync(live).isDirectory() && !fs.lstatSync(live).isSymbolicLink(), 'Public root must be a real directory');
      fs.renameSync(live, backup);
      backedUp = true;
    }
    fs.renameSync(output, live);
    swapped = true;
    execute('systemctl', [...(options.systemdUser ? ['--user'] : []), 'restart', options.apiUnit], {cwd: root, stdio: 'pipe', timeout: 45000});
    let receipt;
    let lastError;
    const attempts = dependencies.attempts || 20;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        receipt = await verifyPublication({origin, expected, publicRoot: live, fetcher: dependencies.fetcher});
        break;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await (dependencies.sleep || sleep)(1000);
      }
    }
    if (!receipt) throw lastError;
    receipt.git_head = head;
    writeReceipt(state, receipt);
    // A receipt is a record of checks at verified_at, not ongoing uptime monitoring.
    if (backedUp) {
      try { fs.rmSync(backup, {recursive: true}); } catch { /* A retained old static backup does not invalidate delivery. */ }
    }
    return receipt;
  } catch (error) {
    if (swapped) fs.rmSync(live, {recursive: true});
    if (backedUp) fs.renameSync(backup, live);
    if (swapped) {
      const receiptPath = path.join(state, 'publication.json');
      if (fs.existsSync(receiptPath)) fs.copyFileSync(receiptPath, path.join(state, 'publication.previous.json'));
      writeReceipt(state, {schema_version: 1, status: 'activation_failed', checked_at: new Date().toISOString()});
    }
    // Never roll back private content/user databases: an API import may already be active.
    // The offline snapshot is restored; admin labels stale proof as not verified.
    throw error;
  } finally {
    fs.rmSync(output, {recursive: true, force: true});
    releaseLock();
  }
}

export async function watchReleases(options, dependencies = {}) {
  assert.ok(options.activate, 'Watcher requires explicit --activate authorization');
  const root = path.resolve(options.root || repository);
  const state = privateRoot(options.dataDir, root);
  const interval = Number(options.intervalSeconds ?? 5);
  assert.ok(Number.isFinite(interval) && interval >= 5 && interval <= 3600, 'Watch interval must be 5–3600 seconds');
  let attemptedHead = null;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopped) {
      let head;
      let dirty = false;
      try { head = (dependencies.cleanHead || cleanHead)(root); } catch { dirty = true; }
      let verifiedHead;
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(state, 'publication.json'), 'utf8'));
        if (receipt.status === 'verified') verifiedHead = receipt.git_head;
      } catch { /* First opt-in run has no verified receipt. */ }
      if (shouldDeliver({head, dirty, verifiedHead, attemptedHead})) {
        attemptedHead = head;
        try {
          const delivered = await (dependencies.runRelease || runRelease)({...options, root});
          assert.equal(delivered.status, 'verified', 'Watcher requires a verified delivery result');
          attemptedHead = delivered.git_head;
          writeReceipt(state, {status: 'verified', git_head: delivered.git_head, checked_at: new Date().toISOString()}, 'release-watch.json');
        } catch {
          writeReceipt(state, {status: 'failed', git_head: head, checked_at: new Date().toISOString(), reason: 'delivery_failed_manual_review_required'}, 'release-watch.json');
          // One attempt per HEAD; a failed activation never causes restart loops.
        }
      }
      if (dependencies.once) break;
      await (dependencies.sleep || sleep)(interval * 1000);
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

function parseOptions(args) {
  const options = {};
  const values = {'--public-url': 'publicUrl', '--data-dir': 'dataDir', '--api-unit': 'apiUnit', '--interval-seconds': 'intervalSeconds'};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--activate') options.activate = true;
    else if (name === '--systemd-user') options.systemdUser = true;
    else if (name === '--watch') options.watch = true;
    else if (values[name] && args[i + 1] && !args[i + 1].startsWith('--')) options[values[name]] = args[++i];
    else throw new Error(`Unknown or incomplete delivery option: ${name}`);
  }
  assert.ok(options.dataDir && options.publicUrl && options.apiUnit, 'Required: --public-url ORIGIN --data-dir PRIVATE_DIRECTORY --api-unit yixu-...api.service; add --activate to publish, --watch to watch clean committed HEAD changes');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.watch) await watchReleases(options);
    else console.log(JSON.stringify(await runRelease(options)));
  } catch (error) {
    console.error(`Delivery failed: ${error.message}`);
    process.exitCode = 1;
  }
}
