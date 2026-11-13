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
 if(req.url==='/api/bootstrap'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({csrf_token:'fixture-csrf',visitor:{id:'fixture'},generation_available:false,disclosure:{accepted:false,version:'fixture-v1',title:'照片用途',items:['照片交由第三方 AI 生成试穿图，结果可供后台评估。']}}));return;
 }
 if(req.url==='/api/tryons'||req.url.startsWith('/api/tryons?')||req.url==='/api/events'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/events'?{accepted:true}:{items:[],has_more:false}));return;
 }
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
 const activate=async(selector,touch=false)=>{
  const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  if(touch){
   await client('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
   await client('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
   await client('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
   await client('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  }
 };
 await client('Page.enable');await client('Runtime.enable');
 // LAN HTTP lacks secure-context randomUUID even though getRandomValues works.
 // Use the same capability boundary on loopback so this check runs in every CI.
 await client('Page.addScriptToEvaluateOnNewDocument',{source:'Object.defineProperty(globalThis.crypto,"randomUUID",{value:undefined,configurable:true});'});
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  await navigate();await wait('document.getElementById("hero-image-0").naturalWidth>0 && !document.getElementById("tryon-refresh").disabled');
  assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);
  assert.equal(await evaluate('Number(document.getElementById("hero-detail").dataset.open)'),featured.id);
  const bounds=await evaluate(`['hero-title','hero-detail','hero-photo-button'].map(id=>{const rect=document.getElementById(id).getBoundingClientRect();return {id,top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height};})`);
  for(const box of bounds){assert.ok(box.width>0&&box.height>0,box.id+' is visible');assert.ok(box.top>=0&&box.bottom<=viewport.height+1,`${box.id} must fit the first screen at ${viewport.width}: ${JSON.stringify(box)}`);assert.ok(box.left>=0&&box.right<=viewport.width+1,box.id+' fits viewport width');}
  const recent=await evaluate('[...document.querySelectorAll("#recent-gallery [data-look-card]")].map(card=>Number(card.dataset.lookCard))');
  assert.deepEqual(recent,catalog.home.recent_look_ids);assert.ok(!recent.includes(featured.id));
  await noOverflow('Homepage '+viewport.width);
  for(const selector of ['#hero-photo-button','#hero-detail']){
   await activate(selector,viewport.width<801);
   await wait('document.getElementById("detail-dialog").open');
   assert.equal(await evaluate('document.getElementById("detail-title").textContent'),featured.title,'Home action opens its featured outfit without a reload');
   await evaluate('document.getElementById("close-detail").click()');
   await wait('!document.getElementById("detail-dialog").open');
  }
  assert.match(await evaluate('document.getElementById("hero-detail").textContent'),/查看穿搭/);
  await evaluate('document.getElementById("hero-detail").focus()');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait('document.getElementById("detail-dialog").open');
  await evaluate('document.getElementById("close-detail").click()');await wait('!document.getElementById("detail-dialog").open');
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
 await evaluate('window.__randomValues=crypto.getRandomValues;Object.defineProperty(crypto,"getRandomValues",{value(){throw Error("Synthetic analytics failure");},configurable:true})');
 await activate('#hero-detail');await wait('document.getElementById("detail-dialog").open');
 await evaluate('Object.defineProperty(crypto,"getRandomValues",{value:window.__randomValues,configurable:true});delete window.__randomValues;document.getElementById("close-detail").click()');
 await wait('!document.getElementById("detail-dialog").open');
 console.log('PASS homepage photo/button touch, mouse and keyboard actions on LAN crypto capabilities; failed analytics cannot block details');
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
 // Tag exploration is a real link into the full archive, not a recommendation
 // API. Each detail entry keeps its origin even after navigating away and Back.
 const tag='衣序共享标签回归';
 apiCatalog=structuredClone(catalog);
 apiCatalog.looks.find(look=>look.id===featured.id).tags.push(tag);
 apiCatalog.looks.find(look=>look.id!==featured.id).tags.push(tag);
 await navigate();await wait(`window.WARDROBE.looks.find(look=>look.id===${featured.id}).tags.includes(${JSON.stringify(tag)})`);
 const region=typeof featured.region==='string'?featured.region:featured.region?.city||'';
 const filteredOrigin='#/looks?'+new URLSearchParams({category:featured.category,season:featured.season,model:featured.model_id||'',region,latest:'1',saved:'1',sort:'id'});
 for(const source of ['#/home',filteredOrigin,'#/favorites']){
  await route(source);
  await evaluate(source==='#/home'?'document.getElementById("hero-detail").click()':`document.querySelector('#gallery [data-open="${featured.id}"]').click()`);
  await wait('document.getElementById("detail-dialog").open');
  const position=await evaluate('document.getElementById("detail-position").textContent');
  const tags=await evaluate('[...document.querySelectorAll("#detail-tags > a")].map(link=>({href:link.getAttribute("href"),label:link.getAttribute("aria-label")}))');
  assert.ok(tags.some(link=>new URLSearchParams(link.href.split('?')[1]).get('q')===tag));
  assert.ok(tags.every(link=>link.label.startsWith('搜索标签 ')),'Link purpose is explicit to assistive technology');
  assert.equal(await evaluate('document.querySelector("#detail-tags > a").getAttribute("href").startsWith("#/looks?q=")'),true);
  const expectedMoods=featured.versions.v2.moods||[];
  for(const mood of expectedMoods)assert.equal(await evaluate(`[...document.querySelectorAll('#detail-tags > span')].some(node=>node.textContent===${JSON.stringify(mood)})`),true,'Mood remains plain text');
  await evaluate(`document.querySelector('#detail-tags a[href="${'#/looks?'+new URLSearchParams({q:tag})}"]').focus()`);
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait('!document.getElementById("detail-dialog").open && !document.getElementById("collection").hidden');
  assert.equal(await evaluate('new URLSearchParams(location.hash.split("?")[1]).get("q")'),tag);
  assert.match(await evaluate('location.hash'),/%[0-9A-F]{2}/,'Chinese query is URL encoded');
  assert.equal(await evaluate('document.activeElement.id'),'collection-title','Search destination receives focus');
  assert.equal(await evaluate('document.getElementById("search").value'),tag);
  assert.equal(await evaluate('document.getElementById("sort").value'),'latest');
  assert.equal(await evaluate('document.getElementById("latest-only").checked || document.getElementById("favorites-only").checked'),false,'Exploration clears old latest/favorite filters');
  assert.deepEqual(await evaluate('["model-filter","region-filter"].map(id=>document.getElementById(id).value)'),['','']);
  const found=await evaluate('[...document.querySelectorAll("#gallery [data-look-card]")].map(card=>Number(card.dataset.lookCard))');
  assert.ok(found.includes(featured.id)&&found.some(id=>id!==featured.id),'Tag search actually finds another outfit');
  assert.equal(await evaluate('document.querySelectorAll("#active-filters .filter-pill").length'),1,'Only the clicked tag remains active');
  await evaluate('history.back()');await wait(`document.getElementById("detail-dialog").open && location.hash==="#look-${featured.id}"`);
  assert.equal(await evaluate('document.getElementById("detail-position").textContent'),position,'Back restores the original detail navigation context');
  await evaluate('document.getElementById("close-detail").click()');
  await wait(`!document.getElementById("detail-dialog").open && location.hash===${JSON.stringify(source)}`);
 }
 await navigate(origin+'/#/looks?'+new URLSearchParams({q:tag}));
 assert.equal(await evaluate('document.getElementById("search").value'),tag,'Reload preserves an encoded search route');
 // Synthetic long titles and a punctuation-heavy shared tag exercise the same
 // browser UI without changing any production content or invoking a provider.
 apiCatalog=structuredClone(catalog);
 const longTitle='沿着窗边慢慢走来并邀请你一起看看新发现的那本书';
 const specialTag='针织 蓝+棕 & 雨/日';
 const synthetic=apiCatalog.looks.find(look=>look.id===featured.id);
 synthetic.versions.v2.shots.forEach((shot,index)=>{shot.title=longTitle+String(index+1);});
 synthetic.tags.push(specialTag,'仅本套独有的测试标签',17);
 apiCatalog.looks.find(look=>look.id!==featured.id).tags.push(specialTag);
 for(const width of [320,390]){
  await client('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
  await navigate();await wait(`window.WARDROBE.looks.find(look=>look.id===${featured.id}).tags.includes(${JSON.stringify(specialTag)})`);
  await evaluate('document.getElementById("hero-detail").click()');await wait('document.getElementById("detail-dialog").open');
  assert.equal(await evaluate(`document.querySelector('[data-view="0"]').getAttribute("aria-pressed")`),'true','Grid remains the default');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#view-selector .shot-number")].map(node=>node.textContent)'),['01','02','03','04','05','06','07','08','09']);
  assert.equal(await evaluate(`document.querySelector('[data-view="1"] .shot-title').textContent`),longTitle+'1');
  assert.equal(await evaluate('document.querySelector("#detail-dialog").scrollWidth<=document.querySelector("#detail-dialog").clientWidth+1'),true,'Long titles fit the '+width+'px dialog');
  assert.equal(await evaluate('[...document.querySelectorAll("#view-selector button")].every(node=>node.scrollWidth<=node.clientWidth+1)'),true,'Every named button wraps rather than overflowing');
  await noOverflow('Named shot details '+width);
  await evaluate(`document.querySelector('[data-view="3"]').focus()`);
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await evaluate(`document.querySelector('[data-view="3"]').getAttribute("aria-pressed")`),'true');
  assert.equal(await evaluate('document.querySelector("#view-moment").textContent.includes(window.WARDROBE.looks.find(look=>look.id===Number(document.getElementById("hero-detail").dataset.open)).versions.v2.shots[2].framing)'),true,'Selected shot retains full real framing');
  for(const key of ['ArrowRight','ArrowLeft']){
   await client('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='ArrowRight'?39:37});
   await client('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:key==='ArrowRight'?39:37});
  }
  assert.equal(await evaluate('location.hash'),'#look-'+featured.id,'Global arrows do not switch outfits while a shot control has focus');
  assert.equal(await evaluate('document.activeElement.dataset.view'),'3','Arrow keys do not steal shot-control focus');
  const links=await evaluate('[...document.querySelectorAll("#detail-tags>a")].map(link=>link.getAttribute("href"))');
  assert.ok(links.some(href=>new URLSearchParams(href.split('?')[1]).get('q')===specialTag));
  assert.ok(!links.some(href=>new URLSearchParams(href.split('?')[1]).get('q')==='仅本套独有的测试标签'),'Unique tag stays plain text');
  await evaluate(`document.querySelector('#detail-tags a[href="${'#/looks?'+new URLSearchParams({q:specialTag})}"]').click()`);
  await wait('!document.getElementById("detail-dialog").open');
  assert.equal(await evaluate('document.getElementById("search").value'),specialTag,'Punctuation is preserved, not parsed as URL fields');
  assert.ok(await evaluate('document.querySelectorAll("#gallery [data-look-card]").length>1'));
 }
 apiCatalog=structuredClone(catalog);
 console.log('PASS named shots at 320/390px, keyboard focus, shared-only encoded tag search and source-aware detail Back from home/archive/favorites');
 apiCatalog=structuredClone(catalog);apiCatalog.revision='stale-test-revision';apiCatalog.looks=apiCatalog.looks.filter(look=>look.id!==featured.id);apiCatalog.home={featured_look_id:apiCatalog.looks[0].id,recent_look_ids:[],latest_batch_id:null};
 await navigate();await wait('document.getElementById("catalog-status").textContent.includes("同步中")');assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);assert.equal(await evaluate('window.WARDROBE.revision'),catalog.revision);
 apiCatalog=structuredClone(catalog);await navigate();await wait('document.getElementById("hero-image-0").naturalWidth>0');assert.equal(await evaluate('document.getElementById("catalog-status").textContent'),'');
 await navigate(pathToFileURL(path.join(output,'index.html')).href);await wait('document.getElementById("hero-image-0").naturalWidth>0');assert.equal(await evaluate('document.getElementById("hero-title").textContent'),featured.title);await route('#/looks');assert.equal(await evaluate('document.querySelector("#gallery [data-look-card]").dataset.lookCard'),String(catalog.latestOrder[0]));await noOverflow('Offline archive');
 const offlineSource='#/looks?q=1',offlineTag='针织'; // Frozen historical fixture survives future daily hero changes.
 await route(offlineSource);await evaluate(`document.querySelector('#gallery [data-open="1"]').click()`);await wait('document.getElementById("detail-dialog").open');
 const offlineLink=await evaluate(`document.querySelector('#detail-tags a[href="${'#/looks?'+new URLSearchParams({q:offlineTag})}"]').getAttribute('href')`);
 await evaluate(`document.querySelector('#detail-tags a[href="${offlineLink}"]').click()`);await wait('!document.getElementById("detail-dialog").open');
 assert.equal(await evaluate('location.protocol'),'file:');assert.equal(await evaluate('document.getElementById("search").value'),offlineTag);
 assert.ok(await evaluate('document.querySelectorAll("#gallery [data-look-card]").length>1'),'Offline exploration uses its snapshot, without the API');
 await evaluate('history.back()');await wait('document.getElementById("detail-dialog").open');await evaluate('document.getElementById("close-detail").click()');await wait(`location.hash===${JSON.stringify(offlineSource)}`);
 // Product samples work from the actual offline snapshot as well as API hydration.
 const sampleProducts=catalog.products||[];
 assert.equal(sampleProducts.length,3);
 const originalFavorites=await evaluate('localStorage.getItem("wardrobe99:favorites:v1")');
 for(const viewport of [{width:320,height:844},{width:390,height:844},{width:1440,height:1000}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  await route('#/products');await wait('!document.getElementById("products-page").hidden');
  assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),3);
  await noOverflow('Product index '+viewport.width);
  const product=sampleProducts[0],hash='#/product/'+product.product_id;
  await evaluate(`document.querySelector('#product-gallery a[href="${hash}"]').click()`);
  await wait('!document.getElementById("product-page").hidden');
  assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),product.name);
  await wait('document.querySelector(".product-main-image img").naturalWidth>0');
  await noOverflow('Product detail '+viewport.width);
  const box=await evaluate('(()=>{const e=document.querySelector(".product-main-image img"),r=e.getBoundingClientRect();return {width:r.width,height:r.height};})()');
  assert.ok(Math.abs(box.width/box.height-.8)<.01,'Product retains its independent portrait composition');
  await evaluate('document.querySelector(".product-main-image").scrollIntoView({block:"center"});document.querySelector(".product-main-image").focus()');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait('document.getElementById("product-image-dialog").open');
  await evaluate('document.getElementById("close-product-image").click()');
  await wait('!document.getElementById("product-image-dialog").open');
  await evaluate(`document.querySelector('#product-page [data-product-worn]').click()`);
  assert.equal(await evaluate('location.hash'),hash,'Section navigation stays on the product route');
  await evaluate('document.querySelector(".product-worn").click()');await wait('document.getElementById("detail-dialog").open');
  assert.equal(await evaluate('document.querySelectorAll("#detail-product-gallery [data-product-card]").length'),3);
  await evaluate('document.getElementById("close-detail").click()');await wait(`location.hash===${JSON.stringify(hash)}&&!document.getElementById('product-page').hidden`);
  await noOverflow('Product return '+viewport.width);
  if(process.env.YIXU_SCREENSHOT_DIR){await evaluate('window.scrollTo(0,0)');const capture=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`product-${viewport.width}.png`),Buffer.from(capture.data,'base64'),{mode:0o600});}
 }
 const savedProduct=sampleProducts[0];
 await evaluate('localStorage.setItem("yixu:product-favorites:v1",JSON.stringify(["future-product"]))');
 await client('Page.navigate',{url:'about:blank'});await wait('location.href==="about:blank"');
 await navigate(pathToFileURL(path.join(output,'index.html')).href+'#/product/'+savedProduct.product_id);
 await evaluate('document.querySelector("#product-page [data-product-favorite]").click()');
 assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("yixu:product-favorites:v1"))'),['future-product',savedProduct.product_id]);
 assert.equal(await evaluate('localStorage.getItem("wardrobe99:favorites:v1")'),originalFavorites,'Product collection never overwrites outfit collection');
 await route('#/products?saved=1');assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),1);
 await evaluate('document.querySelector("#product-gallery [data-product-favorite]").click()');
 assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),0);
 await route('#/products?category='+encodeURIComponent(sampleProducts[1].category));
 assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),1);
 await route('#/product/not-published');assert.match(await evaluate('document.getElementById("product-page").textContent'),/暂未发布/);
 await route('#/home');assert.equal(await evaluate('document.querySelectorAll("#home-product-gallery [data-product-card]").length'),3);
 await navigate(origin+'/#/product/'+savedProduct.product_id);await wait('!document.getElementById("product-page").hidden');
 assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),savedProduct.name,'Reloadable online product route');
 console.log('PASS products: offline/online routes, original outfit associations, portrait images, keyboard zoom, source return, category/collection filters, isolated preserved favorites, unknown IDs and 320/390/1440px layouts');
 assert.ok(!requested.some(url=>/^\/images\/look-/.test(url)),'Archived v1 pictures never enter the public site');
 assert.deepEqual(exceptions,[],'Browser must not report uncaught JavaScript exceptions');
 console.log('PASS stale API retains newest built version, matching API hydration, real file:// offline snapshot and expressive-only resources');
}finally{
 if(client&&socket?.readyState===1)await Promise.race([client('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
 if(processChrome.exitCode===null&&processChrome.signalCode===null){const exit=once(processChrome,'exit');try{process.kill(-processChrome.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}await exit;}
 socket?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});fs.rmSync(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log('Homepage real Chromium regression passed.');
