import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadContent, publicationProjection} from '../scripts/content-lib.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'yixu-content-'));
const write = (relative,value) => fs.writeFileSync(path.join(fixture,relative),JSON.stringify(value));
try {
  for(const name of ['site-resources.json','site-theme.js','site-theme.css','admin','content','images-v2','assets','scripts','index.html','app.js','style.css','expressive.css','product-themes.js','product-page.js','product-themes.css','tryon.js','tryon.css','favicon.svg']) {
    fs.cpSync(path.join(root,name),path.join(fixture,name),{recursive:true});
  }
  const validProducts=fs.readFileSync(path.join(fixture,'content/products.json'),'utf8');
  for(const mutate of [
    value=>value.products.push(structuredClone(value.products[0])),
    value=>value.products[0].appearances[0].reference_asset_id='stale-reference',
    value=>value.products[0].appearances[0].piece_index=999,
    value=>value.products[0].asset.visibility='private',
    value=>value.products[0].asset.sha256='0'.repeat(64),
    value=>value.products.find(p=>p.gallery?.length).gallery[0].asset.visibility='private',
    value=>value.products.find(p=>p.gallery?.length).gallery[0].asset.sha256='0'.repeat(64),
    value=>{const p=value.products.find(p=>p.gallery?.length);p.gallery[0].asset=structuredClone(p.asset);},
    value=>value.products.find(p=>p.gallery?.length).gallery[0].caption='',
    value=>{value.products[0].gallery=null;},
    value=>value.products.find(p=>p.gallery?.length).gallery[0].role='unknown',
    value=>value.products.find(p=>p.gallery?.length).gallery[0].design_study='false',
    value=>{value.products[0].presentation={theme:'../../private'};},
    value=>{value.products[0].presentation={theme:'studio',style:'external.css'};},
    value=>{value.products[0].copy={hero_title:42};},
    value=>{value.products[0].copy={details_title:'   '};},
    value=>{value.products[0].copy={html:'<script>evil()</script>'};},
  ]){const invalid=JSON.parse(validProducts);mutate(invalid);write('content/products.json',invalid);assert.throws(()=>loadContent(fixture));}
  fs.writeFileSync(path.join(fixture,'content/products.json'),validProducts);
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
  assert.equal(after.catalog.latestOrder[0],nextId);
  assert.equal(after.catalog.home.featured_look_id,nextId);
  assert.equal(after.catalog.home.latest_batch_id,batchId);
  assert.equal(after.catalog.home.recent_look_ids.length,6);
  assert.ok(!after.catalog.home.recent_look_ids.includes(nextId));
  assert.equal(fresh.published_at,new Date(publishDate+'T00:00:00+08:00').toISOString());
  assert.deepEqual(publicationProjection([],[],[]).home,{featured_look_id:null,recent_look_ids:[],latest_batch_id:null});
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
    ['naive publication timestamp',b=>{b.published_at=b.publish_date+'T09:00:00';}],
    ['publication date mismatch',b=>{b.published_at=b.publish_date+'T23:00:00Z';}],
    ['cover outside batch',b=>{b.cover_look_id=1;}],
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

  // Isolate the synthetic revision from revisions and product links in the release corpus.
  const revisionPath = 'content/look-revisions.json';
  for (const file of [revisionPath, 'content/products.json']) {
    fs.rmSync(path.join(fixture, file), {force:true});
  }
  const unrevised = loadContent(fixture);
  const historical = unrevised.catalog.looks.find(look => look.id === 1);
  const originalAsset = historical.versions.v2.asset;
  const otherAsset = unrevised.catalog.looks.find(look => look.id === 2).versions.v2.asset;
  const newFile = 'assets/looks/revision-fixture/look-001-v2-test.webp';
  fs.mkdirSync(path.dirname(path.join(fixture, newFile)), {recursive:true});
  fs.copyFileSync(path.join(fixture, otherAsset.file), path.join(fixture, newFile));
  const fixtureRevision = {
    look_id:1, replaces_asset_id:originalAsset.asset_id, model_id:second.model_id,
    model_reference_sha256:second.reference.sha256,
    asset:{...otherAsset, asset_id:'fixture-look-001-v2-revised', file:newFile},
    shots:structuredClone(batch.looks[0].shots), story:'Synthetic revised story',
    summary:'Synthetic revised summary', moods:['开心'],
  };
  const revisionManifest = {schema_version:1, revisions:[fixtureRevision]};
  const linkedProduct = {
    ...JSON.parse(validProducts).products[0],
    appearances:[{look_id:1, piece_index:1, reference_asset_id:fixtureRevision.asset.asset_id, shot_index:1}],
  };
  write(revisionPath, revisionManifest);
  const revised = loadContent(fixture);
  const revisedLook = revised.catalog.looks.find(look => look.id === 1);
  assert.equal(revisedLook.model_id, second.model_id);
  assert.equal(revisedLook.source_url, newFile);
  assert.equal(revisedLook.versions.v2.asset.asset_id, fixtureRevision.asset.asset_id);
  assert.equal(revisedLook.versions.v2.story, fixtureRevision.story);
  assert.deepEqual(revisedLook.versions.v2.shots, fixtureRevision.shots);
  assert.deepEqual(revisedLook.pieces, historical.pieces);
  assert.equal(revisedLook.published_at, null);
  assert.equal(revisedLook.versions.v1, undefined);
  assert.equal(revised.catalog.looks.length, unrevised.catalog.looks.length);
  assert.deepEqual(revised.catalog.displayOrder, unrevised.catalog.displayOrder);
  assert.deepEqual(revised.catalog.latestOrder, unrevised.catalog.latestOrder);
  assert.deepEqual(revised.catalog.home, unrevised.catalog.home);
  assert.notEqual(revised.catalog.revision, unrevised.catalog.revision);
  assert.ok(revised.publicAssets.some(asset => asset.asset_id === originalAsset.asset_id));
  assert.ok(revised.publicAssets.some(asset => asset.asset_id === fixtureRevision.asset.asset_id));
  write('content/products.json', {schema_version:1, products:[linkedProduct]});
  assert.deepEqual(loadContent(fixture).catalog.products[0].appearances, linkedProduct.appearances);
  const builtRevision = spawnSync(process.execPath, ['scripts/build.mjs'], {cwd:fixture, encoding:'utf8', timeout:30000});
  assert.equal(builtRevision.status, 0, builtRevision.stderr);
  const publicCatalogPath = path.join(fixture, 'public/catalog.js');
  const publicCatalog = fs.readFileSync(publicCatalogPath, 'utf8');
  assert.ok(fs.existsSync(path.join(fixture, 'public', originalAsset.file)));
  assert.ok(fs.existsSync(path.join(fixture, 'public', newFile)));
  linkedProduct.appearances[0].reference_asset_id = originalAsset.asset_id;
  write('content/products.json', {schema_version:1, products:[linkedProduct]});
  assert.throws(() => loadContent(fixture), /product appearance/);
  linkedProduct.appearances[0].reference_asset_id = fixtureRevision.asset.asset_id;
  write('content/products.json', {schema_version:1, products:[linkedProduct]});
  for (const [label, mutate] of [
    ['duplicate revision', m => m.revisions.push(structuredClone(m.revisions[0]))],
    ['non-historical ID', m => m.revisions[0].look_id = nextId],
    ['wrong original ID', m => m.revisions[0].replaces_asset_id = 'wrong-original'],
    ['rewritten original image', m => m.revisions[0].asset.sha256 = originalAsset.sha256],
    ['stale model', m => m.revisions[0].model_reference_sha256 = '0'.repeat(64)],
    ['private revision image', m => m.revisions[0].asset.visibility = 'private'],
    ['missing shot', m => m.revisions[0].shots.pop()],
    ['misordered shot', m => m.revisions[0].shots[1].index = 1],
    ['blank emotion', m => m.revisions[0].shots[0].emotion = ' '],
    ['added date', m => m.revisions[0].publish_date = publishDate],
  ]) {
    const invalid = structuredClone(revisionManifest);
    mutate(invalid);
    write(revisionPath, invalid);
    assert.throws(() => loadContent(fixture), undefined, label);
  }
  const invalidBuild = spawnSync(process.execPath, ['scripts/build.mjs'], {cwd:fixture, encoding:'utf8', timeout:30000});
  assert.notEqual(invalidBuild.status, 0);
  assert.equal(fs.readFileSync(publicCatalogPath, 'utf8'), publicCatalog);
  console.log('PASS historical revision retains original assets and homepage order, requires current product links, and rejects invalid builds atomically');
} finally {fs.rmSync(fixture,{recursive:true,force:true});}
