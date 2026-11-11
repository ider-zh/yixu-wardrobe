import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const run = spawnSync(process.execPath, ['qa/regression-expressive.mjs'], {
  cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 240000,
  env: {...process.env, GITHUB_ACTIONS: 'true'}, maxBuffer: 8 * 1024 * 1024,
});
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
assert.equal(run.status, 0, 'The existing CI entry point must execute successfully');
assert.match(run.stdout, /\d+ passed in /, 'CI must run actual backend tests');
assert.ok(Number(run.stdout.match(/# pass (\d+)\b/)?.[1]) >= 15, 'CI must run the management HTTP/DOM regression');
assert.match(run.stdout, /YIXU full application verification passed/, 'All application suites must complete');
console.log('PASS existing CI entry point executes backend, browser, admin and deployment checks');
