import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-catalog-export-'));
try {
 const output=path.join(dir,'catalog.json');
 const r=spawnSync(process.execPath,['scripts/export-catalog.mjs','--output',output],{cwd:root,encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,'catalog export must succeed: '+r.stderr);
 const data=JSON.parse(fs.readFileSync(output,'utf8'));
 assert.equal(data.looks.length,100);
 assert.equal(data.looks[0].id,1);
 assert.equal(data.looks[0].versions.v1,undefined);
 assert.equal(data.looks[0].versions.v2.image,'images-v2/look-001.webp');
 assert.equal(data.looks[0].versions.v2.shots.length,9);
 assert.equal(data.target,100);
 assert.ok(!fs.readFileSync(output,'utf8').includes('window.WARDROBE'));
 assert.ok(data.models.some(model=>model.model_id==='female-01'));
 console.log('PASS exported content is expressive-only JSON with historical IDs and model registry');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
