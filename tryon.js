(() => {
'use strict';
const $ = id => document.getElementById(id);
const dialog = $('tryon-dialog');
let session = null, currentContext = null, frozen = null, sessionRevision = 0;
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
let photo = null, previewURL = null, previewGeneration = 0, busy = false;
function syncControls() {
  $('tryon-submit').disabled = busy || !session?.generation_available || !photo || !frozen?.shot_index || (!session.disclosure.accepted && !$('tryon-consent').checked);
  for(const id of ['tryon-camera','tryon-album','tryon-panel','tryon-consent','tryon-remove-photo'])$(id).disabled=busy;
  $('tryon-submit').textContent=busy?'正在提交…':session?.disclosure.accepted?'开始试穿':'同意并开始试穿';
}
function clearPhoto() {
  previewGeneration++;photo=null;
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
function track(event,context={}) {
  if(!session||!analyticsEvents.has(event))return;
  const payload={event,event_id:crypto.randomUUID()};
  if(Number.isInteger(context.look_id)&&byId.has(context.look_id))payload.look_id=context.look_id;
  if(['v1','v2'].includes(context.edition))payload.edition=context.edition;
  if(Number.isInteger(context.shot_index)&&context.shot_index>=1&&context.shot_index<=9)payload.shot_index=context.shot_index;
  api('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
}
window.WardrobeTryOn = {track,setContext(value) {
  if(!byId.has(value?.look_id) || !['v1','v2'].includes(value.edition) || !Number.isInteger(value.shot_index) || value.shot_index < 0 || value.shot_index > 9)return;
  currentContext = {look_id:value.look_id, edition:value.edition, shot_index:value.shot_index};
}};
function renderContext() {
  $('tryon-selection').hidden = !frozen;
  if(!frozen)return;
  const look=byId.get(frozen.look_id), version=look.versions[frozen.edition], panel=frozen.shot_index;
  $('tryon-context').textContent = 'LOOK '+String(look.id).padStart(3,'0')+' · '+(frozen.edition==='v1'?'造型':'生动')+' · '+look.title+' · '+(panel?'参考 '+String(panel).padStart(2,'0')+' / '+version.shots[panel-1].title:'请选择参考写真');
  $('tryon-reference').hidden = !panel;
  if(panel){
    $('tryon-reference-image').src=version.image;
    $('tryon-reference-image').style.left=-((panel-1)%3)*100+'%';
    $('tryon-reference-image').style.top=-Math.floor((panel-1)/3)*100+'%';
  }
}
function prepareContext() {
  frozen=currentContext?{...currentContext}:null;
  const select=$('tryon-panel');select.replaceChildren();
  if(frozen){
    const shots=byId.get(frozen.look_id).versions[frozen.edition].shots;
    ['请选择一张参考写真',...shots.map((shot,i)=>String(i+1).padStart(2,'0')+' · '+shot.title)].forEach((label,i)=>{
      const option=document.createElement('option');option.value=String(i);option.textContent=label;select.append(option);
    });
    select.value=String(frozen.shot_index);
  }
  renderContext();syncControls();
}
$('tryon-panel').addEventListener('change',()=>{if(frozen&&!busy){frozen.shot_index=Number($('tryon-panel').value);renderContext();syncControls();}});
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
  const list=$('tryon-jobs');list.replaceChildren();
  if(!jobs.length){list.append(element('p','还没有试穿记录。打开一套造型，点击「拍照试穿」开始。'));return;}
  for(const job of jobs){
    const card=element('article',undefined,'tryon-job');card.dataset.jobId=job.id;
    const look=byId.get(job.look_id);
    card.append(element('h4','LOOK '+String(job.look_id).padStart(3,'0')+' · '+(job.edition==='v1'?'造型':'生动')+' · 参考 '+String(job.shot_index).padStart(2,'0')+' · '+(look?.title||'')));
    let status=statusNames[job.status]||'未知状态，请刷新进度确认。';
    if(job.status==='queued'&&Number.isInteger(job.queue_position))status+=' · 前方 '+job.queue_position+' 个任务';
    card.append(element('p',status,'tryon-job-status'));
    if(job.error_message||job.error_code)card.append(element('p',[job.error_code,job.error_message].filter(Boolean).join(' · '),'tryon-job-error'));
    if(job.status==='succeeded'){
      const imageURL=safeResultURL(job,'image'),downloadURL=safeResultURL(job,'download');
      if(imageURL){
        const image=element('img');image.src=imageURL;image.alt='AI 生成试穿结果 · LOOK '+job.look_id;image.loading='lazy';
        image.addEventListener('error',()=>{image.hidden=true;card.append(element('p','结果暂时无法读取，请刷新确认。'));});card.append(image);
      }
      if(downloadURL){const link=element('a','下载结果 ↓','outline-button');link.href=downloadURL;link.download='tryon-'+job.id+'.webp';card.append(link);}
    }
    const remove=element('button',activeStatuses.has(job.status)?'取消试穿 / 删除结果':'删除生成结果','text-button');remove.dataset.jobDelete=job.id;
    remove.addEventListener('click',async()=>{
      if(!confirm('取消或删除后不再保留结果，试穿记录仍会保留。已开始的生成无法撤回，确认继续？'))return;
      remove.disabled=true;
      try {await api(jobRoute(job),{method:'DELETE'});await refreshJobs();}
      catch(error){$('tryon-jobs-status').textContent=error.message;remove.disabled=false;}
    });card.append(remove);list.append(card);
  }
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
    $('tryon-jobs-status').textContent='进度已更新。'+recoveryNotice;
  } catch(error){$('tryon-jobs-status').textContent='进度暂未更新：'+error.message+' 当前内容可能不是最新状态。';}
  finally {
    refreshing=false;$('tryon-refresh').disabled=false;$('tryon-more').disabled=false;
    if(refreshAgain){refreshAgain=false;queueMicrotask(refreshJobs);}
    else if(session&&jobs.some(job=>activeStatuses.has(job.status)))pollTimer=setTimeout(refreshJobs,3000);
  }
}
$('tryon-more').addEventListener('click',()=>{if(!refreshing){visiblePages++;refreshJobs();}});
$('tryon-refresh').addEventListener('click',()=>{if(!busy&&!refreshing)bootstrap(true);});
function open() { if(!dialog.open)dialog.showModal();if(session)refreshJobs(); }
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
    form.append('idempotency_key',crypto.randomUUID());form.append('disclosure_version',session.disclosure.version);
    $('tryon-status').textContent='正在发送，请勿重复提交…';
    const job=await api('/api/tryons',{method:'POST',body:form});
    jobs=[job,...jobs.filter(item=>item.id!==job.id)];renderJobs();
    $('tryon-status').textContent='已提交 · '+(statusNames[job.status]||job.status)+'。可在我的试穿中查看进度。';
    await refreshJobs();
  } catch(error) {
    $('tryon-status').textContent=error.message+' 未自动重试；请先刷新进度确认是否已接收。';
  } finally {clearPhoto();busy=false;syncControls();}
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
