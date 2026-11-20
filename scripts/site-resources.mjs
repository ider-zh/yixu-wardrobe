// One source contract for builds and both publication verifiers; no runtime URLs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export function readSiteResources(root){
 const manifest=path.join(root,'site-resources.json');
 assert.ok(!fs.lstatSync(manifest).isSymbolicLink()&&fs.lstatSync(manifest).isFile(),'Shell manifest must be a regular local file');
 const admin=path.join(root,'admin');assert.ok(!fs.lstatSync(admin).isSymbolicLink()&&fs.lstatSync(admin).isDirectory(),'Admin shell directory must not be a symlink');
 const value=JSON.parse(fs.readFileSync(manifest,'utf8'));
 assert.equal(value.schema_version,1,'Unsupported static resource contract');
 assert.deepEqual(Object.keys(value).sort(),['admin','public','schema_version']);
 for(const group of ['public','admin']){
  const names=value[group];assert.ok(Array.isArray(names)&&names.length>0&&names.length<=50,'Invalid static resource list');
  assert.equal(new Set(names).size,names.length,'Duplicate static resource');
  for(const name of names){assert.match(name,/^[A-Za-z0-9_-]+\.(?:html|js|mjs|css|svg)$/,'Only fixed local shell resources are accepted');const stat=fs.lstatSync(path.join(root,group==='admin'?'admin':'',name));assert.ok(!stat.isSymbolicLink()&&stat.isFile(),'Shell resources must be regular local files, never symlinks');}
  assert.ok(names.includes('index.html'),'Shell requires its index');
  if(group==='public')assert.ok(!names.includes('catalog.js'),'Catalog is generated, never copied from source');
  const html=fs.readFileSync(path.join(root,group==='admin'?'admin':'','index.html'),'utf8');
  for(const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)){
   let file=match[1];if(group==='public'&&file==='catalog.js')continue;
   const shared=group==='admin'&&file.startsWith('../');file=file.replace(/^\.\.?\//,'');
   assert.ok((shared?value.public:names).includes(file),'HTML dependency missing from shell resource contract: '+match[1]);
  }
 }
 return value;
}
