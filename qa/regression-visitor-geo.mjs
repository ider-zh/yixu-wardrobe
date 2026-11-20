// Real Chromium against a disposable administrator API fixture. No visitor
// records, production credentials, GeoIP network requests or AI calls are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../admin/', import.meta.url));
const emptyOverview = { visits: 0, look_opens: 0, tryons_total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, result_count: 0, result_bytes: 0, popular_looks: [], recent_jobs: [] };
const sampleGeo = () => ({
  database: { status: 'ready', source: 'DB-IP City Lite' }, total_visitors: 4, total_page_views: 9,
  countries: [{ country_code: 'CN', country_name: '中国', visits: 5, visitors: 2 }, { country_code: 'US', country_name: '<img src=x onerror=alert(1)>', visits: 2, visitors: 1 }, { country_code: null, country_name: null, visits: 2, visitors: 1 }],
  china_provinces: [{ region_code: 'SH', region_name: '上海市', visits: 4, visitors: 1 }, { region_code: null, region_name: null, visits: 1, visitors: 1 }],
  recent_visitors: [
    { visitor_id: 'fixture-shanghai', country_code: 'CN', country_name: '中国', region_code: 'SH', region_name: '上海市', status: 'located', first_seen: 1700000000, last_seen: 1700000060, page_views: 4 },
    { visitor_id: '<script>window.geoUnsafe=true</script>', country_code: null, country_name: null, status: 'private', first_seen: 1700000000, last_seen: 1700000060, page_views: 2 },
    { visitor_id: 'fixture-legacy', country_code: null, country_name: null, status: 'legacy', first_seen: 1700000000, last_seen: 1700000060, page_views: 1 },
    { visitor_id: 'fixture-us', country_code: 'US', country_name: '美国', region_name: 'Must not show non-China province', status: 'located', first_seen: 1700000000, last_seen: 1700000060, page_views: 2 },
  ],
});
let geo = sampleGeo(), authenticated = true;
const requested = [];
const server = http.createServer((request, response) => {
  requested.push(request.url);
  response.setHeader('Cache-Control', 'no-store');
  // The dev site's administrator shares its origin under /admin/. Mirror the
  // reverse proxy's trailing-slash redirect; the fixture's root is not an admin.
  if (request.url === '/admin') {
    response.statusCode = 301;
    response.setHeader('Location', '/admin/');
    response.end();
    return;
  }
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/api/admin/bootstrap') return json({ authenticated, csrf_token: 'fixture-csrf' });
  if (request.url === '/api/admin/logout') { authenticated = false; return json({ authenticated: false }); }
  if (request.url === '/api/admin/overview') return json({ ...emptyOverview, ...(geo === undefined ? {} : { visitor_geo: geo }) });
  if (request.url === '/api/admin/content/overview') return json({ content_ready: false, cdn: { config: { configured: false }, counts: {}, jobs: [], total: 0, bytes: 0, verified_bytes: 0 } });
  if (request.url === '/api/admin/content/models') return json({ models: [] });
  if (request.url === '/api/admin/results?offset=0&limit=24') return json({ items: [], has_more: false });
  if (request.url === '/api/admin/settings') return json({ enabled: false, api_key_configured: false });
  const file = { '/admin/': 'index.html', '/admin/admin.css': 'admin.css', '/admin/app.mjs': 'app.mjs' }[request.url];
  if (!file) { response.statusCode = 404; response.end(); return; }
  response.setHeader('Content-Type', { 'index.html': 'text/html; charset=utf-8', 'admin.css': 'text/css', 'app.mjs': 'text/javascript' }[file]);
  response.end(fs.readFileSync(path.join(root, file)));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const redirect = await fetch(origin + '/admin', { redirect: 'manual' });
assert.equal(redirect.status, 301, '/admin is canonicalized by the dev proxy fixture');
assert.equal(redirect.headers.get('location'), '/admin/');
const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome', ...['1255', '1248', '1243'].map(version => path.join(os.homedir(), `.cache/ms-playwright/chromium-${version}/chrome-linux64/chrome`))].filter(Boolean);
const chrome = candidates.find(file => fs.existsSync(file));
assert.ok(chrome, 'Chromium is required; set CHROME_BIN.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yixu-geo-chrome-'));
const browser = spawn(chrome, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let client, socket;
try {
  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chromium readiness: ' + stderr)), 15000);
    browser.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    browser.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const targets = await (await fetch(endpoint.replace('ws:', 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), exceptions = [], browserRequests = [];
  socket.onmessage = message => {
    const item = JSON.parse(message.data);
    if (item.method === 'Runtime.exceptionThrown') exceptions.push(item.params.exceptionDetails);
    if (item.method === 'Network.requestWillBeSent') browserRequests.push({ url: item.params.request.url, type: item.params.type });
    if (item.id && pending.has(item.id)) { const task = pending.get(item.id); pending.delete(item.id); item.error ? task.reject(Error(item.error.message)) : task.resolve(item.result); }
  };
  client = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await client('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const wait = async expression => { for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('DOM condition timed out: ' + expression); };
  const loaded = '!document.getElementById("workspace").hidden && document.getElementById("main").getAttribute("aria-busy")==="false"';
  const refresh = async () => { await evaluate('document.getElementById("refresh-overview").click()'); await wait('document.getElementById("main").getAttribute("aria-busy")==="false"'); };
  await client('Page.enable'); await client('Runtime.enable'); await client('Network.enable');
  for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    geo = sampleGeo();
    await client('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 600 });
    await client('Page.navigate', { url: origin + '/admin' }); await wait('document.readyState === "complete" && ' + loaded);
    assert.equal(await evaluate('location.pathname'), '/admin/', 'Browser follows the canonical /admin/ redirect');
    assert.equal(await evaluate('document.querySelector("script[type=module]").src'), origin + '/admin/app.mjs', 'Relative administrator module loads under /admin/');
    assert.equal(await evaluate('document.querySelector("link[rel=stylesheet]").href'), origin + '/admin/admin.css', 'Relative administrator styles load under /admin/');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".visitor-geo")).borderTopStyle'), 'solid', 'Actual administrator CSS is applied');
    assert.equal(await evaluate('document.querySelector(".brand").href'), origin + '/admin/', 'Brand remains in the same-origin administrator path');
    await evaluate('window.beforeBrandNavigation = true; document.querySelector(".brand").click()');
    await wait('!window.beforeBrandNavigation && document.readyState === "complete" && ' + loaded);
    assert.equal(await evaluate('location.href'), origin + '/admin/', 'Clicking the brand reloads /admin/');
    assert.equal(await evaluate('document.getElementById("visitor-total").textContent'), '4');
    assert.equal(await evaluate('document.getElementById("visitor-page-views").textContent'), '9');
    assert.match(await evaluate('document.getElementById("visitor-geo-status").textContent'), /已就绪/);
    assert.match(await evaluate('document.getElementById("visitor-countries").textContent'), /中国.*5 次访问.*2 个访客/);
    assert.match(await evaluate('document.getElementById("visitor-countries").textContent'), /未知国家/);
    assert.match(await evaluate('document.getElementById("visitor-provinces").textContent'), /上海市.*4 次访问/);
    assert.match(await evaluate('document.getElementById("visitor-provinces").textContent'), /省级未知/);
    const recent = await evaluate('document.getElementById("recent-visitors").textContent');
    assert.match(recent, /中国 · 上海市/); assert.match(recent, /内网或保留地址/); assert.match(recent, /历史记录/); assert.match(recent, /2023/);
    assert.ok(!recent.includes('Must not show non-China province'));
    assert.match(recent, /<script>window.geoUnsafe=true<\/script>/);
    assert.equal(await evaluate('!!document.querySelector(".visitor-geo script,.visitor-geo img") || !!window.geoUnsafe'), false);
    assert.equal(await evaluate('document.querySelector(".visitor-geo a").getAttribute("href")'), 'https://db-ip.com');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'No horizontal overflow at ' + viewport.width);
    if (process.env.YIXU_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.YIXU_SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
      await evaluate('document.querySelector(".visitor-geo").scrollIntoView({block:"start"})');
      const capture = await client('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR, `visitor-geo-${viewport.width}.png`), Buffer.from(capture.data, 'base64'), { mode: 0o600 });
    }
    geo = { database: { status: 'unconfigured' }, total_visitors: 0, total_page_views: 0, countries: [], china_provinces: [], recent_visitors: [] };
    await refresh();
    assert.equal(await evaluate('document.getElementById("visitor-total").textContent'), '0');
    assert.match(await evaluate('document.getElementById("visitor-geo-status").textContent'), /尚未配置/);
    assert.match(await evaluate('document.getElementById("recent-visitors").textContent'), /暂无页面访问/);
    assert.match(await evaluate('document.getElementById("visitor-countries").textContent'), /暂无国家/);
    geo.database.status = 'unavailable'; await refresh();
    assert.match(await evaluate('document.getElementById("visitor-geo-status").textContent'), /暂不可用/);
    geo = undefined; await refresh();
    assert.match(await evaluate('document.getElementById("visitor-geo-status").textContent'), /尚未提供/);
    assert.equal(await evaluate('document.getElementById("visitor-total").textContent'), '—');
    assert.equal(await evaluate('document.getElementById("visitor-countries").textContent'), '');
    assert.equal(await evaluate('document.getElementById("error").hidden'), true);
    console.log(`PASS ${viewport.width}px: /admin redirect, same-origin CSS/module and brand, country/province counts, anonymous visitors, seconds timestamps, private/legacy/unknown states, attribution, text-only rendering, refresh and old API compatibility`);
  }
  geo = sampleGeo(); await refresh();
  await evaluate('document.getElementById("logout").click()');
  await wait('document.getElementById("workspace").hidden && !document.getElementById("login-panel").hidden');
  assert.equal(await evaluate('document.getElementById("recent-visitors").textContent'), '');
  assert.equal(await evaluate('document.getElementById("visitor-total").textContent'), '—');
  assert.deepEqual(exceptions, []);
  assert.ok(requested.includes('/admin/admin.css') && requested.includes('/admin/app.mjs'), 'Real CSS and module assets were requested from /admin/');
  const apiRequests = browserRequests.filter(request => ['Fetch', 'XHR'].includes(request.type));
  assert.ok(apiRequests.length > 0, 'The browser used the administrator API');
  assert.ok(apiRequests.every(request => request.url.startsWith(origin + '/api/admin/')), 'Every administrator API call stays on the same origin at /api/admin/');
  assert.ok(browserRequests.every(request => request.url.startsWith(origin + '/')), 'No runtime third-party IP lookup or legacy admin-domain request');
  assert.ok(!requested.some(url => url.startsWith('/admin/api/') || url === '/admin.css' || url === '/app.mjs'), 'Nested admin assets and APIs never fall back to incorrect root-relative paths');
  console.log('PASS same-origin /api/admin/ requests, nested administrator assets, logout purges private visitor information; no browser exceptions');
} finally {
  if (client && socket?.readyState === 1) await Promise.race([client('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  if (browser.exitCode === null && browser.signalCode === null) { const exit = once(browser, 'exit'); try { process.kill(-browser.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exit; }
  socket?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
