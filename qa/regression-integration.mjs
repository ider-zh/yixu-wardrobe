import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdminApp } from '../admin/app.mjs';

// Actual frontend event handlers -> real create_app routes. Disposable SQLite,
// default unconfigured provider, no worker, network, photos or fake generations.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../admin/package.json', import.meta.url));
const { parseHTML } = require('linkedom');
const wait = async predicate => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Frontend did not reach expected state');
};
async function bridge(t, admin = false) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'yixu-ui-'));
  const child = spawn(process.env.UI_BRIDGE_PYTHON || path.join(root, '.venv/bin/python'), ['tests/ui_bridge.py', dir], {
    cwd: root, env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = [];
  // Do not echo raw Python stderr, cookies, CSRF, passwords or request bodies.
  child.stderr.resume();
  child.on('error', () => { while (pending.length) pending.shift().reject(Error('ASGI bridge could not start')); });
  child.on('exit', () => { while (pending.length) pending.shift().reject(Error('ASGI bridge exited')); });
  createInterface({ input: child.stdout }).on('line', line => {
    const next = pending.shift();
    if (next) { try { next.resolve(JSON.parse(line)); } catch { next.reject(Error('Invalid bridge response')); } }
  });
  const rpc = data => new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(data) + '\n');
  });
  t.after(async () => {
    const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : null;
    child.stdin.end();
    if (exited) await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const origin = admin ? 'https://admin.localhost' : 'https://localhost';
  const fetch = async (url, options = {}) => {
    const r = await rpc({ path: origin + url, method: options.method || 'GET', headers: { Origin: origin, ...options.headers }, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    calls.push({ path: url, method: options.method || 'GET', status: r.status, code: r.body.error?.code });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { dir, rpc, fetch, calls };
}
async function publicUI(t) {
  const b = await bridge(t);
  const { document, window } = parseHTML(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  const timers = new Set();
  const schedule = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  t.after(() => { for (const id of timers) clearTimeout(id); });
  window.WARDROBE = { looks: [{ id: 1, title: 'Disposable UI test', versions: Object.fromEntries(['v1', 'v2'].map(v => [v, { image: '', shots: Array.from({ length: 9 }, () => ({ title: 'test' })) }])) }] };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'tryon.js'), 'utf8'), {
    document, window, location: { protocol: 'https:' }, fetch: b.fetch, crypto: { randomUUID }, URL, FormData,
    setTimeout: schedule, clearTimeout, queueMicrotask, confirm: () => true,
  });
  const $ = id => document.getElementById(id);
  await wait(() => $('tryon-jobs-status').textContent.includes('进度已更新'));
  await b.rpc({ control: 'seed_history' });
  $('tryon-refresh').click();
  await wait(() => document.querySelector('[data-job-id]'));
  return { ...b, document, window, $ };
}

test('photo try-on copy stays brief before and after real API bootstrap', async t => {
  const staticDOM = parseHTML(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).document;
  const purpose = '照片交由第三方 AI 生成试穿图，结果可供后台评估。';
  const assertBriefCopy = document => {
    assert.match(document.getElementById('detail-tryon').textContent, /^拍照试穿/);
    assert.equal(document.getElementById('tryon-title').textContent, '拍照试穿');
    assert.equal(document.getElementById('tryon-disclosure-title').textContent, '照片用途');
    assert.deepEqual([...document.querySelectorAll('#tryon-disclosure li')].map(li => li.textContent), [purpose], 'One purpose notice, not static/API duplicates');
    assert.match(document.getElementById('tryon-consent-label').textContent, /本人同意.*同意上述用途/);
    assert.doesNotMatch(document.getElementById('tryon-dialog').textContent, /1 小时|一小时|1000|FIFO|持久队列|Cookie|CSRF|幂等|服务器|输入最晚保留至/);
  };
  assertBriefCopy(staticDOM);
  assert.equal(Boolean(staticDOM.getElementById('tryon-consent').checked), false);
  const h = await publicUI(t);
  assertBriefCopy(h.document);
  assert.equal(Boolean(h.$('tryon-consent').checked), false, 'Bootstrap cannot grant consent');
  assert.equal(h.$('tryon-submit').disabled, true, 'No photo/consent means no submission');
  assert.match(h.$('tryon-jobs-status').textContent, /^进度已更新。/);
  const disclosure = (await h.rpc({ path: 'https://localhost/api/bootstrap' })).body.disclosure;
  assert.equal(disclosure.accepted, false);
  assert.deepEqual(disclosure.items, [purpose]);
  h.$('tryon-refresh').click();
  await wait(() => !h.$('tryon-refresh').disabled);
  assertBriefCopy(h.document);
  assert.match(h.$('tryon-jobs-status').textContent, /访问凭证.*无法恢复/);
  assert.equal(h.calls.filter(c => c.method === 'POST' && c.path === '/api/tryons').length, 0);
});

test('cookie loss: explicit refresh renews bootstrap, clears private/consent/photo state and cannot recover old history', async t => {
  const h = await publicUI(t);
  const bootstraps=h.calls.filter(c => c.path === '/api/bootstrap').length;
  h.$('tryon-consent').checked = true;
  h.$('tryon-local-preview').src = 'blob:stale-local-only';
  await h.rpc({ control: 'clear_cookie' });
  h.$('tryon-refresh').click();
  await wait(() => !h.$('tryon-refresh').disabled);
  if (h.calls.filter(c => c.path === '/api/bootstrap').length === bootstraps) {
    h.$('tryon-refresh').click();
    await wait(() => !h.$('tryon-refresh').disabled);
  }
  assert.equal(h.calls.filter(c => c.path === '/api/bootstrap').length, bootstraps+1, 'explicit refresh must renew stale visitor bootstrap');
  assert.equal(Boolean(h.document.querySelector('[data-job-id]')), false);
  assert.equal(h.$('tryon-consent').checked, false);
  assert.equal(h.$('tryon-local-preview').hasAttribute('src'), false);
  assert.equal(h.$('tryon-consent-label').hidden, false);
  assert.match(h.$('tryon-jobs-status').textContent, /访问凭证.*无法恢复/);
  assert.equal(h.calls.filter(c => c.method === 'POST' && c.path === '/api/tryons').length, 0);
});

test('CSRF change: failed real DELETE clears stale state, explicit reconnect renews token without replaying mutation', async t => {
  const h = await publicUI(t);
  const bootstraps=h.calls.filter(c => c.path === '/api/bootstrap').length;
  await h.rpc({ control: 'rotate_csrf' });
  h.$('tryon-consent').checked = true;
  h.document.querySelector('[data-job-delete]').click();
  await wait(() => h.calls.some(c => c.method === 'DELETE'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.find(c => c.method === 'DELETE').status, 403);
  assert.equal(Boolean(h.document.querySelector('[data-job-id]')), false, 'auth failure clears stale private cards');
  assert.equal(h.$('tryon-consent').checked, false);
  assert.equal(h.calls.filter(c => c.path === '/api/bootstrap').length, bootstraps, 'failure itself must not silently reconnect/replay');
  h.$('tryon-refresh').click();
  await wait(() => h.calls.filter(c => c.path === '/api/bootstrap').length === bootstraps+1 && !h.$('tryon-refresh').disabled);
  await wait(() => h.document.querySelector('[data-job-id]'));
  assert.equal(h.calls.filter(c => c.method === 'DELETE').length, 1, 'reconnect does not retry deletion');
  assert.equal(h.calls.filter(c => c.method === 'POST' && c.path === '/api/tryons').length, 0);
  assert.doesNotMatch(h.document.querySelector('[data-job-delete]').textContent, /删除记录/);
  h.document.querySelector('[data-job-delete]').click();
  await wait(() => h.calls.filter(c => c.method === 'DELETE').length === 2);
  assert.equal(h.calls.filter(c => c.method === 'DELETE').at(-1).status, 200, 'explicit new action uses renewed CSRF');
  await wait(() => !h.$('tryon-refresh').disabled);
  assert.ok(h.document.querySelector('[data-job-id]'), 'cancel/delete does not hide history');
});

async function adminUI(t) {
  const b = await bridge(t, true);
  const { document, window } = parseHTML(fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8'));
  const app = createAdminApp({ document, fetch: b.fetch, confirm: () => true });
  const $ = id => document.getElementById(id);
  const fire = async id => { $(id).dispatchEvent(new window.Event('submit', { cancelable: true })); await app.idle(); };
  await app.start();
  const credentials = JSON.parse(fs.readFileSync(path.join(b.dir, 'initial-admin.json')));
  $('login-username').value = credentials.username;
  $('login-password').value = credentials.password;
  await fire('login-form');
  assert.equal($('workspace').hidden, false);
  const password = async () => {
    $('current-password').value = 'incorrect-disposable-current-password';
    $('new-password').value = $('confirm-password').value = 'disposable-new-' + randomUUID();
    await fire('password-form');
  };
  return { ...b, $, app, password };
}
test('wrong current admin password is a real validation error and preserves authenticated dashboard', async t => {
  const h = await adminUI(t);
  const visits = h.$('recent-jobs').textContent;
  await h.password();
  assert.equal(h.$('workspace').hidden, false, 'incorrect current password must not log out a valid session');
  assert.equal(h.$('login-panel').hidden, true);
  assert.equal(h.$('error').hidden, false);
  assert.match(h.$('error').textContent, /当前密码不正确/);
  assert.doesNotMatch(h.$('error').textContent, /会话已失效/);
  assert.equal(h.$('recent-jobs').textContent, visits);
  assert.equal((await h.rpc({ path: 'https://admin.localhost/api/admin/bootstrap' })).body.authenticated, true);
  assert.equal(h.calls.filter(c => c.path === '/api/admin/password').length, 1);
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(h.$(id).value, '');
});
test('revoked admin session on password operation clears private dashboard and returns to fresh login', async t => {
  const h = await adminUI(t);
  h.$('provider-key').value = 'unsaved-disposable-value';
  await h.rpc({ control: 'revoke_admin' });
  await h.password();
  assert.equal(h.$('workspace').hidden, true);
  assert.equal(h.$('login-panel').hidden, false);
  assert.equal(h.$('recent-jobs').textContent, '');
  assert.equal(h.$('provider-key').value, '');
  assert.equal(h.$('provider-model').value, '');
  assert.match(h.$('error').textContent, /会话.*重新登录/);
  assert.equal(h.calls.find(c => c.path === '/api/admin/password').status, 401);
  assert.equal(h.calls.filter(c => c.path === '/api/admin/password').length, 1);
  assert.equal(h.$('login-form').querySelector('button').disabled, false);
});
