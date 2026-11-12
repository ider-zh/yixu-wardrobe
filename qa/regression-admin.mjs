import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const require = createRequire(new URL('../admin/package.json', import.meta.url));
const { parseHTML } = require('linkedom');
const root = new URL('../admin/', import.meta.url);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function harness(routes = {}, transport = null) {
  const html = await readFile(new URL('index.html', root), 'utf8').catch(() => '');
  const { document, window } = parseHTML(html);
  assert.ok(document.querySelector('#login-form'), 'actual HTML supplies an accessible administrator login form');
  const { createAdminApp } = await import(new URL('app.mjs', root));
  const requests = [];
  const fetch = async (url, options = {}) => {
    const record = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(record);
    if (transport) return transport(url, options);
    const key = `${options.method || 'GET'} ${url}`;
    assert.ok(routes[key], `unexpected HTTP request: ${key}`);
    const result = routes[key];
    return typeof result === 'function' ? result(record) : json(result);
  };
  const confirmations = [];
  const app = createAdminApp({ document, fetch, confirm: (text) => { confirmations.push(text); return true; } });
  const fire = async (selector, type = 'submit') => {
    const element = document.querySelector(selector);
    assert.ok(element, `rendered target exists: ${selector}`);
    element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
    await app.idle();
  };
  return { document, window, app, requests, routes, fire, confirmations };
}

const emptyOverview = () => ({ visits: 0, look_opens: 0, tryons_total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, result_count: 0, result_bytes: 0, popular_looks: [], recent_jobs: [] });
const emptyContent = () => ({ revision: 'fixture-revision', content_ready: true, import_error: null, look_count: 100, model_count: 1, cdn: { config: { configured: false, provider_id: null }, counts: { queued: 0, uploading: 0, verified: 0, failed: 0, unknown: 0, unconfigured: 101 }, total: 101, bytes: 10000, verified_bytes: 0, last_success: null, jobs: [] } });
const sessionRoutes = () => ({
  'GET /api/admin/content/overview': emptyContent(),
  'GET /api/admin/content/models': { models: [] },
  'GET /api/admin/overview': emptyOverview(),
  'GET /api/admin/results?offset=0&limit=24': { items: [], has_more: false },
  'GET /api/admin/settings': { model: '', api_base: '', proxy_url: '', api_key_configured: false, enabled: false },
  'GET /api/admin/bootstrap': { authenticated: false, csrf_token: 'fixture-prelogin' },
  'POST /api/admin/login': { authenticated: true, csrf_token: 'fixture-authenticated' },
  'POST /api/admin/logout': { authenticated: false },
});
async function login(h) {
  await h.app.start();
  h.document.querySelector('#login-username').value = 'fixture-admin';
  h.document.querySelector('#login-password').value = 'fixture-password-not-a-secret';
  await h.fire('#login-form');
}

test('login submits prelogin CSRF and logout uses rotated token, clears private DOM and reboots', async () => {
  const h = await harness(sessionRoutes());
  await login(h);
  const request = h.requests.find(r => r.url.endsWith('/login'));
  assert.ok(request, 'submitting rendered login makes a real HTTP action');
  assert.deepEqual(request.body, { username: 'fixture-admin', password: 'fixture-password-not-a-secret' });
  assert.equal(request.headers['X-CSRF-Token'], 'fixture-prelogin');
  assert.equal(h.document.querySelector('#login-password').value, '');
  assert.equal(h.document.querySelector('#workspace').hidden, false);
  assert.equal(h.document.querySelector('#login-panel').hidden, true);
  await h.fire('#logout', 'click');
  const logout = h.requests.find(r => r.url.endsWith('/logout'));
  assert.equal(logout.headers['X-CSRF-Token'], 'fixture-authenticated');
  assert.equal(h.document.querySelector('#workspace').hidden, true);
  assert.equal(h.document.querySelector('#login-panel').hidden, false);
  assert.equal(h.requests.at(-1).url, '/api/admin/bootstrap');
});

test('login error remains accessible, never authenticates, and allows a retry', async () => {
  const routes = sessionRoutes();
  routes['POST /api/admin/login'] = () => json({ error: { code: 'invalid_credentials', message: '用户名或密码不正确。' } }, 401);
  const h = await harness(routes);
  await login(h);
  assert.equal(h.document.querySelector('#workspace').hidden, true);
  assert.equal(h.document.querySelector('#error').hidden, false);
  assert.match(h.document.querySelector('#error').textContent, /用户名或密码不正确/);
  assert.equal(h.document.querySelector('#login-form button').disabled, false);
  h.routes['POST /api/admin/login'] = { authenticated: true, csrf_token: 'fixture-retry' };
  h.document.querySelector('#login-password').value = 'fixture-retry-password';
  await h.fire('#login-form');
  assert.equal(h.document.querySelector('#workspace').hidden, false);
  assert.equal(h.document.querySelector('#error').hidden, true);
});

test('authenticated bootstrap renders authoritative analytics and queue; refresh preserves honest zero states', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/bootstrap'] = { authenticated: true, csrf_token: 'fixture-session' };
  routes['GET /api/admin/overview'] = {
    ...emptyOverview(), visits: 37, look_opens: 19, tryons_total: 7, queued: 2, running: 1, succeeded: 3, failed: 1,
    result_count: 3, result_bytes: 2097152, popular_looks: [{ look_id: 8, count: 12 }],
    recent_jobs: [{ id: 'fixture-job', status: 'unknown', look_id: 8, edition: 'v2', shot_index: 2, queue_position: 0, created_at: '2026-11-11T04:00:00Z', error_message: '<script>unsafe</script>' }],
  };
  const h = await harness(routes);
  await h.app.start();
  assert.equal(h.document.querySelector('[data-metric="visits"]')?.textContent, '37');
  for (const [key, value] of Object.entries(routes['GET /api/admin/overview'])) {
    if (typeof value === 'number') assert.equal(h.document.querySelector(`[data-metric="${key}"]`).textContent, key === 'result_bytes' ? '2.00 MiB' : String(value));
  }
  assert.match(h.document.querySelector('#popular-looks').textContent, /8.*12/);
  assert.match(h.document.querySelector('#recent-jobs').textContent, /状态待确认/);
  assert.match(h.document.querySelector('#recent-jobs').textContent, /<script>unsafe<\/script>/);
  assert.equal(h.document.querySelector('#recent-jobs script'), null);
  assert.equal(h.document.querySelector('#recent-jobs img'), null);
  assert.ok(h.document.querySelector('nav[aria-label="管理导航"] a[href="#overview"]'));
  h.routes['GET /api/admin/overview'] = emptyOverview();
  await h.fire('#refresh-overview', 'click');
  assert.equal(h.document.querySelector('[data-metric="visits"]').textContent, '0');
  assert.match(h.document.querySelector('#recent-jobs').textContent, /暂无任务/);
  assert.match(h.document.querySelector('#popular-looks').textContent, /暂无造型访问记录/);
  h.routes['GET /api/admin/bootstrap'] = { authenticated: false, csrf_token: 'fixture-logged-out' };
  await h.fire('#logout', 'click');
  assert.equal(h.document.querySelector('[data-metric="visits"]').textContent, '—');
  assert.equal(h.document.querySelector('#recent-jobs').textContent, '');
});

const result = (id, extra = {}) => ({ id, look_id: 8, edition: 'v2', shot_index: 2, created_at: '2026-11-11T04:00:00Z', image_url: `/api/admin/results/${encodeURIComponent(id)}/image`, review: { verdict: 'unreviewed', notes: '' }, ...extra });
test('results render only protected generated images, paginate with deduplication and report missing previews', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/results?offset=0&limit=24'] = { items: [result('fixture-one'), result('fixture-unsafe', { image_url: 'https://external.invalid/original?token=fixture' })], has_more: true };
  routes['GET /api/admin/results?offset=2&limit=24'] = { items: [result('fixture-one'), result('fixture-three')], has_more: false };
  const h = await harness(routes);
  await login(h);
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 2, 'real result JSON is rendered');
  const image = h.document.querySelector('#results-grid img');
  assert.equal(image.getAttribute('src'), '/api/admin/results/fixture-one/image');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(image.alt, /AI.*8/);
  assert.equal(h.document.querySelectorAll('#results-grid img').length, 1);
  assert.equal(h.document.querySelectorAll('#results-grid [src*="external"],#results-grid [href*="external"],#results-grid [src*="original"]').length, 0);
  assert.match(h.document.querySelector('[data-result-id="fixture-unsafe"]').textContent, /预览不可用/);
  await h.fire('#load-more-results', 'click');
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 3);
  assert.equal(h.document.querySelector('#load-more-results').hidden, true);
  await h.fire('[data-result-id="fixture-one"] img', 'error');
  assert.match(h.document.querySelector('[data-result-id="fixture-one"]').textContent, /图片无法加载/);
  assert.equal(image.getAttribute('src'), null);
  h.routes['GET /api/admin/results?offset=0&limit=24'] = { items: [], has_more: false };
  await h.fire('#refresh-results', 'click');
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 0);
  assert.match(h.document.querySelector('#results-empty').textContent, /暂无生成结果/);
  assert.equal(h.document.querySelector('#results-empty').hidden, false);
  await h.fire('#logout', 'click');
  assert.equal(h.document.querySelector('#results-grid').textContent, '');
});

test('optional quality review posts exact verdict and notes then reads server state; deletion is confirmed and read back', async () => {
  const routes = sessionRoutes();
  let saved = result('fixture-review');
  let deleted = false;
  routes['GET /api/admin/results?offset=0&limit=24'] = () => json({ items: deleted ? [] : [saved], has_more: false });
  routes['POST /api/admin/results/fixture-review/review'] = request => {
    saved = { ...saved, review: request.body };
    return json({ saved: true, review: request.body });
  };
  routes['DELETE /api/admin/results/fixture-review'] = () => { deleted = true; return json({ deleted: true }); };
  const h = await harness(routes);
  await login(h);
  assert.ok(h.document.querySelector('[data-result-id="fixture-review"] form'), 'quality review is an actual optional form');
  h.document.querySelector('[name="verdict"]').querySelector('[value="approved"]').selected = true;
  h.document.querySelector('[name="notes"]').value = '<img src=x onerror=alert(1)> 领口细节自然';
  await h.fire('[data-result-id="fixture-review"] form');
  const review = h.requests.find(r => r.url.endsWith('/review'));
  assert.deepEqual(review.body, { verdict: 'approved', notes: '<img src=x onerror=alert(1)> 领口细节自然' });
  assert.equal(review.headers['X-CSRF-Token'], 'fixture-authenticated');
  assert.equal(h.requests.at(-1).url, '/api/admin/results?offset=0&limit=24');
  assert.equal(h.document.querySelector('[name="verdict"]').value, 'approved');
  assert.equal(h.document.querySelector('[name="notes"]').value, saved.review.notes);
  assert.equal(h.document.querySelectorAll('#results-grid img').length, 1);
  assert.match(h.document.querySelector('#notice').textContent, /评价已保存/);
  await h.fire('[data-action="delete-result"]', 'click');
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /删除.*生成结果/);
  const removal = h.requests.find(r => r.method === 'DELETE');
  assert.equal(removal.url, '/api/admin/results/fixture-review');
  assert.equal(removal.headers['X-CSRF-Token'], 'fixture-authenticated');
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 0);
  assert.ok(h.requests.slice(h.requests.indexOf(removal) + 1).some(r => r.url.startsWith('/api/admin/results?')));
});

test('failed review/deletion preserve visible results and never claim success', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/results?offset=0&limit=24'] = { items: [result('fixture-failure')], has_more: false };
  routes['POST /api/admin/results/fixture-failure/review'] = () => json({ error: { code: 'review_failed', message: '评价尚未保存。' } }, 500);
  routes['DELETE /api/admin/results/fixture-failure'] = () => json({ error: { code: 'delete_failed', message: '删除失败。' } }, 500);
  const h = await harness(routes);
  await login(h);
  await h.fire('[data-result-id="fixture-failure"] form');
  assert.match(h.document.querySelector('#error').textContent, /评价尚未保存/);
  await h.fire('[data-action="delete-result"]', 'click');
  assert.match(h.document.querySelector('#error').textContent, /删除失败/);
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 1);
  assert.equal(h.document.querySelector('[data-action="delete-result"]').disabled, false);
});

test('runtime settings are server-driven, key write-only, and missing provider configuration stays unavailable', async () => {
  const routes = sessionRoutes();
  let settings = { model: 'fixture-model', api_base: 'https://provider.invalid/v1', proxy_url: 'http://127.0.0.1:7890', enabled: true, api_key_configured: false, size: '1024x1536', quality: 'medium', provider_timeout_seconds: 180, api_key: 'fixture-must-never-be-rendered' };
  routes['GET /api/admin/settings'] = () => json(settings);
  routes['PUT /api/admin/settings'] = request => {
    const { api_key, ...patch } = request.body;
    settings = { ...settings, ...patch, api_key_configured: api_key ? true : settings.api_key_configured };
    if (patch.clear_api_key) settings.api_key_configured = false;
    return json(settings);
  };
  const h = await harness(routes);
  await login(h);
  assert.ok(h.document.querySelector('#settings-form'), 'provider runtime configuration has a real form');
  assert.match(h.document.querySelector('#provider-status').textContent, /未配置.*不可用/);
  assert.equal(h.document.querySelector('#provider-model').value, 'fixture-model');
  assert.equal(h.document.querySelector('#provider-key').type, 'password');
  assert.equal(h.document.querySelector('#provider-key').value, '');
  assert.equal(h.document.querySelector('#provider-key').getAttribute('autocomplete'), 'new-password');
  assert.equal(h.document.body.innerHTML.includes('fixture-must-never-be-rendered'), false);
  h.document.querySelector('#provider-model').value = 'fixture-model-updated';
  h.document.querySelector('#provider-key').value = 'fixture-project-key';
  await h.fire('#settings-form');
  const write = h.requests.find(r => r.method === 'PUT');
  assert.ok(write, h.document.querySelector('#error').textContent || 'settings submit must make HTTP PUT');
  assert.deepEqual(write.body, { model: 'fixture-model-updated', api_base: 'https://provider.invalid/v1', proxy_url: 'http://127.0.0.1:7890', enabled: true, api_key: 'fixture-project-key', size: '1024x1536', quality: 'medium', provider_timeout_seconds: 180 });
  assert.equal(write.headers['X-CSRF-Token'], 'fixture-authenticated');
  assert.equal(h.requests.at(-1).url, '/api/admin/settings', 'read back redacted configuration after write');
  assert.equal(h.document.querySelector('#provider-key').value, '');
  assert.match(h.document.querySelector('#provider-status').textContent, /未验证/);
  await h.fire('#settings-form');
  assert.equal(Object.hasOwn(h.requests.filter(r => r.method === 'PUT').at(-1).body, 'api_key'), false, 'blank key leaves existing secret untouched');
  h.document.querySelector('#clear-provider-key').checked = true;
  await h.fire('#settings-form');
  assert.equal(h.requests.filter(r => r.method === 'PUT').at(-1).body.clear_api_key, true);
  assert.match(h.document.querySelector('#provider-status').textContent, /未配置.*不可用/);
  assert.equal(h.document.querySelector('#clear-provider-key').checked, false);
  const names = [...h.document.querySelectorAll('#settings-form input, #settings-form select')].map(el => el.name);
  assert.equal(names.some(name => /quota|budget|captcha|daily|rate_limit|retention|policy|calls/.test(name)), false);
  await h.fire('#logout', 'click');
  assert.equal(h.document.querySelector('#provider-model').value, '');
  assert.equal(h.document.querySelector('#provider-key').value, '');
});

test('password change validates confirmation, submits exact fields and returns to a fresh login', async () => {
  const routes = sessionRoutes();
  routes['POST /api/admin/password'] = { changed: true };
  routes['GET /api/admin/results?offset=0&limit=24'] = { items: [result('fixture-private')], has_more: false };
  const h = await harness(routes);
  await login(h);
  assert.ok(h.document.querySelector('#password-form'), 'account security has an actual form');
  assert.equal(h.document.querySelector('#new-password').getAttribute('autocomplete'), 'new-password');
  assert.equal(h.document.querySelector('#new-password').getAttribute('minlength'), '16');
  h.document.querySelector('#current-password').value = 'fixture-old-password';
  h.document.querySelector('#new-password').value = 'fixture-new-strong-password';
  h.document.querySelector('#confirm-password').value = 'fixture-does-not-match';
  await h.fire('#password-form');
  assert.equal(h.requests.some(r => r.url.endsWith('/password')), false);
  assert.match(h.document.querySelector('#error').textContent, /两次.*不一致/);
  h.document.querySelector('#current-password').value = 'fixture-old-password';
  h.document.querySelector('#new-password').value = 'fixture-new-strong-password';
  h.document.querySelector('#confirm-password').value = 'fixture-new-strong-password';
  await h.fire('#password-form');
  const request = h.requests.find(r => r.url.endsWith('/password'));
  assert.deepEqual(request.body, { current_password: 'fixture-old-password', new_password: 'fixture-new-strong-password' });
  assert.equal(request.headers['X-CSRF-Token'], 'fixture-authenticated');
  assert.equal(h.document.querySelector('#workspace').hidden, true);
  assert.equal(h.document.querySelectorAll('#results-grid img').length, 0);
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(h.document.querySelector(`#${id}`).value, '');
  assert.equal(h.requests.at(-1).url, '/api/admin/bootstrap');
  assert.match(h.document.querySelector('#notice').textContent, /密码已修改.*重新登录/);
});

test('incorrect current password preserves authenticated workspace and shows field validation without a bootstrap or retry', async () => {
  const routes = sessionRoutes();
  routes['POST /api/admin/password'] = () => json({ error: { code: 'current_password', message: 'Current password is incorrect' } }, 403);
  const h = await harness(routes);
  await login(h);
  const bootstraps = h.requests.filter(r => r.url.endsWith('/bootstrap')).length;
  h.document.querySelector('#current-password').value = 'fixture-wrong-password';
  h.document.querySelector('#new-password').value = 'fixture-new-strong-password';
  h.document.querySelector('#confirm-password').value = 'fixture-new-strong-password';
  await h.fire('#password-form');
  assert.equal(h.document.querySelector('#workspace').hidden, false);
  assert.equal(h.document.querySelector('#login-panel').hidden, true);
  assert.match(h.document.querySelector('#error').textContent, /当前密码不正确/);
  assert.equal(h.requests.filter(r => r.url.endsWith('/bootstrap')).length, bootstraps);
  assert.equal(h.requests.filter(r => r.url.endsWith('/password')).length, 1);
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(h.document.querySelector(`#${id}`).value, '');
});

test('expired session purges private photos/settings and obtains fresh prelogin CSRF without replaying mutations', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/results?offset=0&limit=24'] = { items: [result('fixture-expiry')], has_more: false };
  const h = await harness(routes);
  await login(h);
  h.document.querySelector('#provider-key').value = 'fixture-unsaved-key';
  h.routes['GET /api/admin/overview'] = () => json({ error: { code: 'admin_auth', message: 'Session expired' } }, 401);
  await h.fire('#refresh-overview', 'click');
  assert.equal(h.document.querySelector('#workspace').hidden, true);
  assert.equal(h.document.querySelectorAll('#results-grid img').length, 0);
  assert.equal(h.document.querySelector('#provider-key').value, '');
  assert.match(h.document.querySelector('#error').textContent, /会话.*重新登录/);
  assert.equal(h.requests.at(-1).url, '/api/admin/bootstrap');
  h.routes['GET /api/admin/overview'] = emptyOverview();
  h.document.querySelector('#login-password').value = 'fixture-password-again';
  await h.fire('#login-form');
  assert.equal(h.requests.filter(r => r.url.endsWith('/login')).at(-1).headers['X-CSRF-Token'], 'fixture-prelogin');
  assert.equal(h.document.querySelector('#workspace').hidden, false);
});

test('bootstrap network/HTML failures offer accessible reconnect and loading prevents duplicate login', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/bootstrap'] = () => new Response('<html>upstream unavailable</html>', { status: 502 });
  const h = await harness(routes);
  await h.app.start();
  assert.equal(h.document.querySelector('#error').hidden, false);
  assert.match(h.document.querySelector('#error').textContent, /连接|服务|响应/);
  assert.equal(h.document.querySelector('#error').textContent.includes('<html>'), false);
  assert.equal(h.document.querySelector('#login-form button').disabled, true);
  let release;
  h.routes['GET /api/admin/bootstrap'] = () => new Promise(resolve => { release = resolve; });
  const reconnect = h.fire('#reconnect', 'click');
  assert.equal(h.document.querySelector('#main').getAttribute('aria-busy'), 'true');
  assert.equal(h.document.querySelector('#reconnect').disabled, true);
  release(json({ authenticated: false, csrf_token: 'fixture-reconnected' }));
  await reconnect;
  assert.equal(h.document.querySelector('#login-form button').disabled, false);
  assert.equal(h.document.querySelector('#main').getAttribute('aria-busy'), 'false');
  h.routes['POST /api/admin/login'] = () => new Promise(resolve => { release = resolve; });
  h.document.querySelector('#login-username').value = 'fixture-admin';
  h.document.querySelector('#login-password').value = 'fixture-password';
  const submitted = h.fire('#login-form');
  h.document.querySelector('#login-form').dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  assert.equal(h.requests.filter(r => r.url.endsWith('/login')).length, 1);
  release(json({ authenticated: true, csrf_token: 'fixture-after-login' }));
  await submitted;
});

test('independent dashboard sections still load after an overview failure; FastAPI detail is safely readable', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/overview'] = () => json({ detail: [{ loc: ['query', 'offset'], msg: 'Input should be valid' }] }, 422);
  routes['GET /api/admin/results?offset=0&limit=24'] = { items: [result('fixture-independent')], has_more: false };
  const h = await harness(routes);
  await login(h);
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 1);
  assert.match(h.document.querySelector('#error').textContent, /Input should be valid/);
  assert.match(h.document.querySelector('#provider-status').textContent, /未配置/);
});

test('actual document is locally styled with responsive grids, visible keyboard focus and labelled controls', async () => {
  const h = await harness(sessionRoutes());
  await login(h);
  const cssLink = h.document.querySelector('link[rel="stylesheet"]');
  assert.equal(cssLink.getAttribute('href'), './admin.css');
  const css = await readFile(new URL('admin.css', root), 'utf8').catch(() => '');
  const style = h.document.createElement('style');
  style.textContent = css;
  h.document.head.append(style);
  const rules = [...style.sheet.cssRules];
  const hidden = rules.find(rule => rule.selectorText === '[hidden]');
  assert.ok(hidden, 'CSS explicitly preserves hidden authentication panels');
  assert.equal(hidden.style.getPropertyValue('display'), 'none');
  assert.equal(hidden.style.getPropertyPriority('display'), 'important');
  assert.ok(rules.some(rule => rule.selectorText?.includes(':focus-visible')));
  const grid = rules.find(rule => rule.selectorText === '.results-grid');
  assert.equal(grid.style.getPropertyValue('display'), 'grid');
  assert.equal(grid.style.getPropertyValue('grid-template-columns'), 'repeat(3, minmax(0, 1fr))');
  assert.ok(rules.some(rule => rule.conditionText === '(max-width: 640px)' && [...rule.cssRules].some(child => child.selectorText === '.results-grid' && child.style.getPropertyValue('grid-template-columns') === 'minmax(0, 1fr)')));
  for (const control of h.document.querySelectorAll('input, select, textarea')) {
    assert.ok(control.closest('label') || (control.id && h.document.querySelector(`label[for="${control.id}"]`)), `control has an actual accessible label: ${control.id || control.name}`);
  }
  assert.ok(h.document.querySelector('meta[name="viewport"][content*="width=device-width"]'));
  assert.ok(h.document.querySelector('a.skip-link[href="#main"]'));
  assert.match(h.document.querySelector('#provider-summary')?.textContent || '', /未配置.*不可用/);
});

test('rendered login, analytics and logout work over native HTTP with a fixture cookie/CSRF server', async () => {
  // Disposable protocol fixture, not production sample data or a claim of live backend verification.
  let authenticated = false;
  let token = 'fixture-http-prelogin';
  let origin;
  const received = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({ method: request.method, url: request.url, csrf: request.headers['x-csrf-token'], cookie: request.headers.cookie });
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      const send = (data, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
      if (request.url === '/api/admin/bootstrap') {
        response.setHeader('Set-Cookie', 'fixture_admin=session; HttpOnly; SameSite=Strict; Path=/');
        return send({ authenticated, csrf_token: token });
      }
      if (request.method !== 'GET' && (request.headers['x-csrf-token'] !== token || request.headers.origin !== origin || request.headers.cookie !== 'fixture_admin=session')) return send({ error: { code: 'csrf', message: 'Fixture CSRF check failed' } }, 403);
      if (request.url === '/api/admin/login') {
        const data = JSON.parse(body);
        if (data.username !== 'fixture-admin' || data.password !== 'fixture-password-not-a-secret') return send({ error: { code: 'auth', message: 'Fixture credentials invalid' } }, 401);
        authenticated = true; token = 'fixture-http-authenticated';
        return send({ authenticated: true, csrf_token: token });
      }
      if (!authenticated) return send({ error: { code: 'auth', message: 'Fixture login required' } }, 401);
      if (request.url === '/api/admin/content/overview') return send(emptyContent());
      if (request.url === '/api/admin/content/models') return send({ models: [] });
      if (request.url === '/api/admin/overview') return send({ ...emptyOverview(), visits: 42 });
      if (request.url === '/api/admin/results?offset=0&limit=24') return send({ items: [], has_more: false });
      if (request.url === '/api/admin/settings') return send({ model: '', api_base: '', proxy_url: '', api_key_configured: false, enabled: false });
      if (request.url === '/api/admin/logout') { authenticated = false; token = 'fixture-http-next-login'; return send({ authenticated: false }); }
      return send({ error: { code: 'not_found', message: 'Unexpected fixture route' } }, 404);
    } catch { response.statusCode = 500; response.end(JSON.stringify({ error: { code: 'fixture_failure', message: 'Fixture handler failed' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  try {
    const h = await harness({}, async (path, options) => {
      const response = await globalThis.fetch(`${origin}${path}`, { ...options, headers: { ...options.headers, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    });
    await login(h);
    assert.equal(h.document.querySelector('[data-metric="visits"]').textContent, '42');
    assert.equal(h.document.querySelector('#workspace').hidden, false);
    await h.fire('#logout', 'click');
    assert.equal(h.document.querySelector('#workspace').hidden, true);
    assert.equal(received.find(request => request.url.endsWith('/login')).csrf, 'fixture-http-prelogin');
    assert.equal(received.find(request => request.url.endsWith('/logout')).csrf, 'fixture-http-authenticated');
    assert.equal(received.at(-1).url, '/api/admin/bootstrap');
    assert.equal(received.some(request => /original|\/api\/tryons/.test(request.url)), false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a successful deletion refreshes results even when analytics refresh fails', async () => {
  const routes = sessionRoutes();
  let removed = false;
  routes['GET /api/admin/results?offset=0&limit=24'] = () => json({ items: removed ? [] : [result('fixture-delete-overview-failure')], has_more: false });
  routes['DELETE /api/admin/results/fixture-delete-overview-failure'] = () => { removed = true; return json({ deleted: true }); };
  const h = await harness(routes);
  await login(h);
  h.routes['GET /api/admin/overview'] = () => json({ error: { code: 'overview_failed', message: '概览更新失败，请单独刷新概览。' } }, 500);
  await h.fire('[data-action="delete-result"]', 'click');
  assert.equal(h.document.querySelectorAll('#results-grid article').length, 0, 'do not leave a deleted result available for another deletion');
  assert.equal(h.document.querySelector('#results-empty').hidden, false);
  assert.match(h.document.querySelector('#error').textContent, /概览更新失败/);
});

test('private bootstrap shows login without requesting admin data or exposing fixtures', async () => {
  const h = await harness({ 'GET /api/admin/bootstrap': { authenticated: false, csrf_token: 'fixture-prelogin' } });
  await h.app.start();
  assert.equal(h.document.querySelector('#login-panel').hidden, false);
  assert.equal(h.document.querySelector('#workspace').hidden, true);
  assert.equal(h.document.querySelector('#login-password').type, 'password');
  assert.equal(h.document.querySelector('#login-password').getAttribute('autocomplete'), 'current-password');
  assert.equal(h.document.querySelector('#login-username').getAttribute('autocomplete'), 'username');
  assert.equal(h.document.querySelector('#login-form').querySelector('button').disabled, false);
  assert.deepEqual(h.requests.map(r => r.url), ['/api/admin/bootstrap']);
  assert.equal(h.requests[0].credentials, 'same-origin');
  assert.equal(h.requests[0].cache, 'no-store');
  assert.equal(h.document.querySelector('html').lang, 'zh-CN');
  assert.ok(h.document.querySelector('#notice[role="status"][aria-live="polite"]'));
  assert.ok(h.document.querySelector('#error[role="alert"]'));
  assert.ok(h.document.querySelector('script[type="module"][src="./app.mjs"]'));
  assert.equal(h.document.querySelectorAll('script[src^="http"],link[href^="http"],form[action*="signup"]').length, 0);
  assert.match(h.document.body.textContent, /原始照片.*不可/);
});

test('public content observation uses real progress, safe models, scoped retry and purges on logout', async () => {
  const routes = sessionRoutes();
  const data = emptyContent();
  data.cdn.config = { configured: true, provider_id: 'fixture-provider', adapter: 'generic-http-put' };
  data.cdn.total = 4;
  data.cdn.counts = { queued: 0, uploading: 0, verified: 1, failed: 1, unknown: 2, unconfigured: 0 };
  data.cdn.jobs = [
    { id: 1, provider_id: 'fixture-provider', asset_id: 'fixture-look-v2', revision: 'fixture-revision', status: 'failed', attempts: 1, bytes: 1000, error: '<script>fixture error</script>' },
    { id: 2, provider_id: 'fixture-provider', asset_id: 'fixture-unknown', revision: 'fixture-revision', status: 'unknown', attempts: 1, bytes: 1000, remote_id: 'fixture-object' },
    { id: 3, provider_id: 'fixture-provider', asset_id: 'fixture-unrecorded', revision: 'fixture-revision', status: 'unknown', attempts: 1, bytes: 1000 },
  ];
  routes['GET /api/admin/content/overview'] = data;
  routes['GET /api/admin/content/models'] = { models: [
    { model_id: 'female-01', name: '01 号模特', views: ['front', 'side', 'back'], expressive_count: 0, reference: { asset_id: 'fixture-reference', source_url: '/api/admin/content/models/female-01/reference' } },
    { model_id: 'fixture-private-model', name: '无公开预览', views: [], reference: { asset_id: 'fixture-private', source_url: '/api/admin/originals/private.webp' } },
  ] };
  routes['POST /api/admin/content/cdn/jobs/1/retry'] = { queued: true };
  routes['POST /api/admin/content/cdn/jobs/2/verify'] = { verified: false };
  const h = await harness(routes);
  await login(h);
  assert.match(h.document.querySelector('#content-status').textContent, /100 套.*1 位/);
  assert.match(h.document.querySelector('#cdn-progress').textContent, /1 \/ 4 张（25%）/);
  assert.equal(h.document.querySelector('[data-cdn-metric="unknown"]').textContent, '2');
  assert.equal(h.document.querySelectorAll('[data-cdn-retry]').length, 1);
  assert.equal(h.document.querySelectorAll('[data-cdn-verify]').length, 1);
  assert.equal(h.document.querySelector('#cdn-jobs script'), null);
  assert.equal(h.document.querySelectorAll('#models-grid img').length, 1);
  assert.equal(h.document.querySelector('#models-grid img').src, '/api/admin/content/models/female-01/reference');
  assert.match(h.document.querySelector('#models-grid').textContent, /关联生动穿搭：0/);
  await h.fire('[data-cdn-retry="1"]', 'click');
  assert.equal(h.requests.find(r => r.url.endsWith('/jobs/1/retry')).headers['X-CSRF-Token'], 'fixture-authenticated');
  await h.fire('[data-cdn-verify="2"]', 'click');
  assert.match(h.document.querySelector('#notice').textContent, /没有重新上传/);
  await h.fire('#logout', 'click');
  assert.equal(h.document.querySelector('#models-grid').textContent, '');
  assert.equal(h.document.querySelector('#cdn-jobs').textContent, '');
  assert.equal(h.document.querySelector('[data-cdn-metric="verified"]').textContent, '—');
});

test('new content failures remain independent from analytics, results and provider settings', async () => {
  const routes = sessionRoutes();
  routes['GET /api/admin/content/overview'] = () => json({ detail: 'content observation unavailable' }, 503);
  routes['GET /api/admin/content/models'] = () => json({ detail: 'models observation unavailable' }, 503);
  const h = await harness(routes);
  await login(h);
  assert.equal(h.document.querySelector('[data-metric="visits"]').textContent, '0');
  assert.equal(h.document.querySelector('#results-empty').hidden, false);
  assert.match(h.document.querySelector('#provider-status').textContent, /未配置/);
  assert.match(h.document.querySelector('#content-status').textContent, /读取失败/);
  assert.match(h.document.querySelector('#models-status').textContent, /读取失败/);
});
