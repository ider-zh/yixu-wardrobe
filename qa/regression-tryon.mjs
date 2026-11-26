import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

// Real Chromium DOM/event + HTTP adapter regression. The HTTP API below is an
// explicitly synthetic TEST fixture, never a provider or production success.
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(root,'content/catalog.json'),'utf8'));
const scratch = process.env.TMPDIR || os.tmpdir();
// Chromium's singleton UNIX socket needs a short temp path. When retaining test
// artifacts under a long TMPDIR, set CHROME_TMPDIR to a short private scratch dir.
const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome',
  ...['1248','1243'].map(v => path.join(os.homedir(), `.cache/ms-playwright/chromium-${v}/chrome-linux64/chrome`))].filter(Boolean);
const chrome = candidates.find(p => fs.existsSync(p));
assert.ok(chrome, 'Real DOM tests require Chromium; set CHROME_BIN (no production dependency).');
let available = false, jobs = [], accept = false, uploadError = null, uploadErrorStatus=503, bootstrapError = null, paginate=false, holdList=false, heldList=null,holdUpload=false,heldUpload=null;
let nextJobId='fixture-job-1';
const requests = [];
let catalogFixture=null;
let resultImage = null; // Browser-encoded synthetic WebP; never a provider output.
const bootstrap = () => ({csrf_token:'test-csrf',visitor:{id:'test-visitor'},generation_available:available,pose_grid_available:true,
  disclosure:{version:'test-v1',title:'照片用途',items:['照片交由第三方 AI 生成试穿图，结果可供后台评估。'],accepted:accept},
  original_retention_seconds:3600,result_max_count:1000});
const server = http.createServer(async (req,res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=Buffer.concat(chunks);
  requests.push({url:req.url,method:req.method,headers:req.headers,body});
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/content/catalog'&&catalogFixture){res.end(JSON.stringify(catalogFixture));return;}
    if(/^\/api\/content\/assets\/fixture-10[12](?:\/download)?$/.test(req.url)){
      res.setHeader('Content-Type','image/webp');
      if(req.url.endsWith('/download'))res.setHeader('Content-Disposition','attachment; filename="fixture-look.webp"');
      res.end(fs.readFileSync(path.join(root,'images-v2/look-001.webp')));return;
    }
    if (req.url==='/api/bootstrap') {
      if(bootstrapError){res.statusCode=503;res.end(JSON.stringify(bootstrapError));return;}
      res.setHeader('Set-Cookie','visitor_fixture=test-only; HttpOnly; SameSite=Strict; Path=/');
      res.end(JSON.stringify(bootstrap()));return;
    }
    if (req.url.split('?')[0]==='/api/tryons' && req.method==='GET') {
      const offset=Number(new URL(req.url,'http://fixture').searchParams.get('offset')||0);
      const payload=JSON.stringify(paginate?{items:jobs.slice(offset,offset+1),has_more:offset+1<jobs.length}:{items:jobs,has_more:false});
      if(holdList){holdList=false;heldList=()=>res.end(payload);return;}
      res.end(payload);return;
    }
    if(/^\/api\/tryons\/fixture-[a-z0-9-]+$/.test(req.url)&&req.method==='DELETE'){
      assert.equal(req.headers['x-csrf-token'],'test-csrf');jobs=jobs.filter(job=>job.id!==req.url.split('/').at(-1));res.end('{"deleted":true}');return;
    }
    if(req.url==='/api/tryons/fixture-job-1/image'||req.url==='/api/tryons/fixture-job-1/download'||/^\/api\/tryons\/fixture-aspect-\d+-(portrait|landscape|square)\/(image|download)$/.test(req.url)){
      assert.match(req.headers.cookie||'',/visitor_fixture=/);res.setHeader('Content-Type','image/webp');
      if(req.url.endsWith('/download'))res.setHeader('Content-Disposition','attachment; filename="synthetic-test-output.webp"');
      res.end(resultImage || fs.readFileSync(path.join(root,'images-v2/look-001.webp')));return;
    }
    if(req.url==='/api/events') {res.end('{"accepted":true}');return;}
    if(req.url==='/api/disclosure/accept' && req.method==='POST') {
      assert.equal(req.headers['x-csrf-token'],'test-csrf');assert.match(req.headers.cookie||'',/visitor_fixture=/);
      assert.deepEqual(JSON.parse(body),{version:'test-v1'});accept=true;res.end('{"accepted":true,"version":"test-v1"}');return;
    }
    if(req.url==='/api/tryons' && req.method==='POST') {
      if(uploadError){res.statusCode=uploadErrorStatus;res.end(JSON.stringify(uploadError));return;}
      assert.equal(accept,true,'Consent must precede reception of photo');
      assert.equal(req.headers['x-csrf-token'],'test-csrf');assert.match(req.headers.cookie||'',/visitor_fixture=/);
      const data=await new Request('http://fixture',{method:'POST',headers:{'content-type':req.headers['content-type']},body}).formData();
      const job={id:nextJobId,status:'queued',look_id:Number(data.get('look_id')),edition:data.get('edition'),shot_index:Number(data.get('shot_index')),pose_mode:data.get('pose_mode')||'original',queue_position:7,created_at:'2026-11-11T00:00:00Z',original_expires_at:'2026-11-11T01:00:00Z',image_url:null,download_url:null,error_code:null,error_message:null};
      jobs=[job,...jobs.filter(item=>item.id!==job.id&&item.status==='unknown')];res.statusCode=202;
      const finish=()=>res.end(JSON.stringify(job));
      if(holdUpload){holdUpload=false;heldUpload=finish;return;}
      finish();return;
    }
    res.statusCode=503;res.end('{"error":{"code":"fixture_unavailable","message":"测试服务未配置"}}');return;
  }
  if(req.url==='/catalog.js'){
    res.setHeader('Content-Type','text/javascript');
    res.end('window.WARDROBE = '+JSON.stringify(baseline)+';');return;
  }
  const target=path.join(root, decodeURIComponent(req.url.split('?')[0]==='/'?'index.html':req.url.split('?')[0]));
  if(!target.startsWith(root)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',types[path.extname(target)]||'application/octet-stream');res.end(fs.readFileSync(target));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=fs.mkdtempSync(path.join(scratch,'yixu-tryon-chrome-'));
const processChrome=spawn(chrome,['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true,env:{...process.env,TMPDIR:process.env.CHROME_TMPDIR||scratch}});
let client, socket;
try {
  let stderr='';
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Chromium readiness: '+stderr)),15000);
    processChrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
    processChrome.once('error',error=>{clearTimeout(timer);reject(error);});
    processChrome.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error('Chromium exited before readiness: '+(signal||code)+' '+stderr));});
  });
  const targets=await (await fetch(endpoint.replace('ws:','http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
  const ws=socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let seq=0;const pending=new Map();
  ws.onmessage=message=>{const m=JSON.parse(message.data);if(m.id&&pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(m.error.message)):resolve(m.result);}};
  client=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await client('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+' '+JSON.stringify(r.exceptionDetails.exception));return r.result.value;};
  const capture=async name=>{
    if(!process.env.YIXU_SCREENSHOT_DIR)return;
    fs.mkdirSync(process.env.YIXU_SCREENSHOT_DIR,{recursive:true,mode:0o700});
    const shot=await client('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(process.env.YIXU_SCREENSHOT_DIR,name+'.png'),Buffer.from(shot.data,'base64'),{mode:0o600});
  };
  const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('DOM condition timed out: '+expression);};
  const selectedReference=()=>evaluate('document.querySelector("#tryon-reference-picker input:checked")?.value');
  const openReferenceOptions=()=>evaluate('document.querySelector("#tryon-reference-options summary").click()');
  const load=async()=>{await client('Page.navigate',{url:origin});await wait('document.readyState === "complete"');};
  await client('Page.addScriptToEvaluateOnNewDocument',{source:'Object.defineProperty(globalThis.crypto,"randomUUID",{value:undefined,configurable:true});'});
  await load();
  await wait('document.getElementById("tryon-availability")?.textContent.includes("暂不可用")');
  assert.ok(requests.some(r=>r.url==='/api/bootstrap'), 'Page load must securely bootstrap a visitor without requiring a try-on click');
  assert.equal(await evaluate('document.cookie'),'','Visitor credential must be HttpOnly');
  assert.equal(await evaluate('localStorage.length'),0,'No visitor credential in local storage');
  await evaluate('document.querySelector("[data-open]").click()');
  assert.equal(await evaluate('document.getElementById("detail-tryon").hidden'),false,'Visible detail action');
  await evaluate('document.getElementById("detail-tryon").click()');
  await wait('document.getElementById("tryon-dialog").open');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true);
  assert.equal(await evaluate('document.getElementById("tryon-camera").disabled'),false,'Unavailable generation still allows local photo preparation');
  assert.equal(await evaluate('document.querySelectorAll(".tryon-flow li").length'),3,'The fitting flow has three readable stages');
  assert.ok(!(await evaluate('document.getElementById("tryon-dialog").textContent')).includes('登录'));
  console.log('PASS secure automatic bootstrap, honest unavailable state, visible detail action, no account/storage');
  available=true;
  await load();
  await wait('document.getElementById("tryon-availability")?.textContent.includes("已连接")');
  await evaluate('document.getElementById("search").value="100";document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-open=\\"100\\"]").click()');
  await evaluate('document.getElementById("detail-tryon").click()');
  assert.equal(await selectedReference(),'1','Opening from the montage selects the outfit reference automatically');
  assert.equal(await evaluate('document.getElementById("tryon-reference-options").open'),false);
  assert.equal(await evaluate('document.activeElement.id'),'tryon-photo-title','Upload flow starts in the photo library');
  await openReferenceOptions();
  assert.equal(await evaluate('document.querySelectorAll("#tryon-reference-picker input[type=radio]").length'),9,'Nine actual image choices replace the text select');
  assert.equal(await evaluate('document.querySelectorAll("#tryon-reference-picker input:checked").length'),1);
  await wait('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.naturalWidth>0)');
  for(let index=0;index<9;index++){
    assert.deepEqual(await evaluate(`(()=>{const image=document.querySelectorAll('.tryon-reference-thumbnail img')[${index}];return [image.style.left,image.style.top];})()`),[-(index%3)*100+'%',-Math.floor(index/3)*100+'%'],'Each image choice shows its own actual panel');
  }
  const legacyShots=await evaluate('window.WARDROBE.looks.find(look=>look.id===100).versions.v2.shots');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#tryon-reference-picker input")].map(input=>({value:input.value,label:input.getAttribute("aria-label")}))'),
    legacyShots.map((shot,i)=>({value:String(i+1),label:'参考 '+String(i+1).padStart(2,'0')+' · '+shot.title+' · '+shot.framing})),
    'Historical 100 keeps all nine actual titles, framing descriptions and panel indices');
  assert.equal(await evaluate('document.getElementById("tryon-reference-picker").getAttribute("aria-describedby")'),'tryon-reference-framing');
  assert.equal(await evaluate('document.getElementById("tryon-reference-framing").textContent'),'画面景别 / '+legacyShots[0].framing);
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'), /LOOK 100 ·/);
  await evaluate('document.querySelector("[data-reference-shot=\\"9\\"]").click()');
  assert.equal(await evaluate('document.querySelector("#tryon-reference-picker input:checked").value'),'9');
  await evaluate('document.querySelector("[data-reference-shot=\\"9\\"]").focus()');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  assert.equal(await evaluate('document.querySelector("#tryon-reference-picker input:checked").value'),'1','Keyboard Home selects first image');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  assert.equal(await evaluate('document.querySelector("#tryon-reference-picker input:checked").value'),'4','Keyboard Down follows the three-column image grid');
  await client('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  await client('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  assert.equal(await selectedReference(),'9');
  await evaluate('document.querySelector("[data-view=\\"4\\"]").click()');
  assert.equal(await selectedReference(),'9','Open request stays frozen when the underlying panel changes');
  assert.equal(await evaluate('document.getElementById("tryon-reference-framing").textContent'),'画面景别 / '+legacyShots[8].framing,'Framing stays frozen with the selected reference');
  await evaluate('document.getElementById("tryon-close").click();document.getElementById("detail-tryon").click()');
  assert.equal(await selectedReference(),'1','Opening from an individual gallery picture uses the same outfit reference');
  assert.equal(await evaluate('document.getElementById("tryon-reference-options").open'),false);
  const before=await evaluate('document.getElementById("detail-title").textContent');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
  assert.equal(await evaluate('document.getElementById("detail-title").textContent'),before,'Try-on modal blocks underlying detail keyboard navigation');
  console.log('PASS automatic outfit reference, nine optional choices, gallery independence and modal keyboard guard');
  const disclosure=await evaluate('document.getElementById("tryon-disclosure")?.textContent || ""');
  assert.match(disclosure,/第三方 AI/,'Disclose external processing');assert.match(disclosure,/后台评估/);
  assert.equal(await evaluate('document.querySelectorAll("#tryon-disclosure li").length'),1,'Single concise photo-purpose notice');
  assert.match(disclosure,/本人同意.*同意上述用途/);
  assert.doesNotMatch(disclosure,/1 小时|一小时|1000|FIFO|Cookie|幂等|持久队列/);
  assert.equal(await evaluate('document.getElementById("tryon-camera").getAttribute("capture")'),'user');
  assert.equal(await evaluate('document.getElementById("tryon-album").hasAttribute("capture")'),false);
  const choosePhoto=async (id,width=8,height=8)=>evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=${width};canvas.height=${height};const context=canvas.getContext('2d');context.fillStyle='#c8cabc';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#8b9c86';context.fillRect(canvas.width*.3,canvas.height*.35,canvas.width*.4,canvas.height*.55);context.beginPath();context.arc(canvas.width*.5,canvas.height*.23,Math.min(canvas.width*.12,canvas.height*.12),0,Math.PI*2);context.fill();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'synthetic-test-only.png',{type:'image/png'}));
    const input=document.getElementById(${JSON.stringify(id)});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const viewports=[{width:320,height:800},{width:390,height:844},{width:1280,height:900}];
  const shapes=[{name:'portrait',width:600,height:1200},{name:'landscape',width:1200,height:600},{name:'square',width:900,height:900}];
  const aspectFailures=[];
  let aspectChecks=0;
  const setViewport=async viewport=>{
    await client('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const assertReferenceBounds=async label=>{
    const bounds=await evaluate(`(()=>{
      const select=document.getElementById('tryon-reference-picker'),description=document.getElementById('tryon-reference-framing');
      const parent=select.parentElement.getBoundingClientRect(),choice=select.getBoundingClientRect(),text=description.getBoundingClientRect();
      return {parent:{left:parent.left,right:parent.right},choice:{left:choice.left,right:choice.right},text:{left:text.left,right:text.right,height:text.height},
        scrollWidth:description.scrollWidth,clientWidth:description.clientWidth,lineHeight:parseFloat(getComputedStyle(description).lineHeight),viewport:innerWidth};
    })()`);
    for(const area of [bounds.choice,bounds.text]){
      assert.ok(area.left>=bounds.parent.left-1&&area.right<=bounds.parent.right+1,label+' stays inside selection content');
      assert.ok(area.left>=-1&&area.right<=bounds.viewport+1,label+' stays inside viewport');
    }
    assert.ok(bounds.scrollWidth<=bounds.clientWidth+1,label+' wraps without horizontal overflow');
    return bounds;
  };
  const assertFocusedThumbnail=async label=>{
    const state=await evaluate(`(()=>{const input=document.activeElement,choice=input.closest('.tryon-reference-choice'),frame=choice.querySelector('.tryon-reference-thumbnail'),r=frame.getBoundingClientRect(),dialog=document.getElementById('tryon-dialog').getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewport:innerHeight,dialogTop:dialog.top,dialogBottom:dialog.bottom,visible:[[r.left+3,r.top+3],[r.right-3,r.top+3],[r.left+3,r.bottom-3],[r.right-3,r.bottom-3]].every(([x,y])=>document.elementFromPoint(x,y)?.closest('.tryon-reference-choice')===choice)};})()`);
    assert.ok(state.visible,label+' entire focused photograph is unobscured');
    assert.ok(state.top>=Math.max(0,state.dialogTop)&&state.bottom<=Math.min(state.viewport,state.dialogBottom),label+' entire focused photograph fits its scroll viewport');
  };
  await openReferenceOptions();
  for(const viewport of viewports){await setViewport(viewport);await assertReferenceBounds('Historical framing '+viewport.width);}
  for(const viewport of viewports){
    await setViewport(viewport);
    const grid=await evaluate('(()=>{const grid=document.getElementById("tryon-reference-picker"),choices=[...grid.querySelectorAll(".tryon-reference-thumbnail")].map(node=>node.getBoundingClientRect());return {columns:getComputedStyle(grid).gridTemplateColumns.split(" ").length,ratios:choices.map(r=>r.width/r.height)};})()');
    assert.equal(grid.columns,3,'All nine references remain a three-column image grid');
    assert.ok(grid.ratios.every(ratio=>Math.abs(ratio-2/3)<.01),'Every thumbnail retains portrait 2:3');
    for(const panel of [1,3,7,9]){
      await evaluate(`document.querySelector('[data-reference-shot="${panel}"]').focus()`);
      await assertFocusedThumbnail('Focused reference '+panel+' at '+viewport.width);
    }
    await evaluate('document.querySelector("[data-reference-shot=\\"1\\"]").focus()');
    await client('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    await client('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    await assertFocusedThumbnail('Arrow navigation at '+viewport.width);
    if(viewport.width!==320){
      await evaluate('document.getElementById("tryon-reference-picker").scrollIntoView({block:"start",behavior:"instant"})');
      await capture('reference-picker-'+viewport.width);
    }
  }
  const assertImageGeometry=async (selector,shape,viewport,source,maxHeight)=>{
    await wait(`document.querySelector(${JSON.stringify(selector)})?.naturalWidth === ${shape.width} && document.querySelector(${JSON.stringify(selector)}).naturalHeight === ${shape.height} && !document.querySelector(${JSON.stringify(selector)}).hidden`);
    const geometry=await evaluate(`(()=>{
      const image=document.querySelector(${JSON.stringify(selector)}),rect=image.getBoundingClientRect();
      const parent=image.parentElement,bounds=parent.getBoundingClientRect(),style=getComputedStyle(parent);
      return {naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,width:rect.width,height:rect.height,
        left:rect.left,right:rect.right,viewportWidth:innerWidth,
        contentLeft:bounds.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),
        contentRight:bounds.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight)};
    })()`);
    aspectChecks++;
    console.log('ASPECT '+JSON.stringify({source,shape:shape.name,viewport:viewport.width,...geometry}));
    try {
      assert.equal(geometry.naturalWidth,shape.width,'Decoded fixture width');
      assert.equal(geometry.naturalHeight,shape.height,'Decoded fixture height');
      assert.ok(geometry.width>0&&geometry.height>0,'Image has visible layout dimensions');
      // Allow at most one CSS pixel of rounding, not stretched boxes hidden by object-fit.
      assert.ok(Math.abs(geometry.width-geometry.height*shape.width/shape.height)<=1,
        `Natural ratio ${shape.width}/${shape.height} must match displayed ${geometry.width}/${geometry.height}`);
      assert.ok(geometry.height<=maxHeight+1,'Image respects its height cap');
      assert.ok(geometry.left>=geometry.contentLeft-1&&geometry.right<=geometry.contentRight+1,'Image stays inside parent content width');
      assert.ok(geometry.left>=-1&&geometry.right<=geometry.viewportWidth+1,'Image stays inside viewport width');
    } catch(error) {
      aspectFailures.push(`${source}/${shape.name}/${viewport.width}: ${error.message}`);
    }
  };
  for(const viewport of viewports){
    await setViewport(viewport);
    await evaluate('document.getElementById("tryon-dialog").scrollTop=0');
    await capture('prepare-'+viewport.width);
    assert.ok(await evaluate('document.getElementById("tryon-dialog").scrollWidth<=document.getElementById("tryon-dialog").clientWidth+1'),'Preparation has no horizontal overflow');
    assert.ok(await evaluate('document.getElementById("tryon-camera").getBoundingClientRect().height>=44'),'Camera is a comfortable touch target');
    for(const id of ['tryon-camera','tryon-album'])for(const shape of shapes){
      await choosePhoto(id,shape.width,shape.height);
      await assertImageGeometry('#tryon-local-preview',shape,viewport,id,240);
      assert.match(await evaluate('document.getElementById("tryon-local-preview").src'),/^blob:/,'Every preview stays local');
    }
    // The intentional nine-panel crop must remain three times the reference frame.
    await wait('document.getElementById("tryon-reference-image").naturalWidth > 0');
    const crop=await evaluate(`(()=>{const frame=document.getElementById('tryon-reference').getBoundingClientRect(),image=document.getElementById('tryon-reference-image').getBoundingClientRect();return {width:image.width/frame.width,height:image.height/frame.height};})()`);
    assert.ok(Math.abs(crop.width-3)<.01&&Math.abs(crop.height-3)<.01,'Reference keeps its intentional 3x3 crop');
  }
  await client('Emulation.clearDeviceMetricsOverride');
  await evaluate('document.getElementById("tryon-close").click();document.getElementById("detail-tryon").click()');
  await choosePhoto('tryon-album');
  await wait('document.getElementById("tryon-local-preview")?.naturalWidth === 8 && !document.getElementById("tryon-local-preview").hidden');
  assert.match(await evaluate('document.getElementById("tryon-local-preview").src'),/^blob:/,'Preview stays local');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,0,'Selecting photo never uploads');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'No submission without explicit disclosure agreement');
  await evaluate('document.getElementById("tryon-consent").click()');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),false,'Photo and consent are sufficient for submission');
  assert.equal(await evaluate('document.getElementById("tryon-reference-options").open'),false,'Submission needs no interaction with outfit reference options');
  await evaluate('const mode=document.getElementById("tryon-pose-mode");mode.value="pose_grid";mode.dispatchEvent(new Event("change"))');
  assert.match(await evaluate('document.getElementById("tryon-pose-description").textContent'),/中央保留你的完整原图/);
  await evaluate('document.getElementById("tryon-pose-mode").value="original";document.getElementById("tryon-pose-mode").dispatchEvent(new Event("change"))');
  holdUpload=true;
  await evaluate('document.getElementById("tryon-submit").click();document.getElementById("tryon-submit").click()');
  for(let attempt=0;attempt<100&&!heldUpload;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(heldUpload,'Upload receipt is deliberately held while checking the frozen image selection');
  assert.ok(await evaluate('[...document.querySelectorAll("#tryon-reference-picker input")].every(input=>input.disabled)'),'All image choices are disabled during upload');
  await evaluate('document.querySelector("[data-reference-shot=\\"5\\"]").click()');
  assert.equal(await selectedReference(),'1','Busy upload cannot change its reference');
  heldUpload();heldUpload=null;
  await wait('document.getElementById("tryon-status").textContent.includes("已提交")');
  const upload=requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST');assert.equal(upload.length,1,'Double click cannot duplicate upload');
  const multipart=await new Request(origin,{method:'POST',headers:{'content-type':upload[0].headers['content-type']},body:upload[0].body}).formData();
  assert.deepEqual([...multipart.keys()].sort(),['disclosure_version','edition','idempotency_key','look_id','photo','shot_index']);
  assert.equal(multipart.get('look_id'),'100');assert.equal(multipart.get('edition'),'v2');assert.equal(multipart.get('shot_index'),'1');
  assert.equal(multipart.get('disclosure_version'),'test-v1');assert.match(multipart.get('idempotency_key'),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(multipart.get('photo').type,'image/png');assert.ok(multipart.get('photo').size>0);
  assert.equal(await evaluate('localStorage.length+sessionStorage.length'),0,'No credentials or base64 photos in Web Storage');
  assert.equal(await evaluate('document.getElementById("tryon-local-preview").hasAttribute("src")'),false,'Release local photo after submission');
  console.log('PASS active consent before multipart upload, frozen context, random idempotency and separate camera/album inputs');
  await wait('document.getElementById("tryon-jobs")?.textContent.includes("前方 7")');
  assert.equal(await evaluate('document.getElementById("tryon-step-generate").getAttribute("aria-current")'),'step');
  for(const viewport of viewports){
    await setViewport(viewport);
    await evaluate('document.querySelector("[data-job-id]").scrollIntoView({block:"start",behavior:"instant"})');
    const skeleton=await evaluate('(()=>{const r=document.querySelector(".tryon-photo-skeleton").getBoundingClientRect();return {width:r.width,height:r.height};})()');
    assert.ok(Math.abs(skeleton.width/skeleton.height-2/3)<.01,'Waiting keeps a portrait photograph skeleton');
    assert.equal(await evaluate('document.querySelector(".tryon-progress-steps [aria-current]").textContent'),'等待开始');
    assert.ok(await evaluate('document.getElementById("tryon-dialog").scrollWidth<=document.getElementById("tryon-dialog").clientWidth+1'),'Progress has no horizontal overflow');
    await capture('queued-'+viewport.width);
  }
  await client('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".tryon-photo-skeleton"),"::after").animationName'),'none','Reduced-motion users receive a still skeleton');
  await client('Emulation.setEmulatedMedia',{features:[]});
  await client('Emulation.clearDeviceMetricsOverride');
  assert.doesNotMatch(await evaluate('document.getElementById("tryon-jobs").textContent'),/输入最晚保留至|2026|服务器|Cookie/,'Queue cards show progress, not input lifecycle mechanics');
  await load();
  await wait('document.getElementById("tryon-jobs")?.textContent.includes("前方 7")');
  await evaluate('document.getElementById("tryon-history").click()');
  assert.match(await evaluate('document.getElementById("tryon-jobs").textContent'),/100.*参考.*01/,'Restored request keeps the automatic reference submitted with the job');
  assert.equal(await evaluate('document.getElementById("tryon-selection").hidden'),true,'History does not invent a new selection');
  assert.ok(!(await evaluate('document.getElementById("tryon-jobs").textContent')).includes('%'));
  jobs[0]={...jobs[0],status:'succeeded',image_url:'/api/tryons/fixture-job-1/image',download_url:'/api/tryons/fixture-job-1/download'};
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-id=fixture-job-1] img")?.naturalWidth > 0 && document.querySelector("[data-job-id=fixture-job-1] img").src.startsWith("blob:")');
  await evaluate('document.querySelector("[data-job-action=download]").focus();document.getElementById("tryon-refresh").click()');
  await wait('!document.getElementById("tryon-refresh").disabled');
  assert.equal(await evaluate('document.activeElement.dataset.jobAction'),'download','Refreshing preserves keyboard focus on a result download');
  const downloaded=await evaluate(`(async()=>{const r=await fetch(document.querySelector('[data-job-id] a[download]').href,{credentials:'same-origin'});return {status:r.status,type:r.headers.get('content-type'),disposition:r.headers.get('content-disposition'),bytes:(await r.arrayBuffer()).byteLength};})()`);
  assert.equal(downloaded.status,200);assert.equal(downloaded.type,'image/webp');assert.equal(downloaded.bytes, fs.statSync(path.join(root,'images-v2/look-001.webp')).size);
  for(const viewport of viewports){
    await setViewport(viewport);
    for(const shape of shapes){
      const dataURL=await evaluate(`(()=>{const canvas=document.createElement('canvas');canvas.width=${shape.width};canvas.height=${shape.height};const context=canvas.getContext('2d');context.fillStyle='#526b85';context.fillRect(0,0,canvas.width,canvas.height);return canvas.toDataURL('image/webp');})()`);
      assert.match(dataURL,/^data:image\/webp;base64,/,'Result fixture is actual browser-encoded WebP');
      resultImage=Buffer.from(dataURL.split(',')[1],'base64');
      // Unique owner-safe URLs avoid Chromium reusing a still-live decoded image.
      const id=`fixture-aspect-${viewport.width}-${shape.name}`;
      jobs[0]={...jobs[0],id,image_url:`/api/tryons/${id}/image`,download_url:`/api/tryons/${id}/download`};
      await evaluate('document.getElementById("tryon-refresh").click()');
      const selector=`[data-job-id=${id}] img`;
      await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.getElementById("tryon-refresh").disabled`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView()`);
      await assertImageGeometry(selector,shape,viewport,'result',560);
    }
  }
  await client('Emulation.clearDeviceMetricsOverride');
  resultImage=null;
  jobs[0]={...jobs[0],id:'fixture-job-1',image_url:'/api/tryons/fixture-job-1/image',download_url:'/api/tryons/fixture-job-1/download'};
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-id=fixture-job-1] img")?.naturalWidth > 0 && !document.getElementById("tryon-refresh").disabled');
  assert.equal(aspectChecks,viewports.length*shapes.length*3,'Every camera, album and result shape/viewport was measured');
  assert.deepEqual(aspectFailures,[],'Try-on image geometry must preserve intrinsic aspect ratio without overflow');
  console.log(`PASS ${aspectChecks} real Chromium camera/album/result aspect-ratio and bounds checks; intentional reference crop preserved`);
  const resultFailure=await evaluate(`(()=>{
    const card=document.querySelector('[data-job-id=fixture-job-1]'),image=card.querySelector('img');
    image.dispatchEvent(new Event('error'));
    return {hidden:image.hidden,notice:card.textContent};
  })()`);
  assert.equal(resultFailure.hidden,true);
  assert.match(resultFailure.notice,/结果暂时无法读取.*刷新/);
  assert.doesNotMatch(await evaluate('document.getElementById("tryon-jobs").textContent'),/FIFO|淘汰|1000/);
  for(const [status,message] of [['unknown','不自动重试'],['needs_photo','重新选择'],['expired','过期'],['failed','失败'],['canceled','取消'],['validating','检查'],['generating','生成'],['postprocessing','处理']]){
    jobs[0]={...jobs[0],id:'fixture-progress',status,image_url:null,download_url:null};
    await evaluate('document.getElementById("tryon-refresh").click()');
    await wait('document.querySelector("[data-job-id=fixture-progress]")?.dataset.jobStatus==='+JSON.stringify(status)+' && document.querySelector("[data-job-id=fixture-progress]").textContent.includes('+JSON.stringify(message)+')');
    if(['validating','generating','postprocessing'].includes(status)){
      assert.equal(await evaluate('document.querySelector(".tryon-progress-steps [aria-current]").textContent'),{validating:'检查照片',generating:'生成试穿',postprocessing:'整理成片'}[status]);
      assert.doesNotMatch(await evaluate('document.querySelector(".tryon-waiting").textContent'),/\d+\s*%|\d+\s*秒|\d+\s*分钟/,'Progress never invents timing or percent');
    }
    if(status==='unknown')assert.equal(await evaluate('document.querySelector("[data-job-retry=fixture-progress]").textContent'),'准备重试');
    if(status==='failed'){
      await evaluate('document.querySelector("[data-job-action=retry]").focus();document.getElementById("tryon-refresh").click()');
      await wait('!document.getElementById("tryon-refresh").disabled');
      assert.equal(await evaluate('document.activeElement.dataset.jobAction'),'retry','Refreshing preserves keyboard focus on a retry preparation action');
    }
    if(status==='generating'){
      await setViewport({width:390,height:844});
      await evaluate('document.querySelector("[data-job-id]").scrollIntoView({block:"start",behavior:"instant"})');
      await capture('generating-390');
      await client('Emulation.clearDeviceMetricsOverride');
    }
  }
  assert.equal(requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST').length,1,'State refresh never resubmits generation');
  const pendingDeleteIndex=requests.length;
  await evaluate('window.confirm=message=>{window.deleteNotice=message;return true;};document.querySelector("[data-job-delete=fixture-progress]").click()');
  const deleteNotice=await evaluate('window.deleteNotice');
  assert.match(deleteNotice,/记录.*保留/);assert.match(deleteNotice,/生成无法撤回/);
  assert.doesNotMatch(deleteNotice,/外部调用/);
  const readBack=()=>{
    const deleted=requests.findIndex((r,index)=>index>=pendingDeleteIndex&&r.method==='DELETE');
    return deleted>=0&&requests.slice(deleted+1).some(r=>r.url==='/api/tryons'&&r.method==='GET');
  };
  for(let n=0;n<100&&!readBack();n++)await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(readBack(),'Deletion verified by reading owner list back');
  await wait('!document.getElementById("tryon-refresh").disabled');
  assert.equal(jobs.length,0);assert.equal(requests.filter(r=>r.method==='DELETE').length,1);
  console.log('PASS durable queue restore, truthful states, real private preview/download bytes, delete and readback, no automatic generation replay');
  await evaluate('document.getElementById("tryon-close").click();document.querySelector("[data-open]").click();document.getElementById("detail-tryon").click()');
  await openReferenceOptions();
  await evaluate('document.querySelector("[data-reference-shot=\\"4\\"]").click()');
  await wait('!document.getElementById("tryon-refresh").disabled');
  const photoAndReference=`({
    preview:document.getElementById('tryon-local-preview').src,
    reference:document.getElementById('tryon-reference-image').src,
    shot:document.querySelector('#tryon-reference-picker input:checked').value
  })`;
  const existingHistory=await evaluate('[...document.querySelectorAll("[data-job-id]")].map(card=>card.dataset.jobId).sort()');
  for(const [code,guidance] of [['face_too_small',/更清晰的全身原图/],['face_count',/单人正面全身照/]]){
    uploadErrorStatus=422;uploadError={error:{code,message:'Test photo rejection'}};
    await choosePhoto('tryon-album',600,1200);
    await wait('!document.getElementById("tryon-submit").disabled');
    const selected=await evaluate(photoAndReference),requestIndex=requests.length;
    await evaluate('document.getElementById("tryon-submit").click()');
    await wait('document.getElementById("tryon-status").textContent.includes("未创建试穿任务") && document.getElementById("tryon-composer").getAttribute("aria-busy")==="false"');
    const status=await evaluate('document.getElementById("tryon-status").textContent');
    assert.match(status,guidance);
    assert.match(status,/保留头顶和鞋履/);
    assert.doesNotMatch(status,/刷新进度/);
    assert.match(selected.preview,/^blob:/);
    assert.equal(selected.shot,'4');
    assert.deepEqual(await evaluate(photoAndReference),selected,'Known rejection retains selected photo and exact reference artwork');
    assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'Known rejected photo needs re-selection before another submission');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-job-id]")].map(card=>card.dataset.jobId).sort()'),existingHistory,'A rejected photo does not create a job');
    assert.deepEqual(requests.slice(requestIndex).filter(r=>r.url==='/api/tryons').map(r=>r.method),['POST'],'Known rejection triggers no automatic upload or history request');
  }
  console.log('PASS explicit photo rejections preserve the full-body preview and reference, prompt re-selection and create no job');
  for(const [status,error,expected] of [[503,{error:{code:'provider_unavailable',message:'外部服务未配置'}},'provider_unavailable'],[503,{detail:'测试 detail 后备错误'},'测试 detail 后备错误'],[202,{},'暂未收到有效的试穿回执']]){
    await evaluate(`(()=>{
      const store=window.WardrobeTryOnStorage,save=store.putPhoto;
      const pendingWrite=new Promise(resolve=>{window.finishPhotoWrite=resolve;});
      store.putPhoto=async entry=>{
        store.putPhoto=save;
        await pendingWrite;
        return save(entry);
      };
    })()`);
    uploadErrorStatus=status;uploadError=error;await choosePhoto('tryon-camera');
    await wait('!document.getElementById("tryon-submit").disabled');
    await evaluate('document.getElementById("tryon-submit").click()');
    await wait('document.getElementById("tryon-status").textContent.includes('+JSON.stringify(expected)+')');
    const submitNotice=await evaluate('document.getElementById("tryon-status").textContent');
    assert.match(submitNotice,/未自动重试.*刷新进度/);
    await evaluate('window.finishPhotoWrite()');
    await wait('document.getElementById("tryon-library-status").textContent.includes("照片已保存到本机")');
    assert.equal(await evaluate('document.getElementById("tryon-status").textContent'),submitNotice,'A late local photo write must preserve the submission error');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-job-id]")].map(card=>card.dataset.jobId).sort()'),existingHistory,'Errors never manufacture success');
    assert.match(await evaluate('document.getElementById("tryon-local-preview").src'),/^blob:/,'A rejected upload preserves the local photo for explicit retry');
    assert.equal(await selectedReference(),'4','A rejected upload preserves the reference');
    const first=requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST').at(-1);
    await evaluate('document.getElementById("tryon-submit").click()');
    await wait('!document.getElementById("tryon-submit").disabled');
    const retry=requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST').at(-1);
    const key=async req=>(await new Request(origin,{method:'POST',headers:{'content-type':req.headers['content-type']},body:req.body}).formData()).get('idempotency_key');
    assert.equal(await key(first),await key(retry),'Explicit retry of the same photo/context reuses its idempotency key');
    await evaluate('document.getElementById("tryon-refresh").click()');
    await wait('!document.getElementById("tryon-refresh").disabled');
    assert.match(await evaluate('document.getElementById("tryon-local-preview").src'),/^blob:/,'Checking history does not discard the retained photo');
  }
  bootstrapError={detail:'测试离线边界'};await load();
  await wait('document.getElementById("tryon-status").textContent.includes("测试离线边界")');
  assert.ok(await evaluate('document.querySelectorAll("[data-look-card]").length > 0'),'Gallery survives unavailable API');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true);
  console.log('PASS coded API errors, detail fallback, no fabricated success, gallery usable during bootstrap failure');
  bootstrapError=null;await load();
  await wait('document.getElementById("tryon-availability").textContent.includes("已连接")');
  await evaluate('document.querySelector("[data-open]").click();document.getElementById("detail-tryon").click()');
  await wait('Boolean(window.WardrobeTryOn.track)');
  const eventCount=requests.filter(r=>r.url==='/api/events').length;
  await evaluate(`window.WardrobeTryOn.track('not_allowed',{photo:'private',token:'secret'});window.WardrobeTryOn.track('look_open',{look_id:100,edition:'v2',shot_index:9,filename:'private.jpg',query:'secret',token:'secret',photo:'private'})`);
  await new Promise(resolve=>setTimeout(resolve,100));
  const events=requests.filter(r=>r.url==='/api/events');
  assert.equal(events.length,eventCount+1,'Unallowlisted event never sent');
  assert.ok(events.some(r=>JSON.parse(r.body).event==='page_view'));
  assert.ok(events.some(r=>JSON.parse(r.body).event==='tryon_open'));
  for(const req of events){
    assert.equal(req.headers['x-csrf-token'],'test-csrf');assert.match(req.headers.cookie||'',/visitor_fixture=/);
    const payload=JSON.parse(req.body);assert.ok(['page_view','look_open','tryon_open'].includes(payload.event));
    assert.match(payload.event_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(Object.keys(payload).every(key=>['event','event_id','look_id','edition','shot_index'].includes(key)));
    assert.ok(!req.body.toString().includes('secret'));assert.ok(!req.body.toString().includes('private'));
  }
  console.log('PASS first-party allowlisted analytics, random event IDs, CSRF and no free-text/photo/credential fields');
  paginate=true;jobs=[{id:'fixture-a',look_id:1,edition:'v1',shot_index:1,status:'failed'},{id:'fixture-b',look_id:2,edition:'v2',shot_index:2,status:'unknown'}];
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-id=fixture-a]")');
  assert.equal(await evaluate('document.getElementById("tryon-more")?.hidden'),false,'Owner history with more pages must be accessible');
  await evaluate('document.getElementById("tryon-more").click()');
  await wait('document.querySelector("[data-job-id=fixture-b]")');
  assert.equal(await evaluate('document.querySelectorAll("[data-job-id=fixture-a], [data-job-id=fixture-b]").length'),2);
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('!document.getElementById("tryon-refresh").disabled');
  assert.equal(await evaluate('document.querySelectorAll("[data-job-id=fixture-a], [data-job-id=fixture-b]").length'),2,'Refresh preserves expanded history without duplicates');
  console.log('PASS owner history pagination and expanded refresh (list pagination is not a generation quota)');
  paginate=false;jobs=[];uploadError=null;nextJobId='fixture-stale-list';await load();
  await wait('document.getElementById("tryon-jobs-status").textContent.includes("进度已更新")');
  holdList=true;
  await evaluate('document.getElementById("search").value="100";document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-open]").click();document.querySelector("[data-view=\\"4\\"]").click();document.getElementById("detail-tryon").click()');
  await wait('document.getElementById("tryon-refresh").disabled');
  await choosePhoto('tryon-album');await wait('!document.getElementById("tryon-submit").disabled');
  await evaluate('document.getElementById("tryon-submit").click()');
  await wait('document.getElementById("tryon-status").textContent.includes("已提交")');
  assert.ok(heldList,'HTTP list response deliberately held at pre-submit state');
  heldList();heldList=null;
  await new Promise(resolve=>setTimeout(resolve,100));
  await wait('document.getElementById("tryon-jobs").textContent.includes("前方 7") && !document.getElementById("tryon-refresh").disabled');
  console.log('PASS in-flight stale history cannot erase a newly accepted job or stop status polling');
  // The real ASGI regressions cover server auth semantics; this Chromium fixture
  // additionally proves a decoded local photo is never replayed after auth loss.
  for(const [status,code] of [[401,'session'],[403,'csrf']]){
    uploadErrorStatus=status;uploadError={error:{code,message:'Disposable stale session/CSRF'}};
    await load();await wait('document.getElementById("tryon-availability").textContent.includes("已连接")');
    await evaluate('document.querySelector("[data-open]").click();document.querySelector("[data-view=\\"4\\"]").click();document.getElementById("detail-tryon").click()');
    await choosePhoto('tryon-album');await wait('!document.getElementById("tryon-submit").disabled');
    const before=requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length;
    const boots=requests.filter(r=>r.url==='/api/bootstrap').length;
    await evaluate('document.getElementById("tryon-submit").click()');
    await wait('document.getElementById("tryon-status").textContent.includes("未自动重试")');
    assert.match(await evaluate('document.querySelector("[data-job-id=fixture-job-1] img")?.src'),/^blob:/,'Auth loss retains a previously saved local result');
    assert.ok(await evaluate('[...document.querySelectorAll("#tryon-jobs img")].every(image=>!image.src.includes("/api/tryons/"))'),'Auth loss removes remote private image URLs');
    assert.equal(await evaluate('document.getElementById("tryon-consent").checked'),false);
    assert.equal(await evaluate('document.getElementById("tryon-local-preview").hasAttribute("src")'),false);
    assert.equal(requests.filter(r=>r.url==='/api/bootstrap').length,boots,'Photo error does not silently reconnect');
    assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,before+1);
    await evaluate('document.getElementById("tryon-refresh").click()');
    await wait('document.getElementById("tryon-jobs-status").textContent.includes("进度已更新")');
    assert.equal(requests.filter(r=>r.url==='/api/bootstrap').length,boots+1);
    assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,before+1,'Explicit reconnect never replays the photo');
    assert.match(await evaluate('document.getElementById("tryon-jobs-status").textContent'),/访问凭证.*无法恢复/);
    assert.equal(await evaluate('localStorage.length+sessionStorage.length'),0);
  }
  console.log('PASS 401/session and 403/CSRF purge active photo/consent and remote URLs, retain local results, and never replay');
  // Exercise the same shipped page with a server-only full catalog revision.
  // No fixture content is written to the repository or treated as AI output.
  catalogFixture=structuredClone(baseline);
  catalogFixture.models=[{model_id:'female-01',name:'01 号模特'},{model_id:'female-02',name:'02 号模特'}];
  for(const id of [101,102]){
    const look=JSON.parse(JSON.stringify(catalogFixture.looks[0]));
    Object.assign(look,{id,title:'动态穿搭 '+id,model_id:id===101?'female-01':'female-02',region:{country:'中国',city:id===101?'上海':'成都'},batch_id:'fixture-'+id,publish_date:id===101?'2026-11-12':'2026-11-13',editorialOrder:id});
    look.versions={v2:{...look.versions.v2,image:'https://cdn.invalid/'+id+'.webp',image_url:'https://cdn.invalid/'+id+'.webp',source_url:'/api/content/assets/fixture-'+id,download_url:'/api/content/assets/fixture-'+id+'/download'}};
    catalogFixture.looks.push(look);
  }
  uploadError=null;jobs=[];
  await evaluate('localStorage.setItem("wardrobe99:favorites:v1","[9999,101]")');
  await load();await wait('window.WARDROBE.looks.some(look=>look.id===102)');
  await evaluate('location.hash="#/looks"');await wait('!document.getElementById("collection").hidden');
  assert.equal(await evaluate('document.querySelectorAll("[data-edition]").length'),0);
  assert.equal(await evaluate('parseInt(document.getElementById("hero-total").textContent,10)'),catalogFixture.looks.length);
  const catalogRequest=requests.filter(r=>r.url==='/api/content/catalog').at(-1);
  assert.equal(catalogRequest.headers.cookie,undefined,'Public catalog must omit the private visitor credential');
  await evaluate('document.getElementById("model-filter").value="female-02";document.getElementById("model-filter").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#gallery [data-look-card]")].map(el=>Number(el.dataset.lookCard))'),[102]);
  await evaluate('document.querySelector("#gallery [data-look-card] img").dispatchEvent(new Event("error"))');
  await wait('document.querySelector("#gallery [data-look-card] img").getAttribute("src") === "/api/content/assets/fixture-102" && document.querySelector("#gallery [data-look-card] img").naturalWidth > 0');
  await evaluate(`document.querySelector('[data-open="102"]').click();document.querySelector('[data-view="7"]').click();document.getElementById('detail-tryon').click()`);
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'),/LOOK 102 · 动态穿搭 102/,'Hydrated look and model use the live catalog');
  assert.equal(await selectedReference(),'1','Viewing panel seven does not change the outfit reference');
  await evaluate('document.getElementById("tryon-close").click();document.getElementById("detail-image").dispatchEvent(new Event("error"))');
  await wait('document.getElementById("detail-image").getAttribute("src") === "/api/content/assets/fixture-102" && document.getElementById("detail-image").naturalWidth > 0');
  const publicDownload=await evaluate('(async()=>{const r=await fetch(document.getElementById("download-link").href);return {status:r.status,type:r.headers.get("content-type"),disposition:r.headers.get("content-disposition"),bytes:(await r.arrayBuffer()).byteLength};})()');
  assert.equal(publicDownload.status,200);assert.equal(publicDownload.type,'image/webp');assert.match(publicDownload.disposition,/attachment/);assert.ok(publicDownload.bytes>0);
  await evaluate('document.getElementById("detail-image").dispatchEvent(new Event("error"))');
  assert.equal(await evaluate('document.getElementById("detail-image").hidden'),true);
  assert.equal(await evaluate('document.getElementById("detail-photo-frame").dataset.imageStatus'),'图片暂不可用');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("wardrobe99:favorites:v1"))'),[9999,101]);
  await evaluate('document.getElementById("close-detail").click();document.getElementById("reset-filters").click();document.getElementById("latest-only").click()');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#gallery [data-look-card]")].map(el=>Number(el.dataset.lookCard))'),[102]);
  for(const viewport of viewports){await setViewport(viewport);assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),'Dynamic filters fit the viewport');}
  await client('Emulation.clearDeviceMetricsOverride');
  assert.ok(!requests.some(r=>/^\/images\/look-/.test(r.url)),'Archived v1 photography is never requested by the public page');
  console.log('PASS real Chromium API hydration above 100, second model, preserved unknown favorites, latest filters, public download and one-shot CDN fallback at mobile/desktop widths');
  // Use the actual published 102 shot script, without changing repository content
  // or invoking an image provider. All HTTP endpoints remain the local fixture.
  const publishedShots=JSON.parse(fs.readFileSync(path.join(root,'content/batches/2026-11-12-01.json'),'utf8')).looks.find(look=>look.id===102).shots;
  const dynamicLook=catalogFixture.looks.find(look=>look.id===102);
  dynamicLook.versions.v2.shots=structuredClone(publishedShots);
  dynamicLook.versions.v2.previewPanel=2;
  const uploadsBeforeFraming=requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length;
  await load();await wait('window.WARDROBE.looks.some(look=>look.id===102)');
  await evaluate('location.hash="#look-102"');await wait('document.getElementById("detail-dialog").open');
  await evaluate('document.getElementById("detail-tryon").click()');
  assert.equal(await selectedReference(),'1','A full-body reference takes priority over a close-up cover');
  await openReferenceOptions();
  await wait('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.naturalWidth>0)');
  assert.ok(await evaluate('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.getAttribute("src")==="/api/content/assets/fixture-102")'),'Dynamic look switches all nine thumbnails and follows project-source fallback');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#tryon-reference-picker input")].map(input=>({value:input.value,label:input.getAttribute("aria-label")}))'),
    publishedShots.map((shot,i)=>({value:String(i+1),label:'参考 '+String(i+1).padStart(2,'0')+' · '+shot.title+' · '+shot.framing})));
  for(const [index,shot] of publishedShots.entries()){
    const panel=index+1;
    await evaluate(`document.querySelector('[data-reference-shot="${panel}"]').click()`);
    assert.equal(await evaluate('document.getElementById("tryon-reference-framing").textContent'),'画面景别 / '+shot.framing);
    assert.deepEqual(await evaluate('[document.getElementById("tryon-reference-image").style.left,document.getElementById("tryon-reference-image").style.top]'),
      [-(index%3)*100+'%',-Math.floor(index/3)*100+'%'],'Actual 102 reference crop preserves row-major panel '+panel);
  }
  for(const panel of [1,3,7])assert.match(publishedShots[panel-1].framing,/全身.*双靴/,'Actual shoe-visible references stay explicit');
  assert.match(publishedShots[1].framing,/坐姿腰上/);
  const longFraming='胸上近景，完整头部与发顶；请查看画面中实际呈现的衣装层次。'.repeat(12)+'<仅为测试文本>&';
  for(const framing of [undefined,'','   ',longFraming]){
    await evaluate('document.getElementById("tryon-close").click()');
    const variant=structuredClone(dynamicLook);
    if(framing==='')for(const shot of variant.versions.v2.shots)delete shot.framing;
    if(framing===undefined)delete variant.versions.v2.shots[0].framing;
    else variant.versions.v2.shots[0].framing=framing;
    await evaluate(`window.WardrobeTryOn.setCatalog({looks:[${JSON.stringify(variant)}]});window.WardrobeTryOn.setContext({look_id:102,edition:'v2'});document.getElementById('detail-tryon').click()`);
    assert.equal(await selectedReference(),framing===''?'2':'3','Use the first full-body shot, falling back to the cover when framing is absent');
    await openReferenceOptions();
    const expected=framing?.trim()||'';
    assert.equal(await evaluate('document.querySelector("[data-reference-shot=\\"1\\"]").getAttribute("aria-label")'),'参考 01 · '+publishedShots[0].title+(expected?' · '+expected:''));
    await evaluate('document.querySelector("[data-reference-shot=\\"1\\"]").click()');
    assert.equal(await evaluate('document.getElementById("tryon-reference-framing").textContent'),expected?'画面景别 / '+expected:'该画面未提供景别说明，请查看参考图确认覆盖的衣装。');
    assert.equal(await evaluate('document.getElementById("tryon-reference-framing").children.length'),0,'Framing is plain text');
    for(const viewport of viewports){
      await setViewport(viewport);
      const bounds=await assertReferenceBounds('Published/missing/long framing '+viewport.width);
      if(expected)assert.ok(bounds.text.height>bounds.lineHeight*2,'Long framing is readable over multiple lines');
    }
  }
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,uploadsBeforeFraming,'Reference inspection never uploads a photo or submits generation');
  await client('Emulation.clearDeviceMetricsOverride');
  console.log('PASS published 102 and historical 100 actual framing, nine index/crop mappings, frozen context, missing/empty fallback, accessible readable long descriptions at 320/390/1280px; no generation submission');
  await evaluate('document.getElementById("tryon-close").click()');
  const safeVariant=structuredClone(dynamicLook);
  safeVariant.versions.v2.image_url='https://fixture-user:fixture-password@invalid.example/reference.webp';
  await evaluate(`window.WardrobeTryOn.setCatalog({looks:[${JSON.stringify(safeVariant)}]});window.WardrobeTryOn.setContext({look_id:102,edition:'v2'});document.getElementById('detail-tryon').click()`);
  await wait('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.naturalWidth>0)');
  assert.ok(await evaluate('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.getAttribute("src")==="/api/content/assets/fixture-102")'),'Credential-bearing preferred URL is rejected in favor of registered project source');
  await evaluate('document.querySelector(".tryon-reference-thumbnail img").dispatchEvent(new Event("error"))');
  assert.equal(await evaluate('document.querySelector("[data-reference-shot=\\"1\\"]").disabled'),true);
  assert.equal(await evaluate('document.querySelector("[data-reference-shot=\\"2\\"]").disabled'),false,'A failed tile never substitutes or disables an unrelated loaded panel');
  await choosePhoto('tryon-album');await wait('!document.getElementById("tryon-local-preview").hidden');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'A failed selected picture blocks blind submission');
  assert.equal(await evaluate('document.querySelector("#tryon-reference-picker input:checked").value'),'1','Failure never silently selects another panel');
  assert.match(await evaluate('document.getElementById("tryon-reference-error").textContent'),/图片暂不可用.*不会替换/);
  await evaluate('document.getElementById("tryon-close").click()');
  const missingVariant=structuredClone(safeVariant);missingVariant.versions.v2.source_url='/api/content/assets/fixture-missing-reference';
  await evaluate(`window.WardrobeTryOn.setCatalog({looks:[${JSON.stringify(missingVariant)}]});window.WardrobeTryOn.setContext({look_id:102,edition:'v2'});document.getElementById('detail-tryon').click()`);
  await wait('[...document.querySelectorAll("#tryon-reference-picker input")].every(input=>input.disabled)');
  assert.ok(await evaluate('[...document.querySelectorAll(".tryon-reference-thumbnail img")].every(image=>image.hidden)'),'Missing source pictures show an honest unavailable state');
  await evaluate('document.getElementById("tryon-close").click()');
  const unsafeVariant=structuredClone(safeVariant);unsafeVariant.versions.v2.source_url='/api/admin/private-reference';
  await evaluate(`window.WardrobeTryOn.setCatalog({looks:[${JSON.stringify(unsafeVariant)}]});window.WardrobeTryOn.setContext({look_id:102,edition:'v2'});document.getElementById('detail-tryon').click()`);
  await wait('[...document.querySelectorAll("#tryon-reference-picker input")].every(input=>input.disabled)');
  assert.ok(!requests.some(request=>request.url==='/api/admin/private-reference'),'Malformed private fallback is never requested');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,uploadsBeforeFraming);
  console.log('PASS visual nine-image reference picker, native radios and 2D keyboard, accurate shot upload, busy lock, safe project fallback and explicit image failure without panel substitution');

  // The fixture intentionally withholds the backend while serving the same origin.
  // Use synthetic photos only, and verify the actual persisted bytes after a reload.
  const cachedResult='[data-job-id=fixture-job-1]';
  const previousPhotos=await evaluate('window.WardrobeTryOnStorage.listPhotos().then(rows=>rows.map(row=>row.id))');
  const postsBeforeDashboard=requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length;
  bootstrapError={error:{code:'fixture_offline',message:'Synthetic service outage'}};
  await load();
  await evaluate('document.getElementById("tryon-history").click()');
  await wait(`document.querySelector('${cachedResult} img')?.src.startsWith('blob:')`);
  await evaluate(`document.querySelector('${cachedResult} img').scrollIntoView({block:'center',behavior:'instant'})`);
  await wait(`document.querySelector('${cachedResult} img')?.naturalWidth>0`);
  await choosePhoto('tryon-camera',600,1200);
  await wait(`window.WardrobeTryOnStorage.listPhotos().then(rows=>rows.length>${previousPhotos.length})`);
  const saved=await evaluate(`(async()=>{
    const entry=(await window.WardrobeTryOnStorage.listPhotos()).find(row=>!${JSON.stringify(previousPhotos)}.includes(row.id));
    return {id:entry.id,bytes:Array.from(new Uint8Array(await entry.blob.arrayBuffer()))};
  })()`);
  await setViewport({width:390,height:844});
  await load();
  await evaluate('document.getElementById("tryon-history").click()');
  const photoCard=`[data-saved-photo-id="${saved.id}"]`;
  await wait(`document.querySelector(${JSON.stringify(photoCard+' img')})?.naturalWidth>0`);
  assert.ok(await evaluate('document.getElementById("tryon-dialog").scrollWidth<=document.getElementById("tryon-dialog").clientWidth+1'),'Local dashboard does not overflow a phone');
  await capture('dashboard-local-390');

  const beforeOfflineDelete=requests.filter(r=>r.method==='DELETE').length;
  await evaluate('window.confirm=()=>true;document.querySelector("[data-job-delete=fixture-job-1]").click()');
  await wait(`!document.querySelector('${cachedResult}') && window.WardrobeTryOnStorage.listJobs().then(rows=>rows.some(j=>j.id==='fixture-job-1'&&j.deleted&&!j.cachedImage))`);
  assert.equal(requests.filter(r=>r.method==='DELETE').length,beforeOfflineDelete,'Deleting offline erases the browser image without pretending to contact the server');

  bootstrapError=null;
  jobs=[{id:'fixture-job-1',status:'succeeded',look_id:100,edition:'v2',shot_index:4,created_at:'2026-11-11T00:00:00Z',image_url:'/api/tryons/fixture-job-1/image',download_url:'/api/tryons/fixture-job-1/download'}];
  await load();
  await wait('document.getElementById("tryon-availability").textContent.includes("已连接")');
  await evaluate('document.getElementById("tryon-history").click()');
  await wait(`window.WardrobeTryOnStorage.listJobs().then(rows=>rows.some(j=>j.id==='fixture-job-1'&&j.deleted&&!j.pending))`);
  assert.equal(jobs.some(j=>j.id==='fixture-job-1'),false,'The matching owner session completes the requested result deletion');
  assert.equal(await evaluate(`Boolean(document.querySelector('${cachedResult}'))`),false,'A remotely listed copy cannot resurrect a locally deleted result');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,postsBeforeDashboard,'Adding, reopening and deleting local data does not submit a try-on');

  jobs=[{id:'fixture-delivery-unknown',status:'unknown',pose_mode:'pose_grid',look_id:100,edition:'v2',shot_index:4,created_at:'2026-11-11T00:00:00Z',error_code:'delivery_unknown',error_message:'Provider delivery is uncertain; this request will not be replayed'}];
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-retry=fixture-delivery-unknown]")');
  await evaluate('document.querySelector("[data-job-retry=fixture-delivery-unknown]").click()');
  assert.equal(await evaluate('document.activeElement.id'),'tryon-photo-title');
  assert.equal(await selectedReference(),'4','A history retry preserves the original clothing reference');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'Preparing a retry requires choosing a photo');
  assert.equal(await evaluate('document.getElementById("tryon-retry-notice").hidden'),false);
  assert.match(await evaluate('document.getElementById("tryon-retry-notice").textContent'),/可能已被接收.*新建/);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,postsBeforeDashboard,'Preparing a retry never dispatches a request');
  await wait(`document.querySelector(${JSON.stringify(photoCard+' [data-photo-select]')})`);
  await evaluate(`document.querySelector(${JSON.stringify(photoCard+' [data-photo-select]')}).click()`);
  await wait('!document.getElementById("tryon-submit").disabled');
  assert.equal(await evaluate('document.getElementById("tryon-submit").textContent'),'提交新试穿');
  assert.equal(await evaluate('document.getElementById("tryon-submit").getAttribute("aria-describedby")'),'tryon-retry-notice');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,postsBeforeDashboard,'Selecting a saved photo alone never uploads it');
  nextJobId='fixture-dashboard-reuse';
  await evaluate('document.getElementById("tryon-submit").click();document.getElementById("tryon-submit").click()');
  await wait('document.getElementById("tryon-status").textContent.includes("已提交")');
  const lastUpload=requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').at(-1);
  const reused=await new Request(origin,{method:'POST',headers:{'content-type':lastUpload.headers['content-type']},body:lastUpload.body}).formData();
  assert.equal(reused.get('look_id'),'100');
  assert.equal(reused.get('edition'),'v2');
  assert.equal(reused.get('shot_index'),'4');
  assert.equal(reused.get('pose_mode'),'pose_grid','Retry preserves the original pose mode');
  assert.notEqual(reused.get('idempotency_key'),multipart.get('idempotency_key'),'The new attempt uses an independent request key');
  assert.deepEqual(Buffer.from(await reused.get('photo').arrayBuffer()),Buffer.from(saved.bytes),'Reused photo uploads the original bytes');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,postsBeforeDashboard+1);
  assert.equal(await evaluate('document.querySelector("[data-job-id=fixture-delivery-unknown]").dataset.jobStatus'),'unknown','An explicit attempt preserves the original uncertain record');

  await wait(`document.querySelector(${JSON.stringify(photoCard+' [data-photo-delete]')})?.disabled===false`);
  await evaluate(`window.confirm=()=>true;document.querySelector(${JSON.stringify(photoCard+' [data-photo-delete]')}).click()`);
  await wait(`window.WardrobeTryOnStorage.listPhotos().then(rows=>rows.every(row=>row.id!==${JSON.stringify(saved.id)}))`);
  await load();
  await evaluate('document.getElementById("tryon-history").click()');
  await wait('document.querySelector("[data-job-id=fixture-dashboard-reuse]")');
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(photoCard)}))`),false,'Deleted local photo stays gone after reload');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,postsBeforeDashboard+1);
  console.log('PASS no-login dashboard: persistence, deletion, phone layout and explicit retry with a new key, preserved history and byte-exact photo reuse');
} finally {
  if(client&&socket?.readyState===1)await Promise.race([client('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
  if(processChrome.exitCode===null&&processChrome.signalCode===null){const exit=once(processChrome,'exit');try{process.kill(-processChrome.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}await exit;}
  socket?.close();
  await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log('Try-on real DOM/HTTP regression passed (synthetic API fixture; no provider call).');
