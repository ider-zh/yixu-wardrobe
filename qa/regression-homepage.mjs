import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadContent} from '../scripts/content-lib.mjs';

// Actual Chromium, source-generated static snapshot, and a synthetic resource
// API. This exercises browser layout/routing and never calls an AI provider.
const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=process.env.TMPDIR||os.tmpdir();
const workspace=fs.mkdtempSync(path.join(scratch,'yixu-homepage-'));
const output=path.join(workspace,'site');
const built=spawnSync(process.execPath,['scripts/build.mjs','--output',output],{cwd:root,encoding:'utf8'});
assert.equal(built.status,0,built.stderr||built.stdout);
const catalog=loadContent(root).catalog;
const featured=catalog.looks.find(look=>look.id===catalog.home.featured_look_id);
assert.ok(featured,'Publication projection supplies a real hero');
let apiCatalog=structuredClone(catalog);
const requested=[];
const server=http.createServer((req,res)=>{
 requested.push(req.url);
 if(req.url==='/api/content/catalog'){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(apiCatalog));return;}
 if(req.url.startsWith('/api/')){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end('{"error":{"code":"fixture_unavailable","message":"测试服务未配置"}}');return;}
 let relative;try{relative=decodeURIComponent(new URL(req.url,'http://fixture').pathname);}catch{res.statusCode=400;res.end();return;}
 const target=path.resolve(output,'.'+(relative==='/'?'/index.html':relative));
 if(!target.startsWith(output+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml'})[path.extname(target)]||'application/octet-stream');res.end(fs.readFileSync(target));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const candidates=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome',...['1248','1243'].map(v=>path.join(os.homedir(),`.cache/ms-playwright/chromium-${v}/chrome-linux64/chrome`))].filter(Boolean);
const chrome=candidates.find(p=>fs.existsSync(p));
assert.ok(chrome,'Chromium is required; set CHROME_BIN.');
const profile=fs.mkdtempSync(path.join(scratch,'yixu-home-chrome-'));
const processChrome=spawn(chrome,['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true,env:{...process.env,TMPDIR:process.env.CHROME_TMPDIR||scratch}});
let client,socket;
try{
 let stderr='';
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chromium readiness: '+stderr)),15000);processChrome.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});processChrome.once('error',error=>{clearTimeout(timer);reject(error);});processChrome.once('exit',code=>{clearTimeout(timer);reject(Error('Chromium exited '+code+' '+stderr));});});
 const targets=await(await fetch(endpoint.replace('ws:','http:').replace(/\/devtools\/browser\/.*/,'/json/list'))).json();
 socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const pending=new Map(),exceptions=[];
 socket.onmessage=message=>{const item=JSON.parse(message.data);if(item.method==='Runtime.exceptionThrown')exceptions.push(item.params.exceptionDetails);if(item.id&&pending.has(item.id)){const task=pending.get(item.id);pending.delete(item.id);item.error?task.reject(Error(item.error.message)):task.resolve(item.result);}};
 client=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await client('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const wait=async expression=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('DOM condition timed out: '+expression);};
 const navigate=async(url=origin)=>{await client('Page.navigate',{url});await wait('document.readyState==="complete" && !!document.querySelector("#hero-detail")?.dataset.open');};
 const route=async hash=>{await evaluate(`location.hash=${JSON.stringify(hash)}`);await wait(`location.hash===${JSON.stringify(hash)}`);await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');};
 const noOverflow=async label=>assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),label+' has no horizontal overflow');
 await client('Page.enable');await client('Runtime.enable');
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  await navigate();await wait('document.getElementById("hero-image-0").naturalWidth>0');
  assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);
  assert.equal(await evaluate('Number(document.getElementById("hero-detail").dataset.open)'),featured.id);
  const bounds=await evaluate(`['hero-title','hero-detail','hero-photo-button'].map(id=>{const rect=document.getElementById(id).getBoundingClientRect();return {id,top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height};})`);
  for(const box of bounds){assert.ok(box.width>0&&box.height>0,box.id+' is visible');assert.ok(box.top>=0&&box.bottom<=viewport.height+1,`${box.id} must fit the first screen at ${viewport.width}: ${JSON.stringify(box)}`);assert.ok(box.left>=0&&box.right<=viewport.width+1,box.id+' fits viewport width');}
  const recent=await evaluate('[...document.querySelectorAll("#recent-gallery [data-look-card]")].map(card=>Number(card.dataset.lookCard))');
  assert.deepEqual(recent,catalog.home.recent_look_ids);assert.ok(!recent.includes(featured.id));
  await noOverflow('Homepage '+viewport.width);
  if(process.env.YIXU_SCREENSHOT_DIR){fs.mkdirSync(process.env.YIXU_SCREENSHOT_DIR,{recursive:true,mode:0o700});const image=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`home-${viewport.width}.png`),Buffer.from(image.data,'base64'),{mode:0o600});}
  await evaluate('document.querySelector("[data-page=looks]").click()');await wait('!document.getElementById("collection").hidden');
  const archiveIds=await evaluate('[...document.querySelectorAll("#gallery [data-look-card]")].map(card=>Number(card.dataset.lookCard))');assert.deepEqual(archiveIds,catalog.latestOrder.slice(0,24));
  if(viewport.width<801){await evaluate('document.getElementById("open-filters").click()');assert.equal(await evaluate('document.getElementById("filter-dialog").open'),true);assert.equal(await evaluate('document.activeElement.closest("#filter-dialog")!==null'),true,'Native drawer receives focus');}
  const category=featured.category;
  await evaluate(`document.querySelector('[data-category='+CSS.escape(${JSON.stringify(category)})+']').click()`);
  if(viewport.width<801){await evaluate('document.getElementById("apply-filters").click()');await wait('!document.getElementById("filter-dialog").open');}
  assert.equal(await evaluate('new URLSearchParams(location.hash.split("?")[1]).get("category")'),category);
  const filterHash=await evaluate('location.hash');
  await evaluate('document.querySelector("#gallery [data-open]").click()');await wait('document.getElementById("detail-dialog").open');
  assert.match(await evaluate('location.hash'),/^#look-\d+$/);
  await evaluate('history.back()');await wait('!document.getElementById("detail-dialog").open');assert.equal(await evaluate('location.hash'),filterHash,'Browser Back restores filter route');
  await noOverflow('Archive '+viewport.width);
  await evaluate('document.querySelector("[data-page=home]").click()');await wait('!document.getElementById("home-page").hidden');
  assert.equal(await evaluate('Number(document.getElementById("hero-detail").dataset.open)'),featured.id,'Archive filters cannot change the home hero');
  console.log(`PASS ${viewport.width}×${viewport.height}: first-screen loaded hero, six nonduplicated recent looks, latest archive, filter route, detail Back and no overflow`);
 }
 // Enter a comparison detail outside the current archive selection, then cross
 // into an ID that matches the filter. Prev/next must retain the original list.
 for(const id of [70,71]){await route('#/looks?q='+id);await evaluate(`document.querySelector('#gallery [data-compare="${id}"]').click()`);}
 await route('#/looks?q='+encodeURIComponent('丝绒'));
 await evaluate(`document.getElementById("open-compare").click();document.querySelector('[data-compare-detail="70"]').click()`);
 await wait('document.getElementById("detail-dialog").open');
 const globalNext=catalog.latestOrder[catalog.latestOrder.indexOf(70)+1];
 await evaluate('document.getElementById("next-look").click()');assert.equal(await evaluate('location.hash'),'#look-'+globalNext);
 await evaluate('document.getElementById("previous-look").click()');assert.equal(await evaluate('location.hash'),'#look-70','Comparison navigation remains frozen when a neighbor happens to match the active filter');
 await evaluate('document.getElementById("close-detail").click();document.getElementById("clear-compare").click()');
 console.log('PASS comparison detail navigation keeps its initial global context across filtered neighbors');
 await route('#/models');await wait('!document.getElementById("models-page").hidden');
 const actualModels=new Set(catalog.looks.map(look=>look.model_id).filter(Boolean));
 const modelLinks=await evaluate('[...document.querySelectorAll(".model-looks-link")].map(link=>link.getAttribute("href"))');
 assert.equal(modelLinks.length,[...actualModels].filter(id=>catalog.models.some(model=>model.model_id===id)).length);
 for(const link of modelLinks){const id=new URLSearchParams(link.split('?')[1]).get('model');assert.ok(actualModels.has(id));}
 if(modelLinks.length){await evaluate('document.querySelector(".model-looks-link").click()');await wait('!document.getElementById("collection").hidden');assert.equal(await evaluate('document.getElementById("model-filter").value'),new URLSearchParams(modelLinks[0].split('?')[1]).get('model'));}
 await route('#/home');await evaluate('localStorage.setItem("wardrobe99:favorites:v1","[9999]")');await navigate();await evaluate('document.getElementById("hero-favorite").click()');
 assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("wardrobe99:favorites:v1"))'),[9999,featured.id]);
 await route('#/favorites');assert.deepEqual(await evaluate('[...document.querySelectorAll("#gallery [data-look-card]")].map(card=>Number(card.dataset.lookCard))'),[featured.id]);
 await navigate(origin+'/#look-'+featured.id);await wait('document.getElementById("detail-dialog").open');assert.equal(await evaluate('document.getElementById("detail-title").textContent'),featured.title);await evaluate('document.getElementById("close-detail").click()');await wait('!document.getElementById("home-page").hidden');
 console.log('PASS published-model links, local/unknown favorite preservation and reloadable direct detail links');
 apiCatalog=structuredClone(catalog);apiCatalog.revision='stale-test-revision';apiCatalog.looks=apiCatalog.looks.filter(look=>look.id!==featured.id);apiCatalog.home={featured_look_id:apiCatalog.looks[0].id,recent_look_ids:[],latest_batch_id:null};
 await navigate();await wait('document.getElementById("catalog-status").textContent.includes("同步中")');assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);assert.equal(await evaluate('window.WARDROBE.revision'),catalog.revision);
 apiCatalog=structuredClone(catalog);await navigate();await wait('document.getElementById("hero-image-0").naturalWidth>0');assert.equal(await evaluate('document.getElementById("catalog-status").textContent'),'');
 await navigate(pathToFileURL(path.join(output,'index.html')).href);await wait('document.getElementById("hero-image-0").naturalWidth>0');assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);await route('#/looks');assert.equal(await evaluate('document.querySelector("#gallery [data-look-card]").dataset.lookCard'),String(catalog.latestOrder[0]));await noOverflow('Offline archive');
 assert.ok(!requested.some(url=>/^\/images\/look-/.test(url)),'Archived v1 pictures never enter the public site');
 assert.deepEqual(exceptions,[],'Browser must not report uncaught JavaScript exceptions');
 console.log('PASS stale API retains newest built version, matching API hydration, real file:// offline snapshot and expressive-only resources');
}finally{
 if(client&&socket?.readyState===1)await Promise.race([client('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
 if(processChrome.exitCode===null&&processChrome.signalCode===null){const exit=once(processChrome,'exit');try{process.kill(-processChrome.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}await exit;}
 socket?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});fs.rmSync(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log('Homepage real Chromium regression passed.');
