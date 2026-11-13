import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../scripts/content-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(script, cwd = root) {
  const result = spawnSync(process.execPath, [script], {cwd, encoding: 'utf8', timeout: 30000});
  assert.ifError(result.error);
  return result;
}
const build = run('scripts/build.mjs');
assert.equal(build.status, 0, build.stderr);
const content = loadContent(root);
const expected=['index.html','app.js','catalog.js','style.css','expressive.css','product-themes.js','product-page.js','product-themes.css','tryon.js','tryon.css','favicon.svg',...new Set(content.publicAssets.map(asset => asset.file))];
assert.equal(JSON.parse(build.stdout).files, expected.length);
const output = path.join(root, 'public');
const files = fs.readdirSync(output, {recursive: true}).filter(name => fs.statSync(path.join(output, name)).isFile());
assert.equal(files.length, expected.length);
assert.deepEqual([...files].sort(),expected.sort(),'Explicit public allowlist excludes backend/admin/private files');
for(const asset of ['tryon.js','tryon.css','product-themes.js','product-page.js','product-themes.css'])assert.equal(digest(fs.readFileSync(path.join(output,asset))),digest(fs.readFileSync(path.join(root,asset))));
assert.equal(files.filter(name => name.endsWith('.webp')).length, new Set(content.publicAssets.map(asset => asset.file)).size);
assert.ok(!files.some(name => name.startsWith('images/')), 'Archived styling must not enter public output');
const snapshot = fs.readFileSync(path.join(output,'catalog.js'),'utf8');
assert.ok(!snapshot.includes('"v1"') && !snapshot.includes('"images/'), 'Offline public snapshot contains expressive content only');
assert.ok(!files.some(name => /\.(?:png|jpe?g)$/i.test(name)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'image-manifest-all.json'), 'utf8'));
for (const photo of content.publicAssets) {
  assert.equal(digest(fs.readFileSync(path.join(output, photo.file))), photo.sha256);
}
assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /浙ICP备2026098002号/);
console.log('PASS static output contains only allowlisted expressive assets, public model references and the ICP footer');

// Candidate builds must not overwrite arbitrary nonempty directories or replace
// the currently served output before an explicit activation.
const buildScratch=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-build-'));
try {
  const candidate=path.join(buildScratch,'candidate');
  const staged=spawnSync(process.execPath,['scripts/build.mjs','--output',candidate],{cwd:root,encoding:'utf8'});
  assert.equal(staged.status,0,staged.stderr);
  const original=fs.readFileSync(path.join(candidate,'catalog.js'));
  const rejected=spawnSync(process.execPath,['scripts/build.mjs','--output',candidate],{cwd:root,encoding:'utf8'});
  assert.notEqual(rejected.status,0,'Nonempty explicit output must be rejected');
  assert.deepEqual(fs.readFileSync(path.join(candidate,'catalog.js')),original);
  assert.deepEqual(fs.readFileSync(path.join(output,'catalog.js')),original,'Staging must not replace served output');
} finally {fs.rmSync(buildScratch,{recursive:true,force:true});}

// Exercise the actual validation CLI in an isolated copy, never mutate source.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yixu-assets-'));
try {
  for (const name of ['scripts', 'content', 'backend', 'deploy', 'images', 'images-v2', 'assets', 'docs', 'catalog.js', 'app.js', 'index.html', 'style.css', 'expressive.css','product-themes.js','product-page.js','product-themes.css', 'tryon.js', 'tryon.css', 'favicon.svg', 'README.md', 'README.en.md', 'DEVELOPMENT.md', 'AGENTS.md', 'image-manifest-all.json']) {
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
  const tryonFile=path.join(fixture,'tryon.js');
  const source=fs.readFileSync(tryonFile,'utf8');
  for(const [name,change] of [['missing try-on UI target',"\n$('nonexistent-tryon-target');\n"],['broken try-on JavaScript','\nconst = ;\n']]){
    fs.writeFileSync(tryonFile,source+change);
    const rejected=run('scripts/check.mjs',fixture);
    assert.notEqual(rejected.status,0,'Validator must reject '+name);
    fs.writeFileSync(tryonFile,source);
    console.log('PASS validator rejects '+name);
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
  for (const name of ['images/look-001.webp', 'images-v2/look-100.webp', 'assets/model-bases/female-01.webp']) {
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
console.log('Asset regression: 8 checks passed.');
