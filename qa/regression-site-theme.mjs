// Disposable DOM/browser fixtures: no server private state, credentials or AI calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadContent} from '../scripts/content-lib.mjs';
import {readSiteResources} from '../scripts/site-resources.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),key='yixu:site-theme:v1';
const themes=[
 'editorial','studio','contact-sheet','salon-album','wardrobe-index','linen-room',
 'indigo-studio','porcelain-case','night-runway','city-billboard','garden-walk','sunset-notes',
];
// A declared script cannot smuggle an outside private file into a public build.
{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-shell-seam-')),fixture=path.join(temp,'fixture');fs.mkdirSync(fixture);fs.mkdirSync(path.join(fixture,'admin'));fs.mkdirSync(path.join(fixture,'scripts'));fs.mkdirSync(path.join(fixture,'public'));
 fs.writeFileSync(path.join(fixture,'index.html'),'<script src="app.js"></script>');fs.writeFileSync(path.join(fixture,'admin/index.html'),'<script src="./app.mjs"></script>');fs.writeFileSync(path.join(fixture,'admin/app.mjs'),'');
 fs.writeFileSync(path.join(fixture,'site-resources.json'),JSON.stringify({schema_version:1,public:['index.html','app.js'],admin:['index.html','app.mjs']}));
 fs.writeFileSync(path.join(temp,'private.js'),'outside-private-marker');fs.symlinkSync(path.join(temp,'private.js'),path.join(fixture,'app.js'));fs.writeFileSync(path.join(fixture,'public/index.html'),'previous working output');
 for(const name of ['build.mjs','content-lib.mjs','site-resources.mjs'])fs.copyFileSync(path.join(root,'scripts',name),path.join(fixture,'scripts',name));
 assert.throws(()=>readSiteResources(fixture),/symlink/);
 const result=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:fixture,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/symlink/);assert.ok(!result.stderr.includes('outside-private-marker'));assert.equal(fs.readFileSync(path.join(fixture,'public/index.html'),'utf8'),'previous working output');fs.rmSync(temp,{recursive:true,force:true});
 console.log('PASS shell contract/build reject an outside private symlink before reading assets or replacing live output');
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-theme-')),output=path.join(scratch,'site');
const built=spawnSync(process.execPath,['scripts/build.mjs','--output',output],{cwd:root,encoding:'utf8'});assert.equal(built.status,0,built.stderr||built.stdout);
const catalog=loadContent(root).catalog,featured=catalog.looks.find(l=>l.id===catalog.home.featured_look_id),boots=catalog.products.find(p=>p.product_id==='brown-boots-102');
let authenticated=true,force401=false,jobs=[],posts=0,selectedTheme='editorial',themeReadFailure=false,themeWriteFailure=false,themeSaves=0;
let themeDelay=0;
const requested=[];
const json=(res,data,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
 requested.push(req.url);res.setHeader('Cache-Control','no-store');
 if(req.url==='/api/site-theme'){
  assert.equal(req.method,'GET');
  assert.equal(req.headers.cookie,undefined,'Public theme reads are anonymous');
  const theme=selectedTheme;
  if(themeDelay)await new Promise(resolve=>setTimeout(resolve,themeDelay));
  return json(res,themeReadFailure?{error:'unavailable'}:{theme},themeReadFailure?503:200);
 }
 if(req.url==='/api/content/catalog')return json(res,catalog);
 if(req.url==='/api/bootstrap')return json(res,{csrf_token:'fixture-csrf',visitor:{id:'fixture'},generation_available:true,disclosure:{accepted:true,version:'fixture-v1',title:'照片用途',items:['仅为合成测试']}});
 if(req.url.startsWith('/api/admin/')){
  if(req.url==='/api/admin/bootstrap')return json(res,{authenticated,csrf_token:'fixture-admin-csrf'});
  if(req.url==='/api/admin/logout'){authenticated=false;return json(res,{authenticated:false});}
  if(!authenticated||force401){authenticated=false;return json(res,{error:{code:'admin_auth',message:'登录已失效'}},401);}
  if(req.url==='/api/admin/site-theme'){
   if(req.method==='PUT'){
    assert.equal(req.headers['x-csrf-token'],'fixture-admin-csrf');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const {theme}=JSON.parse(Buffer.concat(chunks));assert.ok(themes.includes(theme));
    if(themeWriteFailure)return json(res,{error:{message:'模拟保存失败'}},503);
    selectedTheme=theme;themeSaves++;
   }
   return json(res,{theme:selectedTheme});
  }
  if(req.url==='/api/admin/overview')return json(res,{visits:37,look_opens:2,tryons_total:0,queued:0,running:0,succeeded:0,failed:0,unknown:0,result_count:0,result_bytes:0,popular_looks:[],recent_jobs:[{id:'private-theme-job',look_id:1,edition:'v2',shot_index:1,status:'queued',created_at:'2026-11-20T00:00:00Z'}]});
  if(req.url==='/api/admin/settings')return json(res,{enabled:false,model:'fixture-model',api_key_configured:false});
  if(req.url.startsWith('/api/admin/results'))return json(res,{items:[],has_more:false});
  if(req.url==='/api/admin/content/overview')return json(res,{content_ready:false,cdn:{config:{configured:false},counts:{},jobs:[],total:0,bytes:0,verified_bytes:0}});
  if(req.url==='/api/admin/content/models')return json(res,{models:[]});
 }
 if(req.url==='/api/events')return json(res,{accepted:true});
 if(req.url==='/api/tryons'&&req.method==='POST'){
  for await(const _chunk of req){}posts++;jobs=[{id:'theme-queued-job',status:'queued',look_id:featured.id,edition:'v2',shot_index:3,queue_position:1,created_at:'2026-11-20T00:00:00Z',image_url:null,download_url:null,error_code:null,error_message:null}];return json(res,jobs[0],202);
 }
 if(req.url.startsWith('/api/tryons'))return json(res,{items:jobs,has_more:false});
 if(req.url.startsWith('/api/'))return json(res,{error:{code:'fixture',message:'test only'}},404);
 let filename;if(req.url==='/admin/'||req.url==='/admin/index.html')filename=path.join(root,'admin/index.html');else if(req.url.startsWith('/admin/'))filename=path.join(root,req.url.slice(1));else filename=path.join(output,req.url==='/'?'index.html':req.url.split('?')[0]);
 if(!filename.startsWith(root)&&!filename.startsWith(output)){res.statusCode=404;res.end();return;}
 if(!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml'})[path.extname(filename)]||'application/octet-stream');
 if(req.url==='/admin/')res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 res.end(fs.readFileSync(filename));
});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome',...['1255','1248','1243'].map(v=>path.join(os.homedir(),`.cache/ms-playwright/chromium-${v}/chrome-linux64/chrome`))].filter(Boolean).find(f=>fs.existsSync(f));assert.ok(chrome,'Chromium required');
const profile=path.join(scratch,'chrome'),browser=spawn(chrome,['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
const sockets=[];let endpoint,client;
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url);sockets.push(socket);let sequence=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};socket.onopen=()=>resolve((method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));}));socket.onerror=reject;});}
try{
 let stderr='';endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr)),15000);browser.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});browser.once('error',reject);});
 const debug=endpoint.replace('ws:','http:').replace(/\/devtools\/browser\/.*/,'');const targets=await(await fetch(debug+'/json/list')).json();client=await connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 const evaluate=async(expression,c=client)=>{const r=await c('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let n=0;n<180;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,25));}throw Error('DOM timeout: '+expression);};
 const navigate=async url=>{await client('Page.navigate',{url});await wait('document.readyState==="complete"&&!!window.YixuSiteTheme');};
 const themeIs=name=>`document.documentElement.dataset.siteTheme===${JSON.stringify(name)}`;
 const refreshPublic=()=>evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
 const choose=async name=>{selectedTheme=name;await refreshPublic();await wait(themeIs(name));};
 const save=async name=>{
  const before=themeSaves;
  await evaluate(`document.getElementById('site-theme-select').value=${JSON.stringify(name)};document.getElementById('site-theme-form').requestSubmit()`);
  await wait(`${themeIs(name)}&&!document.getElementById('site-theme-save').disabled`);
  assert.equal(themeSaves,before+1);
 };
 const route=async hash=>{await evaluate(`location.hash=${JSON.stringify(hash)}`);await wait(`location.hash===${JSON.stringify(hash)}`);await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
 const noOverflow=async label=>assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),label);
 const readableText=async (selector,label)=>{
  const undersized=await evaluate(`(()=>{
   const root=document.querySelector(${JSON.stringify(selector)});
   const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
   const issues=new Set();
   while(walker.nextNode()){
    const text=walker.currentNode, element=text.parentElement;
    if(!text.data.trim()||!element.getClientRects().length||
       element.closest('.sr-only, svg')||element.checkVisibility?.({visibilityProperty:true})===false)continue;
    const size=parseFloat(getComputedStyle(element).fontSize);
    if(size<13)issues.add(text.data.trim().slice(0,35)+' ('+size+'px)');
   }
   return [...issues];
  })()`);
  assert.deepEqual(undersized,[],label);
 };
 const capture=async name=>{if(!process.env.YIXU_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.YIXU_SCREENSHOT_DIR,{recursive:true,mode:0o700});const r=await client('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,name+'.png'),Buffer.from(r.data,'base64'),{mode:0o600});};
 await client('Page.enable');await client('Runtime.enable');
 const desktopDesigns=new Set();
 for(const width of [320,390,1440]){
  await client('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});await navigate(origin);await wait('document.getElementById("hero-image-0").naturalWidth>0');
  await evaluate(`localStorage.setItem('wardrobe99:favorites:v1','[1,99999]');localStorage.setItem('yixu:product-favorites:v1','["brown-boots-102","unknown-design"]')`);
  await evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'wardrobe99:favorites:v1',newValue:'[1,99999]'}));window.dispatchEvent(new StorageEvent('storage',{key:'yixu:product-favorites:v1',newValue:'["brown-boots-102","unknown-design"]'}))`);
  for(const theme of themes){
   await route('#/home');await choose(theme);await noOverflow('home '+theme+' '+width);
   assert.equal(await evaluate('document.querySelector(".latest-hero").firstElementChild.classList.contains("hero-copy")'),theme!=='studio');
   if(width===1440)desktopDesigns.add(await evaluate(`JSON.stringify([
    getComputedStyle(document.body).backgroundColor,
    ...['.latest-hero','.latest-hero h1','.hero-cover','.recent-section .gallery'].map(selector=>{
     const style=getComputedStyle(document.querySelector(selector));
     return [style.gridTemplateColumns,style.fontFamily,style.fontSize,style.width,style.margin,style.padding];
    })
   ])`));
   if(theme==='contact-sheet'){
    assert.match(await evaluate('document.getElementById("hero-image-0").alt'),/九宫格/);
    assert.match(await evaluate('document.getElementById("hero-edition-note").textContent'),/九宫格/);
    assert.ok(await evaluate(`(()=>{
     const image=document.getElementById("hero-image-0");
     const frame=image.parentElement.getBoundingClientRect(),photo=image.getBoundingClientRect();
     return Math.abs(frame.width-photo.width)<3&&Math.abs(frame.height-photo.height)<3;
    })()`), 'Contact sheet shows the complete source image');
   }
   await readableText('body','home text '+theme+' '+width);
   await capture('theme-home-'+theme+'-'+width);
   for(const hash of ['#/looks?q='+encodeURIComponent('针织'),'#/favorites','#/models','#/products','#/product/'+boots.product_id]){
    await route(hash);
    await choose(theme==='studio'?'editorial':'studio');await choose(theme);
    assert.equal(await evaluate('location.hash'),hash);
    await noOverflow(hash+' '+theme+' '+width);
    await readableText('body',hash+' text '+theme+' '+width);
   }
   await route('#/home');
   await evaluate('document.getElementById("hero-detail").click()');
   await wait('document.getElementById("detail-dialog").open');
   assert.ok(await evaluate('document.getElementById("detail-dialog").scrollWidth<=document.getElementById("detail-dialog").clientWidth+1'), 'look dialog '+theme+' '+width);
   await readableText('#detail-dialog','look dialog text '+theme+' '+width);
   await evaluate('document.getElementById("close-detail").click()');
  }
  await route('#/product/'+boots.product_id);await choose('studio');await wait('document.getElementById("product-page").dataset.productTheme==="studio"');
  const saveButton='#product-page .product-actions [data-product-favorite]';
  await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).click()`);await choose('editorial');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).getAttribute('aria-pressed')`),'false');
  await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).click()`);await choose('studio');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).getAttribute('aria-pressed')`),'true');assert.match(await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).textContent`),/已收藏/);assert.ok(JSON.parse(await evaluate('localStorage.getItem("yixu:product-favorites:v1")')).includes(boots.product_id));
  await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).click()`);await choose('editorial');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).getAttribute('aria-pressed')`),'false');assert.ok(!JSON.parse(await evaluate('localStorage.getItem("yixu:product-favorites:v1")')).includes(boots.product_id));
  await evaluate(`document.querySelector(${JSON.stringify(saveButton)}).click()`);
  await choose('editorial');
  await evaluate('window.retainedChapter=document.querySelector(".product-chapters button");window.retainedChapter.focus()');
  await choose('city-billboard');
  assert.ok(await evaluate('document.activeElement===window.retainedChapter'),'Changing between themes with the same product layout retains keyboard focus');
  await evaluate(`document.querySelector('[data-product-index="3"]').click();document.querySelector('.product-main-image').focus()`);await choose('studio');assert.equal(await evaluate('document.activeElement.matches(".product-main-image")'),true);await evaluate('document.querySelector(".product-main-image").click()');await wait('document.getElementById("product-image-dialog").open');
  const selected=await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),zoom=await evaluate('document.getElementById("product-zoom-image").getAttribute("src")');
  await choose('editorial');assert.equal(await evaluate('document.getElementById("product-image-dialog").open'),true);assert.equal(await evaluate('document.querySelector(".product-main-image img").getAttribute("src")'),selected);assert.equal(await evaluate('document.getElementById("product-zoom-image").getAttribute("src")'),zoom);assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'4 / '+(boots.gallery.length+1));await client('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});assert.equal(await evaluate('document.getElementById("product-image-position").textContent'),'5 / '+(boots.gallery.length+1));await evaluate('document.getElementById("close-product-image").click()');
  await choose('editorial');await route('#/product/'+boots.product_id+'?theme=studio');
  assert.equal(await evaluate('document.getElementById("product-page").dataset.productTheme'),'editorial','Legacy product query and presentation cannot override the site theme');
  assert.equal(await evaluate('localStorage.getItem("wardrobe99:favorites:v1")'),'[1,99999]');assert.deepEqual(JSON.parse(await evaluate('localStorage.getItem("yixu:product-favorites:v1")')).sort(),['brown-boots-102','unknown-design'].sort());
 }
 assert.equal(desktopDesigns.size,themes.length,'Every theme has a distinct desktop presentation');
 await route('#/home');await choose('studio');
 assert.equal(await evaluate('!!document.querySelector("[data-site-theme-control],#site-theme-form")'),false,'No visitor-facing theme control');
 assert.equal(await evaluate('typeof window.YixuSiteTheme.apply'),'undefined');
 await evaluate(`localStorage.setItem(${JSON.stringify(key)},'editorial')`);
 const paintHook=await client('Page.addScriptToEvaluateOnNewDocument',{source:`{
  function observeFirstFrame() {
   if (document.querySelector('.latest-hero') && getComputedStyle(document.documentElement).visibility === 'visible') {
    window.firstVisibleTheme = document.documentElement.dataset.siteTheme;
    return;
   }
   requestAnimationFrame(observeFirstFrame);
  }
  requestAnimationFrame(observeFirstFrame);
 }`});
 themeDelay=400;
 const beforeReload=await evaluate('performance.timeOrigin');
 await client('Page.reload');
 await wait(`performance.timeOrigin>${beforeReload} && document.readyState==="complete"`);
 await wait('!!window.firstVisibleTheme');
 assert.equal(await evaluate('window.firstVisibleTheme'),'studio','A delayed theme response does not expose the default layout on reload');
 assert.equal(await evaluate('document.documentElement.dataset.siteTheme'),'studio','The browser still reads the server selection after reload');
 await client('Page.removeScriptToEvaluateOnNewDocument',{identifier:paintHook.identifier});
 themeDelay=2200;
 await navigate(origin+'/index.html?theme-timeout-test');
 await wait('location.search==="?theme-timeout-test" && !document.documentElement.hasAttribute("data-site-theme-pending")');
 assert.ok(await evaluate(themeIs('editorial')),'An unavailable theme cannot keep the page hidden');
 themeDelay=0;
 await choose('studio');
 themeReadFailure=true;
 const reads=requested.filter(url=>url==='/api/site-theme').length;
 await refreshPublic();
 await wait('document.documentElement.dataset.siteTheme==="studio"');
 for(let n=0;n<100&&requested.filter(url=>url==='/api/site-theme').length===reads;n++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(requested.filter(url=>url==='/api/site-theme').length>reads,'A restored page rechecks the server');
 assert.equal(await evaluate('document.documentElement.dataset.siteTheme'),'studio','Refresh failure keeps the last valid selection');
 themeReadFailure=false;
 selectedTheme='unrecognized-theme';
 const invalidReads=requested.filter(url=>url==='/api/site-theme').length;
 await refreshPublic();
 for(let n=0;n<100&&requested.filter(url=>url==='/api/site-theme').length===invalidReads;n++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(requested.filter(url=>url==='/api/site-theme').length>invalidReads);
 assert.ok(await evaluate(themeIs('studio')),'An unknown theme keeps the last valid selection');
 await choose('editorial');await evaluate('document.getElementById("hero-detail").click()');await wait('document.getElementById("detail-dialog").open');await evaluate('document.getElementById("detail-tryon").click()');await wait('document.getElementById("tryon-dialog").open&&document.querySelectorAll("#tryon-reference-picker input").length===9');
 await evaluate('document.querySelector("#tryon-reference-options summary").click();document.querySelector("[data-reference-shot=\\"3\\"]").click()');
 await evaluate(`new Promise(resolve=>{const canvas=document.createElement('canvas');canvas.width=300;canvas.height=400;canvas.getContext('2d').fillRect(0,0,300,400);canvas.toBlob(blob=>{const transfer=new DataTransfer();transfer.items.add(new File([blob],'theme-fixture.png',{type:'image/png'}));const input=document.getElementById('tryon-album');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));window.retainedInput=input;window.retainedPreview=document.getElementById('tryon-local-preview');resolve();},'image/png')})`);await wait('!document.getElementById("tryon-local-preview").hidden');
 const blob=await evaluate('document.getElementById("tryon-local-preview").src');await choose('night-runway');assert.equal(await evaluate('window.retainedInput===document.getElementById("tryon-album")&&window.retainedPreview===document.getElementById("tryon-local-preview")'),true);assert.equal(await evaluate('document.getElementById("tryon-local-preview").src'),blob);assert.equal(await evaluate('document.querySelector("#tryon-reference-picker input:checked").value'),'3');
 await choose('editorial');assert.equal(await evaluate('document.getElementById("tryon-local-preview").src'),blob);
 await wait('!document.getElementById("tryon-submit").disabled');
 await evaluate('document.getElementById("tryon-submit").click()');
 const queuedJob='document.querySelector(\'[data-job-id="theme-queued-job"][data-job-status="queued"]\')';
 await wait(`Boolean(${queuedJob})`);
 await choose('studio');
 assert.ok(await evaluate(`document.getElementById("tryon-dialog").open && Boolean(${queuedJob})`),'The same queued job remains visible after a theme change');
 assert.equal(posts,1);
 await capture('theme-tryon-queued');
 await readableText('#tryon-dialog','try-on dialog text');
 await evaluate('document.getElementById("tryon-close").click()');
 const visitor=client;
 const adminTab=await(await fetch(debug+'/json/new?'+encodeURIComponent(origin+'/admin/'),{method:'PUT'})).json();
 client=await connect(adminTab.webSocketDebuggerUrl);
 await wait('!document.getElementById("workspace")?.hidden&&document.querySelector("[data-metric=visits]")?.textContent==="37"&&!document.getElementById("site-theme-save")?.disabled');
 await wait(themeIs('studio'));
 await evaluate(`localStorage.removeItem(${JSON.stringify(key)})`);
 assert.deepEqual(await evaluate('Array.from(document.getElementById("site-theme-select").options, option=>option.value).filter(Boolean).sort()'),[...themes].sort());
 for(const width of [320,390,1440]){
  await client('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
  for(const theme of themes){
   await save(theme);await noOverflow('admin '+theme+' '+width);
   assert.equal(await evaluate('document.querySelector(".site-admin-layout")!==null'),theme==='studio');
   assert.ok(await evaluate('document.getElementById("workspace").contains(document.getElementById("metrics"))'));
   await readableText('#workspace','admin text '+theme+' '+width);
   await capture('theme-admin-'+theme+'-'+width);
  }
 }
 await evaluate('document.getElementById("provider-model").value="unsaved model draft";window.metricNode=document.getElementById("metrics")');
 await save('garden-walk');
 assert.equal(await evaluate('document.getElementById("provider-model").value'),'unsaved model draft');
 assert.ok(await evaluate('window.metricNode===document.getElementById("metrics")'));
 await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))",visitor);
 for(let n=0;n<100&&!await evaluate(themeIs('garden-walk'),visitor);n++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(await evaluate(themeIs('garden-walk'),visitor),'A visitor tab adopts the theme saved in admin');
 assert.equal(posts,1,'Refreshing the public theme never starts another try-on');

 themeWriteFailure=true;
 await evaluate('document.getElementById("site-theme-select").value="studio";document.getElementById("site-theme-form").requestSubmit()');
 await wait('document.getElementById("site-theme-status").textContent.includes("未能确认保存结果")&&!document.getElementById("site-theme-save").disabled');
 assert.match(await evaluate('document.getElementById("error").textContent'),/模拟保存失败/);
 assert.equal(selectedTheme,'garden-walk');assert.ok(await evaluate(themeIs('garden-walk')));
 themeWriteFailure=false;
 await save('studio');

 await evaluate('document.getElementById("logout").click()');
 await wait('document.getElementById("workspace").hidden');
 assert.ok(await evaluate('document.getElementById("site-theme-form").closest("[hidden]")!==null'));
 assert.equal(await evaluate('document.body.textContent.includes("private-theme-job")'),false);
 authenticated=true;
 await navigate(origin+'/admin/');await wait('!document.getElementById("site-theme-save").disabled');await wait(themeIs('studio'));
 force401=true;
 await evaluate('document.getElementById("refresh-overview").click()');await wait('document.getElementById("workspace").hidden');
 assert.equal(await evaluate('document.body.textContent.includes("private-theme-job")'),false);
 client=visitor;
 await navigate(origin+'/#/product/'+boots.product_id+'?theme=editorial');await refreshPublic();await wait(themeIs('studio'));
 await navigate(pathToFileURL(path.join(output,'index.html')).href);await wait('document.getElementById("hero-image-0").naturalWidth>0');
 assert.equal(await evaluate('location.protocol'),'file:');assert.ok(await evaluate(themeIs('editorial')));await noOverflow('offline editorial');
 console.log('PASS real Chromium: 12 server-owned themes at 320/390/1440, authenticated save and visitor refresh, logout/401, no visitor override, intact galleries and pending try-on, offline fallback.');
}finally{for(const socket of sockets)try{socket.close();}catch{}try{process.kill(-browser.pid,'SIGTERM');}catch{}if(browser.exitCode===null&&browser.signalCode===null)await Promise.race([once(browser,'exit'),new Promise(resolve=>setTimeout(resolve,1500))]);await new Promise(resolve=>server.close(resolve));fs.rmSync(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
