import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../scripts/content-lib.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'yixu-content-'));
const write = (relative,value) => fs.writeFileSync(path.join(fixture,relative),JSON.stringify(value));
try {
  for(const name of ['content','images-v2','assets','scripts','index.html','app.js','style.css','expressive.css','tryon.js','tryon.css','favicon.svg']) {
    fs.cpSync(path.join(root,name),path.join(fixture,name),{recursive:true});
  }
  const before=loadContent(fixture);
  const nextId=Math.max(...before.catalog.looks.map(look=>look.id))+1;
  const latestDate=before.catalog.batches.map(batch=>batch.publish_date).sort().at(-1)||'2026-11-11';
  const publishDate=new Date(Date.parse(latestDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const batchId=publishDate+'-fixture';
  const checkedAt=publishDate+'T10:00:00+08:00';
  const model=JSON.parse(fs.readFileSync(path.join(fixture,'content/models.json')));
  const second=structuredClone(model.models[0]);
  second.model_id='fixture-model-02';second.name='Synthetic second model';second.reference.asset_id='fixture-model-reference-02';
  model.models.push(second);write('content/models.json',model);
  const photo=before.catalog.looks[0].versions.v2.asset;
  const relative=`assets/looks/${publishDate}/fixture-${nextId}.webp`;
  fs.mkdirSync(path.dirname(path.join(fixture,relative)),{recursive:true});
  fs.copyFileSync(path.join(fixture,photo.file),path.join(fixture,relative));
  const batch={schema_version:1,batch_id:batchId,publish_date:publishDate,timezone:'Asia/Shanghai',title:'Synthetic regression only',
    region:{country:'CN',city:'Fixture city'},research:{checked_at:checkedAt,trend_sources:[
      {url:'https://fashion.example/source-a',published_at:'2026-11-11',summary:'Synthetic source A'},
      {url:'https://street.example/source-b',published_at:'2026-11-10',summary:'Synthetic source B'}],
      weather:{url:'https://weather.example/city',forecast_date:publishDate,checked_at:checkedAt,summary:'Synthetic weather',styling_reason:'Synthetic editorial reasoning'}},
    looks:[{id:nextId,model_id:second.model_id,model_reference_sha256:second.reference.sha256,title:'Synthetic new outfit',category:before.catalog.categoryOrder[0],season:'春秋',description:'Synthetic data, not a published outfit',pieces:[{role:'主体',name:'Synthetic garment'}],tags:['fixture'],mood:'开心',scene:'Synthetic scene',edition:'v2',asset:{...photo,asset_id:`fixture-look-${nextId}-v2-r1`,file:relative},
      shots:Array.from({length:9},(_,i)=>({index:i+1,title:'Synthetic shot '+(i+1),emotion:'开心',pose:'自然站立',framing:'全身'}))}]};
  const batchPath=`content/batches/${batchId}.json`;
  fs.mkdirSync(path.join(fixture,'content/batches'),{recursive:true});
  write(batchPath,batch);
  const after=loadContent(fixture);
  assert.equal(after.catalog.looks.length,before.catalog.looks.length+1);
  const fresh=after.catalog.looks.find(look=>look.id===nextId);
  assert.equal(fresh.model_id,second.model_id);
  assert.equal(fresh.versions.v1,undefined);
  assert.equal(fresh.versions.v2.source_url,relative);
  assert.equal(fresh.versions.v2.shots.length,9);
  assert.equal(after.catalog.displayOrder[0],nextId);
  assert.equal(after.catalog.looks.find(look=>look.id===1).versions.v2.image,before.catalog.looks[0].versions.v2.image);
  assert.equal(loadContent(fixture).catalog.revision,after.catalog.revision,'Same source is deterministic');
  console.log('PASS new daily expressive-only outfit, second model, stable legacy IDs and source URL without CDN');
  const built=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:fixture,encoding:'utf8',timeout:30000});
  assert.equal(built.status,0,built.stderr);
  assert.equal(JSON.parse(built.stdout).outfits,before.catalog.looks.length+1);
  assert.ok(fs.existsSync(path.join(fixture,'public',relative)));
  assert.ok(!fs.existsSync(path.join(fixture,'public/images')));
  assert.ok(fs.readFileSync(path.join(fixture,'public/catalog.js'),'utf8').includes(`"id":${nextId}`));
  console.log('PASS build includes additive resources and v2 snapshot without historical styling');
  for(const [label,mutate] of [
    ['duplicate old ID',b=>{b.looks[0].id=1;}],
    ['missing model',b=>{b.looks[0].model_id='absent';}],
    ['stale base hash',b=>{b.looks[0].model_reference_sha256='0'.repeat(64);}],
    ['changed bytes',b=>{b.looks[0].asset.sha256='0'.repeat(64);}],
    ['private public grid',b=>{b.looks[0].asset.visibility='private';}],
    ['archived styling content',b=>{b.looks[0].edition='v1';}],
    ['missing shot',b=>{b.looks[0].shots.pop();}],
    ['path traversal',b=>{b.looks[0].asset.file='../private.webp';}],
    ['missing research',b=>{b.research.trend_sources=[];}],
  ]) {
    const changed=structuredClone(batch);mutate(changed);write(batchPath,changed);
    assert.throws(()=>loadContent(fixture),undefined,label);
  }
  write(batchPath,batch);
  const assetPath=path.join(fixture,relative),original=fs.readFileSync(assetPath);
  fs.unlinkSync(assetPath);fs.symlinkSync(path.join(fixture,photo.file),assetPath);
  assert.throws(()=>loadContent(fixture),/Symlink/);
  fs.unlinkSync(assetPath);fs.writeFileSync(assetPath,original);
  console.log('PASS content rejects conflicting IDs, stale model/image hashes, private/v1 assets, invalid grids, traversal and symlinks');
} finally {fs.rmSync(fixture,{recursive:true,force:true});}
