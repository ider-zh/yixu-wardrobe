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
 assert.ok(sampleProducts.length>=3,'Published product samples remain available as the catalog grows');
 // Complete outfit samples prove the same product contract across styles;
 // their piece counts are fixtures, not limits on future catalog growth.
 const completeSamples=new Map([
  [3,['jade-qipao-003','black-low-pumps-003','pearl-studs-003']],
  [5,['black-biker-jacket-005','white-crew-tee-005','charcoal-cargo-trousers-005','black-ankle-boots-005','silver-studs-005']],
  [7,['ivory-sundress-007','tan-flat-sandals-007','pearl-studs-007']],
  [102,['navy-jacket-102','blue-knit-102','brown-skirt-102','brown-boots-102','navy-bag-102','silver-studs-102']],
 ]);
 for(const [lookId,products] of completeSamples){
  const look=catalog.looks.find(look=>look.id===lookId);
  assert.equal(look.pieces.length,products.length);
  for(const [index,id] of products.entries()){
   const product=sampleProducts.find(product=>product.product_id===id);
   assert.ok(product,id+' is published with a stable product link');
   const appearance=product.appearances.find(appearance=>appearance.look_id===lookId);
   assert.equal(appearance?.piece_index,index+1,id+' maps to the original outfit piece');
   assert.equal(appearance.reference_asset_id,look.versions.v2.asset.asset_id);
  }
 }
 for(const [id,asset] of [['blue-knit-102','product-blue-knit-102-r1'],['brown-skirt-102','product-brown-skirt-102-r2'],['brown-boots-102','product-brown-boots-102-r2']])assert.equal(sampleProducts.find(product=>product.product_id===id).asset.asset_id,asset,'Existing image and collection identities survive catalog expansion');

 const originalFavorites=await evaluate('localStorage.getItem("wardrobe99:favorites:v1")');
 for(const viewport of [{width:320,height:844},{width:390,height:844},{width:1440,height:1000}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  await route('#/products');await wait('!document.getElementById("products-page").hidden');
  assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),sampleProducts.length);
  await noOverflow('Product index '+viewport.width);
  const product=sampleProducts.find(p=>p.gallery?.length),hash='#/product/'+product.product_id;
  await evaluate(`document.querySelector('#product-gallery a[href="${hash}"]').click()`);
  await wait('!document.getElementById("product-page").hidden');
  assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),product.name);
  await wait('document.querySelector(".product-main-image img").naturalWidth>0');
  await noOverflow('Product detail '+viewport.width);
  const box=await evaluate('(()=>{const e=document.querySelector(".product-main-image img"),r=e.getBoundingClientRect();return {width:r.width,height:r.height};})()');
  assert.ok(Math.abs(box.width/box.height-.8)<.01,'Product retains its independent portrait composition');
  assert.equal(await evaluate('document.querySelectorAll("[data-product-select]").length'),product.gallery.length+1);
  assert.equal(await evaluate('document.querySelectorAll(".product-detail-story").length'),product.gallery.length,'Independent detail photos replace the enlarged hero');
  await evaluate('document.querySelector("[data-product-index=\\"1\\"]").click()');
  await wait('document.querySelector(".product-main-image img").complete&&document.querySelector(".product-main-image img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),product.gallery[0].asset.source_url);
  assert.equal(await evaluate('document.querySelector("[data-product-index=\\"1\\"]").getAttribute("aria-pressed")'),'true');
  await evaluate('(()=>{const im=document.querySelector(".product-main-image img");im.src="data:image/webp;base64,aW52YWxpZA==";im.dispatchEvent(new Event("error"));})()');
  await wait('document.querySelector(".product-main-image img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),product.gallery[0].asset.source_url,'Detail images retain project fallback');
  await evaluate('document.querySelector(".product-main-image").scrollIntoView({block:"center"});document.querySelector(".product-main-image").focus()');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait('document.getElementById("product-image-dialog").open');
  assert.equal(await evaluate('document.getElementById("product-zoom-image").getAttribute("src")'),product.gallery[0].asset.source_url,'Zoom opens the selected detail image');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'3 / 3');
  assert.equal(await evaluate('document.getElementById("product-image-next").disabled'),true);
  await evaluate('document.getElementById("product-image-prev").click()');
  assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'2 / 3');
  await evaluate('document.getElementById("close-product-image").click()');
  await wait('!document.getElementById("product-image-dialog").open');
  await evaluate(`document.querySelector('#product-page [data-product-worn]').click()`);
  assert.equal(await evaluate('location.hash'),hash,'Section navigation stays on the product route');
  await evaluate('document.querySelector("#product-worn-section").scrollIntoView({behavior:"instant",block:"start"})');
  assert.ok(await evaluate('(()=>{const nav=document.querySelector(".product-chapters"),r=nav.getBoundingClientRect(),header=document.querySelector(".site-header").getBoundingClientRect();return r.top>=header.bottom-1&&!!document.elementFromPoint(r.left+20,r.top+r.height/2)?.closest(".product-chapters");})()'),'Product chapter navigation stays visible below the sticky site header');
  await evaluate('document.querySelector(".product-worn").click()');await wait('document.getElementById("detail-dialog").open');
  assert.equal(await evaluate('document.querySelectorAll("#detail-product-gallery [data-product-card]").length'),sampleProducts.filter(item=>item.appearances.some(a=>a.look_id===product.appearances[0].look_id)).length);
  await evaluate('document.getElementById("close-detail").click()');await wait(`location.hash===${JSON.stringify(hash)}&&!document.getElementById('product-page').hidden`);
  await noOverflow('Product return '+viewport.width);
  if(process.env.YIXU_SCREENSHOT_DIR){
   await evaluate('window.scrollTo({top:0,behavior:"instant"});document.querySelector("[data-product-index=\\"0\\"]").click()');
   const capture=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`product-${viewport.width}.png`),Buffer.from(capture.data,'base64'),{mode:0o600});
   await evaluate('document.querySelector(".product-detail-story").scrollIntoView({behavior:"instant",block:"start"})');
   const detail=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`product-detail-${viewport.width}.png`),Buffer.from(detail.data,'base64'),{mode:0o600});
   await evaluate('document.querySelector("#product-worn-section").scrollIntoView({behavior:"instant",block:"start"})');
   const worn=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`product-worn-${viewport.width}.png`),Buffer.from(worn.data,'base64'),{mode:0o600});
  }
 }
 // Each published product is the same public contract, regardless of category or gallery size.
 const galleryFavoritesBefore=await evaluate('localStorage.getItem("yixu:product-favorites:v1")');
 for(const viewport of [{width:390,height:844},{width:1440,height:1000}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  for(const product of sampleProducts){
   const hash='#/product/'+product.product_id;
   await route(hash);await wait('!document.getElementById("product-page").hidden&&document.querySelector(".product-main-image img").naturalWidth>0');
   assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),product.copy?.hero_title||product.name,product.product_id+' uses its published copy');
   assert.equal(await evaluate('document.querySelectorAll("#product-page [data-product-select]").length'),product.gallery?.length?product.gallery.length+1:0);
   assert.match(await evaluate('document.querySelector(".product-disclosure").textContent'),/AI 设计展示/);
   await noOverflow(product.product_id+' hero '+viewport.width);
   const images=[{title:'完整形态',caption:product.description,asset:product.asset},...(product.gallery||[])];
   for(let index=0;index<images.length;index++){
    const image=images[index];
    if(images.length>1)await evaluate(`document.querySelector('[data-product-index="${index}"]').click()`);
    await wait('document.querySelector(".product-main-image img").complete&&document.querySelector(".product-main-image img").naturalWidth>0');
    assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),image.asset.source_url,product.product_id+' selected image '+index);
    assert.equal(await evaluate('document.querySelector(".product-main-image .product-design-badge").hidden'),!image.design_study,product.product_id+' labels the current image');
    assert.equal(await evaluate('document.querySelector(".product-main-image img").alt.includes("设计推演")'),!!image.design_study);
    await evaluate('document.querySelector(".product-main-image").click()');await wait('document.getElementById("product-image-dialog").open&&document.getElementById("product-zoom-image").naturalWidth>0');
    assert.equal(await evaluate('document.getElementById("product-zoom-image").getAttribute("src")'),image.asset.source_url);
    assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),`${index+1} / ${images.length}`);
    assert.equal(await evaluate('document.getElementById("product-image-caption").textContent'),image.title+(image.design_study?' · 设计推演':''));
    assert.equal(await evaluate('document.getElementById("product-image-note").textContent'),image.caption,'The full photo explanation survives zoom');
    assert.equal(await evaluate('document.getElementById("product-image-prev").disabled'),index===0);
    assert.equal(await evaluate('document.getElementById("product-image-next").disabled'),index===images.length-1);
    await evaluate('document.getElementById("close-product-image").click()');await wait('!document.getElementById("product-image-dialog").open');
   }
   // Delivery failure continues to use the project copy, for each product type.
   await evaluate('(()=>{const image=document.querySelector(".product-main-image img");image.src="data:image/webp;base64,aW52YWxpZA==";image.dispatchEvent(new Event("error"));})()');
   await wait('document.querySelector(".product-main-image img").naturalWidth>0');
   assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),images.at(-1).asset.source_url);
   for(let index=0;index<product.appearances.length;index++){
    const appearance=product.appearances[index],look=catalog.looks.find(look=>look.id===appearance.look_id),version=look.versions.v2;
    assert.equal(appearance.reference_asset_id,version.asset.asset_id,'Appearance uses the exact published photo revision');
    const source=await evaluate(`(()=>{const card=document.querySelectorAll('#product-worn-section .product-worn')[${index}],photo=card.querySelector('.photo-window'),image=photo.querySelector('img');return {href:card.getAttribute('href'),look:card.dataset.productLook,caption:card.querySelector('.product-worn-source').textContent,src:image.getAttribute('src'),alt:image.alt,x:photo.style.getPropertyValue('--panel-x'),y:photo.style.getPropertyValue('--panel-y')};})()`);
    assert.equal(source.href,'#look-'+look.id);assert.equal(source.look,String(look.id));
    assert.equal(source.src,version.source_url);
    assert.ok(source.caption.includes('第 '+appearance.shot_index+' 镜头'));
    assert.ok(source.alt.includes(version.shots[appearance.shot_index-1].title),'Original wearing preview names the declared shot');
    assert.equal(source.x,-((appearance.shot_index-1)%3)*100+'%');assert.equal(source.y,-Math.floor((appearance.shot_index-1)/3)*100+'%');
    await evaluate(`document.querySelectorAll('#product-worn-section .product-worn')[${index}].click()`);await wait('document.getElementById("detail-dialog").open');
    assert.equal(await evaluate('document.getElementById("detail-title").textContent'),look.title);
    assert.equal(await evaluate('document.getElementById("detail-image").getAttribute("src")'),version.source_url);
    const piece=await evaluate(`(()=>{const row=document.querySelectorAll('#detail-pieces>li')[${appearance.piece_index-1}];return {number:row.querySelector('.piece-number').textContent,role:row.querySelector('.piece-role').textContent,name:row.lastElementChild.textContent};})()`);
    assert.deepEqual(piece,{number:String(appearance.piece_index).padStart(2,'0'),...look.pieces[appearance.piece_index-1]},'The source outfit keeps its original piece ordering and identity');
    await evaluate('document.getElementById("close-detail").click()');await wait(`location.hash===${JSON.stringify(hash)}&&!document.getElementById('product-page').hidden`);
   }
   await noOverflow(product.product_id+' full page '+viewport.width);
   if(process.env.YIXU_SCREENSHOT_DIR){
    await evaluate('window.scrollTo({top:0,behavior:"instant"});document.querySelector("[data-product-index=\\"0\\"]")?.click()');
    await wait('document.querySelector(".product-main-image img").complete&&document.querySelector(".product-main-image img").naturalWidth>0');
    const capture=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`${product.product_id}-${viewport.width}.png`),Buffer.from(capture.data,'base64'),{mode:0o600});
   }
  }
 }
 assert.equal(await evaluate('localStorage.getItem("yixu:product-favorites:v1")'),galleryFavoritesBefore,'Browsing any category leaves product collections intact');
 assert.equal(await evaluate('localStorage.getItem("wardrobe99:favorites:v1")'),originalFavorites,'Product galleries leave outfit collections intact');
 console.log('PASS all published products: 390/1440px routes, every image selection/zoom, portrait source fallback, design disclosures, exact outfit photo/shot/piece associations and unchanged collections');
 const boots=sampleProducts.find(p=>p.product_id==='brown-boots-102');
 assert.ok(boots,'A multi-view product is available');
 for(const theme of ['editorial','studio']) for(const viewport of [{width:320,height:844},{width:390,height:844},{width:800,height:1000},{width:1440,height:1000}]){
  await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
  await route('#/product/'+boots.product_id+'?theme='+theme);
  assert.equal(await evaluate('document.getElementById("product-page").dataset.productTheme'),theme);
  assert.equal(await evaluate('!!document.querySelector(".product-studio-layout")'),theme==='studio','Themes render distinct page structures');
  await wait('document.querySelector(".product-main-image img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelectorAll("[data-product-select]").length'),8);
  assert.equal(await evaluate('document.querySelectorAll(".product-view-card").length'),3);
  assert.equal(await evaluate('document.querySelectorAll(".product-detail-story").length'),4);
  assert.equal(await evaluate('document.querySelectorAll(".product-chapters button").length'),4);
  assert.match(await evaluate('document.querySelector(".product-worn-source").textContent'),/原写真穿着参考.*3/);
  await noOverflow('Boots multi-view hero '+viewport.width);
  const images=[boots.asset,...boots.gallery.map(image=>image.asset)];
  for(let index=0;index<images.length;index++){
   await evaluate(`document.querySelector('[data-product-index="${index}"]').click()`);
   await wait('document.querySelector(".product-main-image img").complete&&document.querySelector(".product-main-image img").naturalWidth>0');
   assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),images[index].source_url);
   assert.equal(await evaluate('document.querySelectorAll("[data-product-select][aria-pressed=true]").length'),1);
  }
  await evaluate('document.querySelector("[data-product-index=\\"3\\"]").click()');
  assert.equal(await evaluate('document.querySelector(".product-main-image .product-design-badge").hidden'),false);
  assert.match(await evaluate('document.querySelector(".product-hero-caption").textContent'),/背面方案.*设计推演/);
  await evaluate('document.querySelector(".product-main-image").click()');await wait('document.getElementById("product-image-dialog").open');
  assert.match(await evaluate('document.getElementById("product-image-caption").textContent'),/设计推演/);
  assert.match(await evaluate('document.getElementById("product-image-note").textContent'),/原参考未展示完整背部/);
  await evaluate('document.getElementById("product-image-next").click()');
  assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'5 / 8');
  assert.doesNotMatch(await evaluate('document.getElementById("product-image-caption").textContent'),/设计推演/);
  await evaluate('document.getElementById("close-product-image").click();document.querySelector("[data-product-index=\\"0\\"]").click()');
  assert.equal(await evaluate('document.querySelector(".product-main-image .product-design-badge").hidden'),true);
  if(process.env.YIXU_SCREENSHOT_DIR){
   await evaluate('window.scrollTo({top:0,behavior:"instant"})');
   const capture=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`boots-${theme}-${viewport.width}.png`),Buffer.from(capture.data,'base64'),{mode:0o600});
  }
  await evaluate('document.querySelector(".product-view-section").scrollIntoView({behavior:"instant",block:"start"})');
  await wait('[...document.querySelectorAll(".product-view-image img")].every(image=>image.complete&&image.naturalWidth>0)');
  await noOverflow('Boots full-view section '+viewport.width);
  const study=await evaluate('(()=>{const e=document.querySelector(".product-view-card[data-design-study=true] .product-design-badge");return {hidden:e.hidden,text:e.textContent};})()');
  assert.equal(study.hidden,false);assert.match(study.text,/设计推演/);
  if(viewport.width<521&&theme==='editorial'){
   assert.ok(await evaluate('(()=>{const e=document.querySelector(".product-view-grid");return e.scrollWidth>e.clientWidth;})()'),'Editorial mobile full views scroll within their own gallery');
   await evaluate('document.querySelector(".product-view-grid").scrollLeft=10000');
   assert.ok(await evaluate('document.querySelector(".product-view-grid").scrollLeft>0'));
   await evaluate('document.querySelector(".product-view-grid").scrollLeft=0');
  }
  if(process.env.YIXU_SCREENSHOT_DIR){
   const capture=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`boots-${theme}-views-${viewport.width}.png`),Buffer.from(capture.data,'base64'),{mode:0o600});
   await evaluate('document.querySelector(".product-detail-stories-grid").scrollIntoView({behavior:"instant",block:"start"})');
   await wait('[...document.querySelectorAll(".product-detail-image img")].every(image=>image.complete&&image.naturalWidth>0)');
   const detail=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,`boots-${theme}-details-${viewport.width}.png`),Buffer.from(detail.data,'base64'),{mode:0o600});
  }
 }
 console.log('PASS boots: both themes, eight images, view/detail roles, visible design-study labels in cards/hero/zoom, original wearing reference, responsive thumbnails and mobile angle scrolling at 320/390/800/1440px');
 // A theme changes presentation while image identity, collection, and disclosures survive.
 const bootsHash='#/product/'+boots.product_id;
 await route(bootsHash+'?theme=editorial');
 const favoriteBefore=await evaluate('localStorage.getItem("yixu:product-favorites:v1")');
 await evaluate('document.querySelector("[data-product-index=\\"3\\"]").click()');
 const selectedSource=boots.gallery[2].asset.source_url;
 await route(bootsHash+'?theme=studio');
 assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),selectedSource,'Theme switch preserves selected asset');
 assert.equal(await evaluate('document.querySelector(".product-main-image .product-design-badge").hidden'),false);
 assert.equal(await evaluate('localStorage.getItem("yixu:product-favorites:v1")'),favoriteBefore);
 await evaluate('history.back()');await wait('location.hash.endsWith("?theme=editorial")');
 await wait('document.getElementById("product-page").dataset.productTheme==="editorial"');
 assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),selectedSource);
 await route(bootsHash+'?theme=future-theme');
 assert.equal(await evaluate('document.getElementById("product-page").dataset.productTheme'),'editorial','Unknown safe theme uses built-in fallback');
 await navigate(pathToFileURL(path.join(output,'index.html')).href+bootsHash+'?theme=studio');
 assert.equal(await evaluate('document.getElementById("product-page").dataset.productTheme'),'studio','Theme review route reloads offline');
 await evaluate('document.querySelector("[data-product-index=\\"0\\"]").click();document.querySelector(".product-main-image").click();document.getElementById("product-image-dialog").close();document.querySelector(".product-main-image").click()');
 await wait('document.getElementById("product-image-dialog").open');
 await client('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'2 / 8','A queued close cannot disable keyboard navigation in a reopened gallery');
 await evaluate('document.getElementById("close-product-image").click()');
 await wait('!document.getElementById("product-image-dialog").open');
 await route('#/product/'+sampleProducts.find(product=>!product.gallery?.length).product_id+'?theme=studio');
 assert.equal(await evaluate('document.querySelectorAll("[data-product-select]").length'),0,'One-image legacy product does not invent gallery photos');
 assert.equal(await evaluate('document.querySelectorAll(".product-detail-story,.product-view-card").length'),0);
 await noOverflow('Legacy product in Studio');
 console.log('PASS product themes: structure, offline direct reload, asset selection and browser Back, unchanged collections, unknown theme fallback, legacy single-image content');
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
 assert.equal(await evaluate('document.querySelectorAll("#product-gallery [data-product-card]").length'),sampleProducts.filter(product=>product.category===sampleProducts[1].category).length);
 await route('#/product/not-published');assert.match(await evaluate('document.getElementById("product-page").textContent'),/暂未发布/);
 await route('#/home');assert.equal(await evaluate('document.querySelectorAll("#home-product-gallery [data-product-card]").length'),Math.min(3,sampleProducts.filter(product=>product.appearances.some(a=>a.look_id===featured.id)).length));
 await navigate(origin+'/#/product/'+savedProduct.product_id);await wait('!document.getElementById("product-page").hidden');
 assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),savedProduct.name,'Reloadable online product route');
 const plainHeading='<img src=x onerror="window.productCopyExecuted=true"> & "Editorial"';
 for(const theme of ['editorial','studio']){
  apiCatalog=structuredClone(catalog);
  const product=apiCatalog.products.find(product=>product.product_id===boots.product_id);
  product.presentation={theme,preset:'future-paper'};
  product.copy={hero_title:plainHeading,views_title:plainHeading,details_title:plainHeading,worn_title:plainHeading,related_title:plainHeading};
  await navigate(origin+'/?theme-review='+theme+bootsHash);
  await wait(`document.querySelector('#product-page h1')?.textContent===${JSON.stringify(plainHeading)}`);
  assert.equal(await evaluate('document.getElementById("product-page").dataset.productTheme'),theme,'API selects the same built-in themes as the offline snapshot');
  assert.equal(await evaluate('document.getElementById("product-page").dataset.productPreset'),theme==='studio'?'neutral-white':'warm-paper','Unknown safe preset uses the theme default');
  assert.equal(await evaluate('!!window.productCopyExecuted'),false);
  assert.equal(await evaluate('!!document.querySelector("#product-page img[src=x]")'),false,'Editorial copy remains text');
  await noOverflow('API copy in '+theme);
 }
 apiCatalog=structuredClone(catalog);
 apiCatalog.products.find(product=>product.product_id===boots.product_id).presentation={theme:'../../private'};
 await navigate(origin+'/?theme-review=malformed'+bootsHash);
 await wait('document.getElementById("catalog-status").textContent.includes("本地内容快照")');
 assert.equal(await evaluate('document.querySelector("#product-page h1").textContent'),boots.copy?.hero_title||boots.name,'Malformed API theme retains usable built snapshot');
 apiCatalog=structuredClone(catalog);
 console.log('PASS product content boundary: API/offline themes, unknown presets, escaped copy, malformed configuration fallback');
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
