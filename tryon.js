(() => {
'use strict';
const $ = id => document.getElementById(id);
const dialog = $('tryon-dialog');
let session = null, currentContext = null, frozen = null, frozenLook = null, sessionRevision = 0;
let reconnecting = false, recoveryNotice = '';
const recoveryMessage = '连接已失效，请刷新重连。未自动重试照片提交；若访问凭证丢失，原记录无法恢复。';
function clearSession() {
  sessionRevision++;session=null;clearTimeout(pollTimer);refreshAgain=false;
  jobs=[];visiblePages=1;renderJobs();clearPhoto();
  $('tryon-consent').checked=false;$('tryon-consent-label').hidden=false;
  $('tryon-disclosure-title').textContent='重新连接后请重新确认说明';
  $('tryon-disclosure-items').replaceChildren();
  $('tryon-more').hidden=true;$('tryon-more-note').hidden=true;
  $('tryon-availability').textContent='需要重新连接';syncControls();
}
let photo = null, previewURL = null, previewGeneration = 0, busy = false, pendingKey = null, submittedJobId = null;
let referenceRevision=0;
const failedReferences=new Set();
function syncFlow() {
  const relevant=jobs.filter(job=>job.id===submittedJobId||!frozen);
  const phase=busy||relevant.some(job=>activeStatuses.has(job.status))?'generate':relevant.some(job=>job.status==='succeeded')?'result':'prepare';
  for(const name of ['prepare','generate','result']){
    const step=$('tryon-step-'+name);step.dataset.state=name===phase?'current':'idle';
    if(name===phase)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
  }
}
function syncControls() {
  $('tryon-composer').setAttribute('aria-busy',String(busy));
  $('tryon-submit').disabled = busy || !session?.generation_available || !photo || !frozen?.shot_index || failedReferences.has(frozen.shot_index) || (!session.disclosure.accepted && !$('tryon-consent').checked);
  for(const id of ['tryon-camera','tryon-album','tryon-panel','tryon-consent','tryon-remove-photo'])$(id).disabled=busy;
  $('tryon-reference-picker').setAttribute('aria-disabled',String(busy));
  for(const input of $('tryon-reference-picker').querySelectorAll('input'))input.disabled=busy||failedReferences.has(Number(input.value));
  $('tryon-submit').textContent=busy?'正在提交…':session?.disclosure.accepted?'开始试穿':'同意并开始试穿';
  $('tryon-photo-placeholder').hidden=Boolean(photo);
  $('tryon-remove-photo').hidden=!photo;
  $('tryon-photo-stage').dataset.selected=String(Boolean(photo));
  $('tryon-readiness').textContent=busy?'正在上传照片，请稍候。':failedReferences.has(frozen?.shot_index)?'所选参考图片暂不可用，请重新打开试穿重试。':!photo?'先选一张照片，照片会留在本机预览。':!frozen?.shot_index?'照片已准备好，再点选一张参考写真。':(!session?.disclosure.accepted&&!$('tryon-consent').checked)?'照片和参考已就绪，请阅读并确认照片用途。':'照片与参考已就绪，可以开始试穿。';
  syncFlow();
}
function clearPhoto() {
  previewGeneration++;photo=null;pendingKey=null;
  if(previewURL)URL.revokeObjectURL(previewURL);
  previewURL=null;$('tryon-local-preview').removeAttribute('src');$('tryon-local-preview').hidden=true;
  $('tryon-camera').value='';$('tryon-album').value='';syncControls();
}
async function selectPhoto(event) {
  if(busy)return;
  const file=event.target.files?.[0];if(!file)return;
  clearPhoto();const generation=previewGeneration;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||!file.size){$('tryon-status').textContent='请选择有效的 JPEG、PNG 或 WebP 照片。';return;}
  const url=URL.createObjectURL(file);previewURL=url;
  try {
    const image=$('tryon-local-preview');image.src=url;await image.decode();
    if(generation!==previewGeneration)return;
    photo=file;image.hidden=false;$('tryon-status').textContent='照片仅在本地预览，尚未上传。';syncControls();
  } catch {
    if(generation===previewGeneration){clearPhoto();$('tryon-status').textContent='无法读取这张照片，请换一张清晰的 JPEG、PNG 或 WebP。';}
  }
}
for(const id of ['tryon-camera','tryon-album'])$(id).addEventListener('change',selectPhoto);
$('tryon-remove-photo').addEventListener('click',clearPhoto);
$('tryon-consent').addEventListener('change',syncControls);
dialog.addEventListener('close',clearPhoto);
const byId = new Map((window.WARDROBE?.looks || []).map(look => [look.id, look]));
const analyticsEvents=new Set(['page_view','look_open','tryon_open']);
function randomId() {
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  // getRandomValues is also available on ordinary LAN HTTP origins.
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function track(event,context={}) {
  if(!session||!analyticsEvents.has(event))return;
  try {
    const payload={event,event_id:randomId()};
    if(Number.isInteger(context.look_id)&&byId.has(context.look_id))payload.look_id=context.look_id;
    if(['v1','v2'].includes(context.edition))payload.edition=context.edition;
    if(Number.isInteger(context.shot_index)&&context.shot_index>=1&&context.shot_index<=9)payload.shot_index=context.shot_index;
    api('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  }catch { /* Observation must not interrupt browsing or opening a dialog. */ }
}
window.WardrobeTryOn = {track,setCatalog(catalog) {
  byId.clear();for(const look of catalog.looks||[])byId.set(look.id,look);
},setContext(value) {
  if(!byId.has(value?.look_id) || value.edition!=='v2' || !Number.isInteger(value.shot_index) || value.shot_index < 0 || value.shot_index > 9)return;
  currentContext = {look_id:value.look_id, edition:value.edition, shot_index:value.shot_index};
}};
function shotFraming(shot) {
  return typeof shot?.framing==='string'?shot.framing.trim():'';
}
function renderContext() {
  $('tryon-composer').hidden = !frozen;
  $('tryon-selection').hidden = !frozen;
  if(!frozen)return;
  const look=frozenLook, version=look.versions.v2, panel=frozen.shot_index;
  for(const input of $('tryon-reference-picker').querySelectorAll('input'))input.checked=Number(input.value)===panel;
  $('tryon-context').textContent = 'LOOK '+String(look.id).padStart(3,'0')+' · '+(frozen.edition==='v1'?'造型':'生动')+' · '+look.title+' · '+(panel?'参考 '+String(panel).padStart(2,'0')+' / '+version.shots[panel-1].title:'请选择参考写真');
  const framing=panel?shotFraming(version.shots[panel-1]):'';
  $('tryon-reference-framing').textContent=panel?(framing?'画面景别 / '+framing:'该画面未提供景别说明，请查看参考图确认覆盖的衣装。'):'请选择一张参考写真，并查看画面确认覆盖的衣装。';
  $('tryon-reference').hidden = !panel;
  if(panel){
    if(window.WardrobeImages)window.WardrobeImages.set($('tryon-reference-image'),version);
    else $('tryon-reference-image').src=version.source_url||version.image;
    $('tryon-reference-image').style.left=-((panel-1)%3)*100+'%';
    $('tryon-reference-image').style.top=-Math.floor((panel-1)/3)*100+'%';
  }
}
function chooseReference(panel) {
  if(!frozen||busy||!Number.isInteger(panel)||panel<0||panel>9)return;
  pendingKey=null;frozen.shot_index=panel;$('tryon-panel').value=String(panel);renderContext();syncControls();
}
function revealReference(input) {
  input.closest('.tryon-reference-choice')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
}
function renderReferencePicker() {
  const picker=$('tryon-reference-picker');picker.replaceChildren();
  referenceRevision++;failedReferences.clear();$('tryon-reference-error').hidden=true;
  if(!frozenLook)return;
  const revision=referenceRevision,version=frozenLook.versions.v2;
  for(const [index,shot] of version.shots.entries()){
    const panel=index+1,label=element('label',undefined,'tryon-reference-choice');
    const input=element('input');input.type='radio';input.name='tryon-reference-shot';input.value=String(panel);input.dataset.referenceShot=String(panel);
    input.setAttribute('aria-label','参考 '+String(panel).padStart(2,'0')+' · '+shot.title+(shotFraming(shot)?' · '+shotFraming(shot):''));
    const frame=element('span',undefined,'tryon-reference-thumbnail');frame.dataset.referencePanel=String(panel);
    const image=element('img');image.alt='';image.decoding='async';
    image.style.left=-(index%3)*100+'%';image.style.top=-Math.floor(index/3)*100+'%';
    frame.append(image);label.append(input,frame);
    label.append(element('span',String(panel).padStart(2,'0')+' · '+shot.title,'tryon-reference-caption'));
    label.append(element('span',shotFraming(shot)||'查看画面确认衣装','tryon-reference-kind'));
    picker.append(label);
    input.addEventListener('focus',()=>revealReference(input));
    input.addEventListener('change',()=>{if(input.checked){chooseReference(panel);revealReference(input);}});
    image.addEventListener('error',()=>{
      if(revision!==referenceRevision||image.dataset.failed!=='true')return;
      failedReferences.add(panel);label.dataset.imageFailed='true';
      $('tryon-reference-error').hidden=false;$('tryon-reference-error').textContent='部分参考图片暂不可用，请重新打开试穿重试；不会替换成其他镜头。';syncControls();
    });
    if(window.WardrobeImages)window.WardrobeImages.set(image,version);else image.src=version.source_url||version.image;
  }
}
$('tryon-reference-picker').addEventListener('keydown',event=>{
  if(busy||event.target?.name!=='tryon-reference-shot')return;
  const shifts={ArrowRight:1,ArrowLeft:-1,ArrowDown:3,ArrowUp:-3};
  if(!(event.key in shifts)&&!['Home','End'].includes(event.key))return;
  event.preventDefault();const inputs=[...$('tryon-reference-picker').querySelectorAll('input')];
  let index=inputs.indexOf(event.target),delta=shifts[event.key]||1;
  if(event.key==='Home')index=-1;if(event.key==='End'){index=0;delta=-1;}
  for(let count=0;count<inputs.length;count++){
    index=(index+delta+inputs.length)%inputs.length;
    if(!inputs[index].disabled){inputs[index].focus({preventScroll:true});chooseReference(Number(inputs[index].value));revealReference(inputs[index]);break;}
  }
});
function prepareContext() {
  submittedJobId=null;
  frozen=currentContext&&byId.has(currentContext.look_id)?{...currentContext}:null;
  frozenLook=frozen?byId.get(frozen.look_id):null;
  const select=$('tryon-panel');select.replaceChildren();
  if(frozen){
    const shots=frozenLook.versions.v2.shots;
    ['请选择一张参考写真',...shots.map((shot,i)=>[String(i+1).padStart(2,'0'),shot.title,shotFraming(shot)].filter(Boolean).join(' · '))].forEach((label,i)=>{
      const option=document.createElement('option');option.value=String(i);option.textContent=label;select.append(option);
    });
    select.value=String(frozen.shot_index);
  }
  renderReferencePicker();renderContext();syncControls();
}
$('tryon-panel').addEventListener('change',()=>chooseReference(Number($('tryon-panel').value)));
async function api(url, options = {}) {
  const revision=sessionRevision;
  const mutation=options.method && options.method!=='GET';
  const response = await fetch(url, {credentials:'same-origin', cache:'no-store', ...options,
    headers:{...(mutation?{'X-CSRF-Token':session?.csrf_token||''}:{}),...options.headers}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail=typeof body.detail==='string'?body.detail:Array.isArray(body.detail)?body.detail.map(item=>item.msg).filter(Boolean).join('；'):body.detail?.message;
    const message=body.error?.message||detail||'服务暂不可用，请稍后再试。';
    const error=new Error((body.error?.code?body.error.code+' · ':'')+message);error.code=body.error?.code;
    if(url!=='/api/bootstrap'&&revision===sessionRevision&&(response.status===401||(response.status===403&&error.code==='csrf'))){
      clearSession();recoveryNotice=recoveryMessage;
      $('tryon-status').textContent=recoveryMessage;$('tryon-jobs-status').textContent=recoveryMessage;
      error.message+=' '+recoveryMessage;
    }
    throw error;
  }
  return body;
}
function element(tag,text,className) {
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;
}
const activeStatuses=new Set(['queued','validating','generating','postprocessing']);
const statusNames={queued:'排队中',validating:'正在检查照片',generating:'正在生成',postprocessing:'正在处理结果',succeeded:'生成完成',failed:'试穿失败',unknown:'生成状态未确认，不自动重试。请先检查记录，不要重复提交。',needs_photo:'输入照片已失效，请重新选择照片并明确提交新的试穿。',expired:'输入照片已过期，任务不会自动重试。',canceled:'已取消'};
let jobs=[], pollTimer, refreshing=false, refreshAgain=false, visiblePages=1;
function jobRoute(job,suffix='') {return '/api/tryons/'+encodeURIComponent(job.id)+suffix;}
function safeResultURL(job,kind) {const value=job[kind+'_url'];return value===jobRoute(job,'/'+(kind==='image'?'image':'download'))?value:null;}
function renderJobs() {
  const focused=listFocusedAction();
  const list=$('tryon-jobs');list.replaceChildren();
  syncFlow();
  if(!jobs.length){list.append(element('p','还没有试穿记录。打开一套造型，点击「拍照试穿」开始。'));return;}
  for(const job of jobs){
    const card=element('article',undefined,'tryon-job');card.dataset.jobId=job.id;card.dataset.jobStatus=job.status;
    const look=byId.get(job.look_id);
    const heading=element('h4','LOOK '+String(job.look_id).padStart(3,'0')+' · '+(job.edition==='v1'?'造型':'生动')+' · 参考 '+String(job.shot_index).padStart(2,'0')+' · '+(look?.title||''));heading.tabIndex=-1;heading.dataset.jobAction='heading';card.append(heading);
    let status=statusNames[job.status]||'未知状态，请刷新进度确认。';
    if(job.status==='queued'&&Number.isInteger(job.queue_position))status+=' · 前方 '+job.queue_position+' 个任务';
    card.append(element('p',status,'tryon-job-status'));
    if(activeStatuses.has(job.status)){
      const waiting=element('div',undefined,'tryon-waiting');
      const skeleton=element('div',undefined,'tryon-photo-skeleton');skeleton.setAttribute('aria-hidden','true');
      skeleton.append(element('span',undefined,'tryon-person-shape'),element('span','等待成片','tryon-skeleton-caption'));
      const progress=element('div',undefined,'tryon-progress-copy');
      progress.append(element('p',job.status==='queued'?'已收到你的照片':job.status==='validating'?'让照片准备好':job.status==='generating'?'正在为你换上这套穿搭':'正在整理你的成片','tryon-progress-title'));
      const stages=element('ol',undefined,'tryon-progress-steps');stages.setAttribute('aria-label','生成阶段');
      const stagesOrder=['queued','validating','generating','postprocessing'];
      for(const [index,phase] of stagesOrder.entries()){
        const item=element('li',['等待开始','检查照片','生成试穿','整理成片'][index]);
        item.dataset.state=index<stagesOrder.indexOf(job.status)?'done':phase===job.status?'current':'waiting';
        if(phase===job.status)item.setAttribute('aria-current','step');stages.append(item);
      }
      progress.append(stages,element('p','进度会自动更新。每次生成所需时间不同，可以先继续逛衣橱。','tryon-hint'));
      waiting.append(skeleton,progress);card.append(waiting);
    }
    if(job.error_message||job.error_code)card.append(element('p',[job.error_code,job.error_message].filter(Boolean).join(' · '),'tryon-job-error'));
    if(job.status==='succeeded'){
      const imageURL=safeResultURL(job,'image'),downloadURL=safeResultURL(job,'download');
      if(imageURL){
        const image=element('img');image.src=imageURL;image.alt='AI 生成试穿结果 · LOOK '+job.look_id;image.loading='lazy';
        image.addEventListener('error',()=>{image.hidden=true;card.append(element('p','结果暂时无法读取，请刷新确认。'));});card.append(image);
      }
      if(downloadURL){const link=element('a','下载结果 ↓','outline-button');link.href=downloadURL;link.download='tryon-'+job.id+'.webp';link.dataset.jobAction='download';card.append(link);}
    }
    if(['failed','needs_photo','expired','canceled'].includes(job.status)&&job.edition==='v2'&&look){
      const retry=element('button','重新准备照片','outline-button');retry.dataset.jobRetry=job.id;retry.dataset.jobAction='retry';retry.addEventListener('click',()=>{
        if(busy)return;clearPhoto();currentContext={look_id:job.look_id,edition:'v2',shot_index:job.shot_index};prepareContext();
        $('tryon-photo-title').scrollIntoView({block:'start',behavior:'instant'});$('tryon-album').focus();
      });card.append(retry);
    }
    const remove=element('button',activeStatuses.has(job.status)?'取消本次试穿':'删除生成结果','text-button');remove.dataset.jobDelete=job.id;remove.dataset.jobAction='delete';
    remove.addEventListener('click',async()=>{
      if(!confirm('取消或删除后不再保留结果，试穿记录仍会保留。已开始的生成无法撤回，确认继续？'))return;
      remove.disabled=true;
      try {await api(jobRoute(job),{method:'DELETE'});await refreshJobs();}
      catch(error){$('tryon-jobs-status').textContent=error.message;remove.disabled=false;}
    });card.append(remove);list.append(card);
  }
  if(focused)list.querySelector('[data-job-id="'+CSS.escape(focused.id)+'"] [data-job-action="'+focused.action+'"]')?.focus({preventScroll:true});
}
function listFocusedAction() {
  const active=document.activeElement;
  if(!$('tryon-jobs').contains(active)||!['heading','download','retry','delete'].includes(active?.dataset?.jobAction))return null;
  return {id:active.closest('[data-job-id]').dataset.jobId,action:active.dataset.jobAction};
}
async function refreshJobs() {
  if(!session)return;
  if(refreshing){refreshAgain=true;return;}
  const revision=sessionRevision;
  refreshing=true;clearTimeout(pollTimer);$('tryon-refresh').disabled=true;$('tryon-more').disabled=true;
  try {
    const collected=[];let response;
    for(let page=0;page<visiblePages;page++){
      response=await api('/api/tryons'+(page?'?offset='+collected.length:''));
      if(revision!==sessionRevision)return;
      if(!Array.isArray(response.items))throw new Error('无法读取试穿记录，请刷新重试。');
      collected.push(...response.items);
      if(!response.has_more||!response.items.length)break;
    }
    jobs=[...new Map(collected.map(job=>[job.id,job])).values()];renderJobs();
    $('tryon-more-note').hidden=!response.has_more;$('tryon-more').hidden=!response.has_more;
    const latest=jobs.find(job=>activeStatuses.has(job.status))||jobs[0];
    const notice='进度已更新。'+(latest?'最近试穿：'+(statusNames[latest.status]||'状态待确认')+'。':'')+recoveryNotice;
    if($('tryon-jobs-status').textContent!==notice)$('tryon-jobs-status').textContent=notice;
  } catch(error){$('tryon-jobs-status').textContent='进度暂未更新：'+error.message+' 当前内容可能不是最新状态。';}
  finally {
    refreshing=false;$('tryon-refresh').disabled=false;$('tryon-more').disabled=false;
    if(refreshAgain){refreshAgain=false;queueMicrotask(refreshJobs);}
    else if(session&&jobs.some(job=>activeStatuses.has(job.status)))pollTimer=setTimeout(refreshJobs,3000);
  }
}
$('tryon-more').addEventListener('click',()=>{if(!refreshing){visiblePages++;refreshJobs();}});
$('tryon-refresh').addEventListener('click',()=>{if(!busy&&!refreshing){if(session)refreshJobs();else bootstrap(true);}});
function open() { if(!dialog.open){dialog.showModal();dialog.scrollTop=0;}if(session)refreshJobs(); }
$('detail-tryon').addEventListener('click', () => {if(!busy)prepareContext();open();if(frozen)track('tryon_open',frozen);});
$('tryon-history').addEventListener('click', () => {if(!busy){frozen=null;renderContext();syncControls();}open();});
$('tryon-close').addEventListener('click', () => dialog.close());
$('tryon-submit').addEventListener('click',async()=>{
  if($('tryon-submit').disabled||busy)return;
  busy=true;syncControls();
  const context={...frozen}, file=photo;
  try {
    if(!session.disclosure.accepted){
      const consent=await api('/api/disclosure/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:session.disclosure.version})});
      if(!consent.accepted)throw new Error('尚未确认同意，请重新阅读后确认。');
      session.disclosure.accepted=true;$('tryon-consent-label').hidden=true;
    }
    const form=new FormData();form.append('photo',file);
    for(const [key,value] of Object.entries(context))form.append(key,String(value));
    pendingKey ||= randomId();form.append('idempotency_key',pendingKey);form.append('disclosure_version',session.disclosure.version);
    $('tryon-status').textContent='正在发送，请勿重复提交…';
    const job=await api('/api/tryons',{method:'POST',body:form});
    submittedJobId=job.id;
    jobs=[job,...jobs.filter(item=>item.id!==job.id)];renderJobs();
    clearPhoto();
    $('tryon-status').textContent='已提交 · '+(statusNames[job.status]||job.status)+'。可在我的试穿中查看进度。';
    await refreshJobs();
    if(dialog.open){
      const card=$('tryon-jobs').querySelector('[data-job-id="'+CSS.escape(job.id)+'"]');
      card?.querySelector('h4')?.focus({preventScroll:true});
      card?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
  } catch(error) {
    $('tryon-status').textContent=error.message+' 未自动重试；请先刷新进度确认是否已接收。';
  } finally {busy=false;syncControls();}
});
async function bootstrap(explicit=false) {
  if(reconnecting)return;
  reconnecting=true;
  const previousVisitor=session?.visitor?.id, pages=visiblePages;
  if(explicit){
    clearSession();
    recoveryNotice='访问凭证丢失后，原记录无法恢复；未自动重试照片提交。';
  }
  $('tryon-refresh').disabled=true;
  try {
    if(!['http:','https:'].includes(location.protocol))throw new Error('本地离线浏览不支持在线试穿；衣橱和收藏仍可使用。');
    session = await api('/api/bootstrap');
    if(previousVisitor&&previousVisitor===session.visitor?.id)visiblePages=pages;
    track('page_view');if(currentContext)track('look_open',currentContext);
    $('tryon-disclosure-title').textContent=session.disclosure.title||'照片用途';
    $('tryon-disclosure-items').replaceChildren();
    for(const item of session.disclosure.items||[]){const li=document.createElement('li');li.textContent=item;$('tryon-disclosure-items').append(li);}
    $('tryon-consent-label').hidden=Boolean(session.disclosure.accepted);syncControls();
    const message = session.generation_available ? '在线试穿已连接' : '试穿暂不可用：生成服务尚未就绪，衣橱仍可浏览。';
    $('tryon-availability').textContent = message;
    $('tryon-status').textContent = message+' '+recoveryNotice;
    await refreshJobs();
  } catch(error) {
    $('tryon-availability').textContent = '试穿暂不可用';
    $('tryon-status').textContent = error.message;
  } finally {reconnecting=false;$('tryon-refresh').disabled=false;syncControls();}
}
bootstrap();
})();
