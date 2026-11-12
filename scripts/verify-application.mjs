// Called by the existing GitHub Actions gallery entry point; no deployment or paid calls.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'yixu-verify-'));
const env = {...process.env, YIXU_VERIFY_CHILD: '1'};
function run(command, args) {
  console.log(`[verify] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {cwd: root, env, stdio: 'inherit', timeout: 180000});
  if (result.error || result.status !== 0) throw new Error(`Verification failed: ${command} (${result.error?.message || result.signal || result.status})`);
}
try {
  let uv = 'uv';
  if (spawnSync(uv, ['--version'], {stdio: 'ignore'}).status !== 0) {
    const tools = path.join(privateRoot, 'tools');
    run('python3', ['-m', 'venv', tools]);
    run(path.join(tools, 'bin/python'), ['-m', 'pip', 'install', 'uv==0.13.6']);
    uv = path.join(tools, 'bin/uv');
  }
  if (!env.YIXU_TEST_FACE_MODEL) {
    const response = await fetch('https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet/face_detection_yunet_2023mar.onnx', {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Official detector download failed: ${response.status}`);
    const model = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(model).digest('hex') !== '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4') throw new Error('Official detector hash mismatch');
    env.YIXU_TEST_FACE_MODEL = path.join(privateRoot, 'yunet.onnx');
    fs.writeFileSync(env.YIXU_TEST_FACE_MODEL, model, {mode: 0o600});
  }
  run(uv, ['sync', '--locked']);
  run(uv, ['run', '--locked', 'pytest', 'tests/backend', '-q']);
  run(uv, ['run', '--locked', 'ruff', 'check', 'backend', 'tests/backend']);
  run(uv, ['run', '--locked', 'ruff', 'format', '--check', 'backend', 'tests/backend']);
  run(uv, ['run', '--locked', 'mypy', 'backend']);
  run('npm', ['ci', '--prefix', 'admin', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(process.execPath, ['qa/regression-tryon.mjs']);
  run(process.execPath, ['--test', 'qa/regression-admin.mjs']);
  run(process.execPath, ['qa/regression-integration.mjs']);
  run(process.execPath, ['qa/regression-catalog-export.mjs']);
  run(process.execPath, ['qa/regression-content.mjs']);
  run(process.execPath, ['qa/regression-homepage.mjs']);
  run(process.execPath, ['--test', 'qa/regression-release.mjs']);
  run(process.execPath, ['qa/regression-deploy.mjs']);
  console.log('YIXU full application verification passed');
} finally {
  fs.rmSync(privateRoot, {recursive: true, force: true});
}
