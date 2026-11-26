import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {localFile} from './content-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultModel = 'female-01';
const roleIds = new Map([
  ['女模特', defaultModel], ['女性模特', defaultModel], ['女性角色', defaultModel],
  ['男模特', 'male-01'], ['男性模特', 'male-01'], ['男性角色', 'male-01'],
]);

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw Error('用法：node scripts/resolve-model.mjs [模特编号或名称]');
  const selector = args[0]?.trim() || defaultModel;
  const {models} = JSON.parse(fs.readFileSync(localFile(root, 'content/models.json'), 'utf8'));
  const id = roleIds.get(selector) ?? selector;
  const byId = models.find(model => model.model_id === id);
  const matches = byId ? [byId] : models.filter(model => model.name === selector);
  if (matches.length !== 1 || matches[0].enabled === false) {
    throw Error(`找不到唯一可用模特：${selector}。请使用已登记的模特编号。`);
  }
  const {model_id, name, reference, production_sop} = matches[0];
  const sop = production_sop ?? 'docs/external-agent-sop.md';
  if (typeof sop !== 'string' || !/^docs\/[a-z0-9-]+\.md$/.test(sop)) {
    throw Error('模特制作 SOP 必须是 docs/ 下的 Markdown 文件。');
  }
  localFile(root, sop);
  console.log(JSON.stringify({model_id, name, sop, reference}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
