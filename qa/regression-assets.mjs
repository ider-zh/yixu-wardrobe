import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(script, cwd = root) {
  const result = spawnSync(process.execPath, [script], {cwd, encoding: 'utf8', timeout: 30000});
  assert.ifError(result.error);
  return result;
}
const build = run('scripts/build.mjs');
assert.equal(build.status, 0, build.stderr);
assert.equal(JSON.parse(build.stdout).files, 206);
const output = path.join(root, 'public');
const files = fs.readdirSync(output, {recursive: true}).filter(name => fs.statSync(path.join(output, name)).isFile());
assert.equal(files.length, 206);
assert.equal(files.filter(name => name.endsWith('.webp')).length, 200);
assert.ok(!files.some(name => /\.(?:png|jpe?g)$/i.test(name)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'image-manifest-all.json'), 'utf8'));
for (const photo of [...manifest.v1, ...manifest.v2]) {
  assert.equal(digest(fs.readFileSync(path.join(output, photo.file))), photo.sha256);
}
assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /浙ICP备2026098002号/);
console.log('PASS static output contains 200 matching WebP files and the ICP footer');

// Exercise the actual validation CLI in an isolated copy, never mutate source.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yixu-assets-'));
try {
  for (const name of ['scripts', 'images', 'images-v2', 'docs', 'catalog.js', 'app.js', 'index.html', 'style.css', 'expressive.css', 'favicon.svg', 'README.md', 'README.en.md', 'DEVELOPMENT.md', 'AGENTS.md', 'image-manifest-all.json']) {
    fs.cpSync(path.join(root, name), path.join(fixture, name), {recursive: true});
  }
  const control = run('scripts/check.mjs', fixture);
  assert.equal(control.status, 0, control.stderr);
  const file = path.join(fixture, manifest.v1[0].file);
  const original = fs.readFileSync(file);
  const manifestFile = path.join(fixture, 'image-manifest-all.json');
  const originalManifest = fs.readFileSync(manifestFile);
  for (const [name, mutate, rehash] of [
    ['wrong WebP signature', bytes => { bytes[0] = 0; }, true],
    ['wrong RIFF length', bytes => { bytes.writeUInt32LE(1, 4); }, true],
    ['wrong frame dimensions', bytes => { bytes.writeUInt16LE(1, 26); }, true],
    ['changed payload SHA-256', bytes => { bytes[bytes.length - 2] ^= 1; }, false]
  ]) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    fs.writeFileSync(file, bytes);
    const changed = JSON.parse(originalManifest);
    if (rehash) changed.v1[0].sha256 = digest(bytes);
    fs.writeFileSync(manifestFile, JSON.stringify(changed));
    const rejected = run('scripts/check.mjs', fixture);
    assert.notEqual(rejected.status, 0, `Must reject ${name}`);
    assert.match(rejected.stderr, /AssertionError/);
    fs.writeFileSync(file, original);
    fs.writeFileSync(manifestFile, originalManifest);
    console.log('PASS validator rejects ' + name);
  }
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}

const server = spawn(process.execPath, ['serve.mjs'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview server readiness timeout')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Preview server exited: ' + code)); });
  });
  for (const name of ['images/look-001.webp', 'images-v2/look-100.webp']) {
    const response = await fetch('http://127.0.0.1:4219/' + name, {signal: AbortSignal.timeout(10000)});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(fs.readFileSync(path.join(root, name))));
  }
  console.log('PASS HTTP preview serves real WebP bytes with image/webp MIME type');
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
}
console.log('Asset regression: 6 checks passed.');
