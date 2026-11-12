import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

// Real Chromium DOM/event + HTTP adapter regression. The HTTP API below is an
// explicitly synthetic TEST fixture, never a provider or production success.
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = process.env.TMPDIR || os.tmpdir();
// Chromium's singleton UNIX socket needs a short temp path. When retaining test
// artifacts under a long TMPDIR, set CHROME_TMPDIR to a short private scratch dir.
const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome',
  ...['1248','1243'].map(v => path.join(os.homedir(), `.cache/ms-playwright/chromium-${v}/chrome-linux64/chrome`))].filter(Boolean);
const chrome = candidates.find(p => fs.existsSync(p));
assert.ok(chrome, 'Real DOM tests require Chromium; set CHROME_BIN (no production dependency).');
let available = false, jobs = [], accept = false, uploadError = null, uploadErrorStatus=503, bootstrapError = null, paginate=false, holdList=false, heldList=null;
const requests = [];
let catalogFixture=null;
let resultImage = null; // Browser-encoded synthetic WebP; never a provider output.
const bootstrap = () => ({csrf_token:'test-csrf',visitor:{id:'test-visitor'},generation_available:available,
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
    if(req.url==='/api/tryons/fixture-job-1'&&req.method==='DELETE'){
      assert.equal(req.headers['x-csrf-token'],'test-csrf');jobs=[];res.end('{"deleted":true}');return;
    }
    if(req.url==='/api/tryons/fixture-job-1/image'||req.url==='/api/tryons/fixture-job-1/download'||/^\/api\/tryons\/fixture-aspect-\d+-(portrait|landscape|square)\/(image|download)$/.test(req.url)){
      assert.match(req.headers.cookie||'',/visitor_fixture=/);res.setHeader('Content-Type','image/webp');
      if(req.url.endsWith('/download'))res.setHeader('Content-Disposition','attachment; filename="synthetic-test-output.webp"');
      res.end(resultImage || fs.readFileSync(path.join(root,'images/look-001.webp')));return;
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
      const job={id:'fixture-job-1',status:'queued',look_id:100,edition:'v2',shot_index:4,queue_position:7,created_at:'2026-11-11T00:00:00Z',original_expires_at:'2026-11-11T01:00:00Z',image_url:null,download_url:null,error_code:null,error_message:null};
      jobs=[job];res.statusCode=202;res.end(JSON.stringify(job));return;
    }
    res.statusCode=503;res.end('{"error":{"code":"fixture_unavailable","message":"测试服务未配置"}}');return;
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
  const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('DOM condition timed out: '+expression);};
  const load=async()=>{await client('Page.navigate',{url:origin});await wait('document.readyState === "complete"');};
  await load();
  assert.ok(requests.some(r=>r.url==='/api/bootstrap'), 'Page load must securely bootstrap a visitor without requiring a try-on click');
  await wait('document.getElementById("tryon-availability")?.textContent.includes("暂不可用")');
  assert.equal(await evaluate('document.cookie'),'','Visitor credential must be HttpOnly');
  assert.equal(await evaluate('localStorage.length'),0,'No visitor credential in local storage');
  await evaluate('document.querySelector("[data-open]").click()');
  assert.equal(await evaluate('document.getElementById("detail-tryon").hidden'),false,'Visible detail action');
  await evaluate('document.getElementById("detail-tryon").click()');
  await wait('document.getElementById("tryon-dialog").open');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true);
  assert.ok(!(await evaluate('document.getElementById("tryon-dialog").textContent')).includes('登录'));
  console.log('PASS secure automatic bootstrap, honest unavailable state, visible detail action, no account/storage');
  available=true;
  await load();
  await wait('document.getElementById("tryon-availability")?.textContent.includes("已连接")');
  await evaluate('document.getElementById("search").value="100";document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-open=\\"100\\"]").click()');
  await evaluate('document.getElementById("detail-tryon").click()');
  assert.equal(await evaluate('document.getElementById("tryon-panel")?.value'),'0','Montage 0 requires explicit panel selection, never silently use panel 1');
  assert.equal(await evaluate('document.getElementById("tryon-panel").options.length'),10,'All nine panels plus explicit unselected montage state');
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'), /100.*生动/);
  await evaluate('document.getElementById("tryon-panel").value="9";document.getElementById("tryon-panel").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'), /100.*生动.*09/);
  await evaluate('document.querySelector("[data-view=\\"4\\"]").click()');
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'), /100.*生动.*09/,'Open request stays frozen when the underlying panel changes');
  await evaluate('document.getElementById("tryon-close").click();document.getElementById("detail-tryon").click()');
  assert.equal(await evaluate('document.getElementById("tryon-panel").value'),'4');
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'), /100.*生动.*04/);
  const before=await evaluate('document.getElementById("detail-title").textContent');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
  assert.equal(await evaluate('document.getElementById("detail-title").textContent'),before,'Try-on modal blocks underlying detail keyboard navigation');
  console.log('PASS frozen look/edition/panel, all nine choices from montage 0, selected-panel handoff and modal keyboard guard');
  const disclosure=await evaluate('document.getElementById("tryon-disclosure")?.textContent || ""');
  assert.match(disclosure,/第三方 AI/,'Disclose external processing');assert.match(disclosure,/后台评估/);
  assert.equal(await evaluate('document.querySelectorAll("#tryon-disclosure li").length'),1,'Single concise photo-purpose notice');
  assert.match(disclosure,/本人同意.*同意上述用途/);
  assert.doesNotMatch(disclosure,/1 小时|一小时|1000|FIFO|Cookie|幂等|持久队列/);
  assert.equal(await evaluate('document.getElementById("tryon-camera").getAttribute("capture")'),'user');
  assert.equal(await evaluate('document.getElementById("tryon-album").hasAttribute("capture")'),false);
  const choosePhoto=async (id,width=8,height=8)=>evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=${width};canvas.height=${height};
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
  await choosePhoto('tryon-album');
  await wait('document.getElementById("tryon-local-preview")?.naturalWidth === 8 && !document.getElementById("tryon-local-preview").hidden');
  assert.match(await evaluate('document.getElementById("tryon-local-preview").src'),/^blob:/,'Preview stays local');
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='/api/tryons').length,0,'Selecting photo never uploads');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'No submission without explicit disclosure agreement');
  await evaluate('document.getElementById("tryon-consent").click()');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),false);
  await evaluate('document.getElementById("tryon-panel").value="0";document.getElementById("tryon-panel").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.equal(await evaluate('document.getElementById("tryon-submit").disabled'),true,'Montage 0 stays blocked even with photo and consent');
  await evaluate('document.getElementById("tryon-panel").value="4";document.getElementById("tryon-panel").dispatchEvent(new Event("change",{bubbles:true}))');
  await evaluate('document.getElementById("tryon-submit").click();document.getElementById("tryon-submit").click()');
  await wait('document.getElementById("tryon-status").textContent.includes("已提交")');
  const upload=requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST');assert.equal(upload.length,1,'Double click cannot duplicate upload');
  const multipart=await new Request(origin,{method:'POST',headers:{'content-type':upload[0].headers['content-type']},body:upload[0].body}).formData();
  assert.deepEqual([...multipart.keys()].sort(),['disclosure_version','edition','idempotency_key','look_id','photo','shot_index']);
  assert.equal(multipart.get('look_id'),'100');assert.equal(multipart.get('edition'),'v2');assert.equal(multipart.get('shot_index'),'4');
  assert.equal(multipart.get('disclosure_version'),'test-v1');assert.match(multipart.get('idempotency_key'),/^[a-f0-9-]{36}$/);
  assert.equal(multipart.get('photo').type,'image/png');assert.ok(multipart.get('photo').size>0);
  assert.equal(await evaluate('localStorage.length+sessionStorage.length'),0,'No browser credential/photo persistence');
  assert.equal(await evaluate('document.getElementById("tryon-local-preview").hasAttribute("src")'),false,'Release local photo after submission');
  console.log('PASS active consent before multipart upload, frozen context, random idempotency, camera/album local preview and no photo storage');
  await wait('document.getElementById("tryon-jobs")?.textContent.includes("前方 7")');
  assert.doesNotMatch(await evaluate('document.getElementById("tryon-jobs").textContent'),/输入最晚保留至|2026|服务器|Cookie/,'Queue cards show progress, not input lifecycle mechanics');
  await load();
  await wait('document.getElementById("tryon-jobs")?.textContent.includes("前方 7")');
  await evaluate('document.getElementById("tryon-history").click()');
  assert.match(await evaluate('document.getElementById("tryon-jobs").textContent'),/100.*生动.*04/,'Restored request keeps original context');
  assert.equal(await evaluate('document.getElementById("tryon-selection").hidden'),true,'History does not invent a new selection');
  assert.ok(!(await evaluate('document.getElementById("tryon-jobs").textContent')).includes('%'));
  jobs[0]={...jobs[0],status:'succeeded',image_url:'/api/tryons/fixture-job-1/image',download_url:'/api/tryons/fixture-job-1/download'};
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-id] img")?.naturalWidth > 0');
  assert.equal(await evaluate('document.querySelector("[data-job-id] img").getAttribute("src")'),'/api/tryons/fixture-job-1/image');
  const downloaded=await evaluate(`(async()=>{const r=await fetch(document.querySelector('[data-job-id] a[download]').href,{credentials:'same-origin'});return {status:r.status,type:r.headers.get('content-type'),disposition:r.headers.get('content-disposition'),bytes:(await r.arrayBuffer()).byteLength};})()`);
  assert.equal(downloaded.status,200);assert.equal(downloaded.type,'image/webp');assert.match(downloaded.disposition,/attachment/);assert.ok(downloaded.bytes>0);
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
      await wait('document.querySelector("[data-job-id] img") && !document.getElementById("tryon-refresh").disabled');
      await evaluate('document.querySelector("[data-job-id] img").scrollIntoView()');
      await assertImageGeometry('[data-job-id] img',shape,viewport,'result',560);
    }
  }
  await client('Emulation.clearDeviceMetricsOverride');
  resultImage=null;
  jobs[0]={...jobs[0],id:'fixture-job-1',image_url:'/api/tryons/fixture-job-1/image',download_url:'/api/tryons/fixture-job-1/download'};
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('document.querySelector("[data-job-id=fixture-job-1] img")?.naturalWidth > 0');
  assert.equal(aspectChecks,viewports.length*shapes.length*3,'Every camera, album and result shape/viewport was measured');
  assert.deepEqual(aspectFailures,[],'Try-on image geometry must preserve intrinsic aspect ratio without overflow');
  console.log(`PASS ${aspectChecks} real Chromium camera/album/result aspect-ratio and bounds checks; intentional reference crop preserved`);
  await evaluate('document.querySelector("[data-job-id] img").dispatchEvent(new Event("error"))');
  assert.equal(await evaluate('document.querySelector("[data-job-id] img").hidden'),true);
  assert.match(await evaluate('document.getElementById("tryon-jobs").textContent'),/结果暂时无法读取.*刷新/);
  assert.doesNotMatch(await evaluate('document.getElementById("tryon-jobs").textContent'),/FIFO|淘汰|1000/);
  for(const [status,message] of [['unknown','不自动重试'],['needs_photo','重新选择'],['expired','过期'],['failed','失败'],['canceled','取消'],['validating','检查'],['generating','生成'],['postprocessing','处理']]){
    jobs[0]={...jobs[0],status,image_url:null,download_url:null};
    await evaluate('document.getElementById("tryon-refresh").click()');
    await wait('document.getElementById("tryon-jobs").textContent.includes('+JSON.stringify(message)+')');
  }
  assert.equal(requests.filter(r=>r.url==='/api/tryons'&&r.method==='POST').length,1,'State refresh never resubmits generation');
  await evaluate('window.confirm=message=>{window.deleteNotice=message;return true;};document.querySelector("[data-job-delete]").click()');
  const deleteNotice=await evaluate('window.deleteNotice');
  assert.match(deleteNotice,/记录.*保留/);assert.match(deleteNotice,/生成无法撤回/);
  assert.doesNotMatch(deleteNotice,/外部调用/);
  await wait('document.getElementById("tryon-jobs").textContent.includes("还没有试穿记录")');
  assert.equal(jobs.length,0);assert.equal(requests.filter(r=>r.method==='DELETE').length,1);
  const deleteIndex=requests.findIndex(r=>r.method==='DELETE');assert.ok(requests.slice(deleteIndex+1).some(r=>r.url==='/api/tryons'&&r.method==='GET'),'Deletion verified by reading owner list back');
  console.log('PASS durable queue restore, truthful states, real private preview/download bytes, delete and readback, no automatic generation replay');
  await evaluate('document.getElementById("tryon-close").click();document.querySelector("[data-open]").click();document.querySelector("[data-view=\\"4\\"]").click();document.getElementById("detail-tryon").click()');
  for(const [error,expected] of [[{error:{code:'provider_unavailable',message:'外部服务未配置'}},'provider_unavailable'],[{detail:'测试 detail 后备错误'},'测试 detail 后备错误']]){
    uploadError=error;await choosePhoto('tryon-camera');
    await wait('!document.getElementById("tryon-submit").disabled');
    await evaluate('document.getElementById("tryon-submit").click()');
    await wait('document.getElementById("tryon-status").textContent.includes('+JSON.stringify(expected)+')');
    assert.match(await evaluate('document.getElementById("tryon-status").textContent'),/未自动重试/);
    assert.equal(await evaluate('document.querySelectorAll("[data-job-id]").length'),0,'Errors never manufacture success');
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
  assert.equal(await evaluate('document.querySelectorAll("[data-job-id]").length'),2);
  await evaluate('document.getElementById("tryon-refresh").click()');
  await wait('!document.getElementById("tryon-refresh").disabled');
  assert.equal(await evaluate('document.querySelectorAll("[data-job-id]").length'),2,'Refresh preserves expanded history without duplicates');
  console.log('PASS owner history pagination and expanded refresh (list pagination is not a generation quota)');
  paginate=false;jobs=[];uploadError=null;await load();
  await wait('document.getElementById("tryon-jobs")?.textContent.includes("还没有试穿记录")');
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
    assert.equal(await evaluate('document.querySelectorAll("[data-job-id]").length'),0,'Auth loss purges stale private results');
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
  console.log('PASS 401/session and 403/CSRF photo failures purge private/local/consent state, explicit bootstrap renews without mutation replay');
  // Exercise the same shipped page with a server-only full catalog revision.
  // No fixture content is written to the repository or treated as AI output.
  const snapshot={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'catalog.js'),'utf8'),snapshot);
  catalogFixture=JSON.parse(JSON.stringify(snapshot.window.WARDROBE));
  catalogFixture.models=[{model_id:'female-01',name:'01 号模特'},{model_id:'female-02',name:'02 号模特'}];
  for(const id of [101,102]){
    const look=JSON.parse(JSON.stringify(catalogFixture.looks[0]));
    Object.assign(look,{id,title:'动态穿搭 '+id,model_id:id===101?'female-01':'female-02',region:{country:'中国',city:id===101?'上海':'成都'},batch_id:'fixture-'+id,publish_date:id===101?'2026-11-12':'2026-11-13',editorialOrder:id});
    look.versions={v2:{...look.versions.v2,image:'https://cdn.invalid/'+id+'.webp',image_url:'https://cdn.invalid/'+id+'.webp',source_url:'/api/content/assets/fixture-'+id,download_url:'/api/content/assets/fixture-'+id+'/download'}};
    catalogFixture.looks.push(look);
  }
  uploadError=null;jobs=[];
  await evaluate('localStorage.setItem("wardrobe99:favorites:v1","[9999,101]")');
  await load();await wait('document.getElementById("catalog-status").textContent === "内容已更新"');
  assert.equal(await evaluate('document.querySelectorAll("[data-edition]").length'),0);
  assert.equal(await evaluate('Number(document.getElementById("hero-total").textContent)'),catalogFixture.looks.length);
  const catalogRequest=requests.filter(r=>r.url==='/api/content/catalog').at(-1);
  assert.equal(catalogRequest.headers.cookie,undefined,'Public catalog must omit the private visitor credential');
  await evaluate('document.getElementById("model-filter").value="female-02";document.getElementById("model-filter").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-look-card]")].map(el=>Number(el.dataset.lookCard))'),[102]);
  await evaluate('document.querySelector("[data-look-card] img").dispatchEvent(new Event("error"))');
  await wait('document.querySelector("[data-look-card] img").getAttribute("src") === "/api/content/assets/fixture-102" && document.querySelector("[data-look-card] img").naturalWidth > 0');
  await evaluate(`document.querySelector('[data-open="102"]').click();document.querySelector('[data-view="7"]').click();document.getElementById('detail-tryon').click()`);
  assert.match(await evaluate('document.getElementById("tryon-context").textContent'),/102.*生动.*07/,'Hydrated look and model use the live try-on index');
  await evaluate('document.getElementById("tryon-close").click();document.getElementById("detail-image").dispatchEvent(new Event("error"))');
  await wait('document.getElementById("detail-image").getAttribute("src") === "/api/content/assets/fixture-102" && document.getElementById("detail-image").naturalWidth > 0');
  const publicDownload=await evaluate('(async()=>{const r=await fetch(document.getElementById("download-link").href);return {status:r.status,type:r.headers.get("content-type"),disposition:r.headers.get("content-disposition"),bytes:(await r.arrayBuffer()).byteLength};})()');
  assert.equal(publicDownload.status,200);assert.equal(publicDownload.type,'image/webp');assert.match(publicDownload.disposition,/attachment/);assert.ok(publicDownload.bytes>0);
  await evaluate('document.getElementById("detail-image").dispatchEvent(new Event("error"))');
  assert.equal(await evaluate('document.getElementById("detail-image").hidden'),true);
  assert.equal(await evaluate('document.getElementById("detail-photo-frame").dataset.imageStatus'),'图片暂不可用');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("wardrobe99:favorites:v1"))'),[9999,101]);
  await evaluate('document.getElementById("close-detail").click();document.getElementById("reset-filters").click();document.getElementById("latest-only").click()');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-look-card]")].map(el=>Number(el.dataset.lookCard))'),[102]);
  for(const viewport of viewports){await setViewport(viewport);assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),'Dynamic filters fit the viewport');}
  await client('Emulation.clearDeviceMetricsOverride');
  assert.ok(!requests.some(r=>/^\/images\/look-/.test(r.url)),'Archived v1 photography is never requested by the public page');
  console.log('PASS real Chromium API hydration above 100, second model, preserved unknown favorites, latest filters, public download and one-shot CDN fallback at mobile/desktop widths');
} finally {
  if(client&&socket?.readyState===1)await Promise.race([client('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
  if(processChrome.exitCode===null&&processChrome.signalCode===null){const exit=once(processChrome,'exit');try{process.kill(-processChrome.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}await exit;}
  socket?.close();
  await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log('Try-on real DOM/HTTP regression passed (synthetic API fixture; no provider call).');
