(() => {
'use strict';
const $ = id => document.getElementById(id);
const dialog = $('tryon-dialog');
const comparisonDialog = $('tryon-comparison');
let comparisonJob = null;
const storage = window.WardrobeTryOnStorage;
let session = null, currentContext = null, frozen = null, frozenLook = null, sessionRevision = 0;
let reconnecting = false, recoveryNotice = '';
const recoveryHistoryNotice = '访问凭证丢失后，未存到本机的原记录无法恢复。';
const recoveryMessage = '连接已失效，请刷新重连。未自动重试照片提交。'+recoveryHistoryNotice;
function clearSession() {
  sessionRevision++;session=null;clearTimeout(pollTimer);refreshAgain=false;
  closeTryOnComparison();
  submittedReceipt=null;resultFailures.clear();
  remoteJobs=[];historyLoaded=false;visiblePages=1;updateJobs();clearPhoto();
  $('tryon-consent').checked=false;$('tryon-consent-label').hidden=false;
  $('tryon-disclosure-title').textContent='重新连接后请重新确认说明';
  $('tryon-disclosure-items').replaceChildren();
  $('tryon-more').hidden=true;$('tryon-more-note').hidden=true;
  $('tryon-availability').textContent='需要重新连接';syncControls();
}
let photo = null, previewURL = null, previewGeneration = 0, busy = false, pendingSubmission = null, submittedJobId = null;
let retryingUnknown = false;
let poseMode = 'original';
let savedPhotoId = null, savedPhotos = [], photoRead = 0;
const photoURLs = [];
const photoTypes = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
let photoRejection = '';
let referenceRevision=0;
const failedReferences=new Set();
function syncFlow() {
  const relevant=jobs.filter(job=>job.id===submittedJobId||!frozen);
  const phase=busy||relevant.some(job=>job.online&&activeStatuses.has(job.status))?'generate':relevant.some(job=>job.status==='succeeded')?'result':'prepare';
  for(const name of ['prepare','generate','result']){
    const step=$('tryon-step-'+name);step.dataset.state=name===phase?'current':'idle';
    if(name===phase)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
  }
}
function syncControls() {
  const submit = $('tryon-submit');
  const poseSelect = $('tryon-pose-mode');
  $('tryon-pose-options').hidden = !session?.pose_grid_available;
  poseSelect.disabled = busy || !session?.pose_grid_available;
  if(poseSelect.value!==poseMode){
    for(const option of poseSelect.options)option.selected=option.value===poseMode;
  }
  $('tryon-pose-description').textContent = poseMode === 'pose_grid'
    ? '中央保留你的完整原图，外围八格展示换装后的不同姿态。原图会随私有成片保存。'
    : '根据原照片的姿态生成一张试穿图。';
  $('tryon-composer').setAttribute('aria-busy',String(busy));
  submit.disabled = busy || !session?.generation_available || !photo || Boolean(photoRejection) || !frozen?.shot_index || failedReferences.has(frozen.shot_index) || (!session.disclosure.accepted && !$('tryon-consent').checked);
  for(const id of ['tryon-camera','tryon-album','tryon-consent','tryon-remove-photo'])$(id).disabled=busy;
  for(const button of $('tryon-saved-photos').querySelectorAll('button')){
    button.disabled=busy;
    if(button.dataset.photoSelect)button.setAttribute('aria-pressed',String(button.dataset.photoSelect===savedPhotoId));
  }
  $('tryon-reference-picker').setAttribute('aria-disabled',String(busy));
  for(const input of $('tryon-reference-picker').querySelectorAll('input'))input.disabled=busy||failedReferences.has(Number(input.value));
  const submitAction=retryingUnknown?'提交新试穿':'开始试穿';
  submit.textContent=busy?'正在提交…':session?.disclosure.accepted?submitAction:'同意并'+submitAction;
  $('tryon-retry-notice').hidden=!retryingUnknown;
  if(retryingUnknown)submit.setAttribute('aria-describedby','tryon-retry-notice');
  else submit.removeAttribute('aria-describedby');
  $('tryon-photo-placeholder').hidden=Boolean(photo);
  $('tryon-remove-photo').hidden=!photo;
  $('tryon-photo-stage').dataset.selected=String(Boolean(photo));
  $('tryon-readiness').textContent=busy?'正在上传照片，请稍候。':photoRejection?'请重新选择照片。':failedReferences.has(frozen?.shot_index)?'服装参考暂不可用，请重新打开试穿。':!photo?'从照片库选一张照片，或添加新照片。':!session?.generation_available?'连接试穿服务后可提交所选照片。':(!session.disclosure.accepted&&!$('tryon-consent').checked)?'照片已就绪，请阅读并确认照片用途。':'照片已就绪，可以开始试穿。';
  syncFlow();
}
function clearPhoto() {
  previewGeneration++;photo=null;savedPhotoId=null;pendingSubmission=null;
  if(photoRejection&&$('tryon-status').textContent===photoRejection)$('tryon-status').textContent='';
  if(photoRejection&&$('tryon-library-status').textContent===photoRejection)$('tryon-library-status').textContent='';
  photoRejection='';
  if(previewURL)URL.revokeObjectURL(previewURL);
  previewURL=null;$('tryon-local-preview').removeAttribute('src');$('tryon-local-preview').hidden=true;
  $('tryon-camera').value='';$('tryon-album').value='';syncControls();
}
function photoNotice(message) {
  $('tryon-library-status').textContent=message;
  if(frozen)$('tryon-status').textContent=message;
}
function photoLimit(name) {
  const value=session?.photo_limits?.[name];
  return Number.isSafeInteger(value)&&value>0?value:null;
}
function fileSizeProblem(blob) {
  const limit=photoLimit('max_upload_bytes');
  if(!limit||blob.size<=limit)return '';
  const amount=limit%(1024*1024)===0?`${limit/(1024*1024)} MiB`:`${limit.toLocaleString('zh-CN')} 字节`;
  return `照片文件超过 ${amount}，请压缩后重新选择，保留头顶和鞋履。`;
}
async function rasterSize(blob) {
  if(typeof window.createImageBitmap!=='function')return null;
  try {
    // An <img>'s natural dimensions are density-corrected CSS pixels.
    // Decode the source Blob as a bitmap to inspect its raster instead.
    const bitmap=await window.createImageBitmap(blob);
    try {return {width:bitmap.width,height:bitmap.height};}
    finally {bitmap.close();}
  } catch {return null;}
}
function rejectPhoto(message) {
  clearPhoto();
  photoRejection=message;
  photoNotice(message);
  syncControls();
  return false;
}
async function previewPhoto(blob,id=null) {
  clearPhoto();const generation=previewGeneration;
  if(!Object.hasOwn(photoTypes,blob.type)||!blob.size)return rejectPhoto('请选择有效的 JPEG、PNG 或 WebP 照片。');
  const initialProblem=fileSizeProblem(blob);
  if(initialProblem)return rejectPhoto(initialProblem);
  try {
    savedPhotoId=id;
    const url=URL.createObjectURL(blob);previewURL=url;
    const image=$('tryon-local-preview');image.src=url;await image.decode();
    if(generation!==previewGeneration)return false;
    const sizeProblem=fileSizeProblem(blob);
    if(sizeProblem)return rejectPhoto(sizeProblem);
    const maxEdge=photoLimit('max_image_dimension'),maxPixels=photoLimit('max_pixels');
    if(maxEdge||maxPixels){
      const dimensions=await rasterSize(blob);
      if(generation!==previewGeneration)return false;
      if(dimensions){
        const {width,height}=dimensions;
        if(maxEdge&&Math.max(width,height)>maxEdge)return rejectPhoto(`照片边长超过 ${maxEdge.toLocaleString('zh-CN')} 像素，请缩小后重新选择。`);
        if(maxPixels&&width*height>maxPixels)return rejectPhoto(`照片总像素超过 ${maxPixels.toLocaleString('zh-CN')}，请缩小后重新选择。`);
      }
    }
    photo=blob;image.hidden=false;syncControls();
    return true;
  } catch {
    if(generation===previewGeneration)return rejectPhoto('无法读取这张照片，请换一张清晰的 JPEG、PNG 或 WebP。');
    return false;
  }
}
async function selectPhoto(event) {
  if(busy)return;
  const file=event.target.files?.[0];if(!file)return;
  const blob=file.slice(0,file.size,file.type);
  const preview=previewPhoto(blob),generation=previewGeneration;
  if(!await preview||generation!==previewGeneration)return;
  photoNotice('照片已选中，尚未上传。');
  if(!storage){photoNotice('此浏览器无法保存照片，仍可在本次试穿使用。');return;}
  try {
    const id=randomId();
    await storage.putPhoto({id,blob,createdAt:Date.now()});
    if(photo===blob)savedPhotoId=id;
    const loaded=await readPhotos();
    if(loaded&&photo===blob)$('tryon-library-status').textContent='照片已保存到本机。';
  } catch {
    if(generation===previewGeneration&&dialog.open)$('tryon-library-status').textContent='照片未能保存到本机。';
  }
}
function releasePhotoURLs() {
  for(const url of photoURLs)URL.revokeObjectURL(url);
  photoURLs.length=0;
}
function renderPhotos() {
  const list=$('tryon-saved-photos');
  const active=document.activeElement;
  const focusKey=list.contains(active)&&(active.dataset.photoSelect||active.dataset.photoDelete);
  const oldIndex=focusKey?[...list.children].findIndex(item=>item.dataset.savedPhotoId===focusKey):-1;
  list.replaceChildren();releasePhotoURLs();
  list.hidden=!savedPhotos.length||!dialog.open;
  $('tryon-no-photos').hidden=Boolean(savedPhotos.length);
  if(!dialog.open)return;
  for(const [index,entry] of savedPhotos.entries()){
    const item=element('li',undefined,'tryon-saved-photo');
    item.dataset.savedPhotoId=entry.id;
    const label='照片 '+(index+1);
    const select=element('button',undefined,'tryon-saved-choice');
    select.type='button';select.dataset.photoSelect=entry.id;
    select.setAttribute('aria-label','选用'+label);
    const image=element('img');
    const url=URL.createObjectURL(entry.blob);photoURLs.push(url);
    image.src=url;image.alt='';image.loading='lazy';
    select.append(image,element('span',label));
    select.addEventListener('click',async()=>{
      if(busy)return;
      const preview=previewPhoto(entry.blob,entry.id),generation=previewGeneration;
      if(await preview&&generation===previewGeneration)photoNotice('已选用本机照片，尚未上传。');
    });
    const remove=element('button','删除','text-button tryon-photo-delete');
    remove.type='button';remove.dataset.photoDelete=entry.id;
    remove.setAttribute('aria-label','删除'+label);
    remove.addEventListener('click',async()=>{
      if(busy||!confirm('删除这张本机照片？已生成的试穿结果仍可查看。'))return;
      remove.disabled=true;
      try {
        await storage.deletePhoto(entry.id);
        if(savedPhotoId===entry.id)clearPhoto();
        if(await readPhotos())photoNotice('本机照片已删除。');
      } catch {
        remove.disabled=false;photoNotice('照片未能删除，请重试。');
      }
    });
    item.append(select,remove);list.append(item);
  }
  syncControls();
  if(focusKey){
    const item=[...list.children].find(candidate=>candidate.dataset.savedPhotoId===focusKey);
    const action=active.dataset.photoDelete?'[data-photo-delete]':'[data-photo-select]';
    (item?.querySelector(action)||list.children[Math.min(oldIndex,list.children.length-1)]?.querySelector('[data-photo-select]')||$('tryon-album')).focus({preventScroll:true});
  }
}
async function readPhotos() {
  if(!storage)return false;
  const read=++photoRead;
  try {
    const entries=await storage.listPhotos();
    if(read!==photoRead)return false;
    savedPhotos=entries.sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
    if(savedPhotoId&&!savedPhotos.some(entry=>entry.id===savedPhotoId))clearPhoto();
    renderPhotos();
    return true;
  } catch {
    if(read===photoRead)$('tryon-library-status').textContent='暂时无法读取本机照片。';
    return false;
  }
}
for(const id of ['tryon-camera','tryon-album'])$(id).addEventListener('change',selectPhoto);
$('tryon-remove-photo').addEventListener('click',clearPhoto);
$('tryon-consent').addEventListener('change',syncControls);
dialog.addEventListener('close',()=>{
  if(dialog.open)return;
  clearPhoto();
  $('tryon-library-status').textContent='';
  renderPhotos();
  releaseResultURLs();
  $('tryon-jobs').replaceChildren();
});
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
    if(context.edition==='v2')payload.edition=context.edition;
    if(Number.isInteger(context.shot_index)&&context.shot_index>=1&&context.shot_index<=9)payload.shot_index=context.shot_index;
    api('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  }catch { /* Observation must not interrupt browsing or opening a dialog. */ }
}
window.WardrobeTryOn = {track,setCatalog(catalog) {
  byId.clear();for(const look of catalog.looks||[])byId.set(look.id,look);
},setContext(value) {
  currentContext=byId.has(value?.look_id)&&value.edition==='v2'?{look_id:value.look_id,edition:value.edition}:null;
}};
function shotFraming(shot) {
  return typeof shot?.framing==='string'?shot.framing.trim():'';
}
function defaultReference(version) {
  const isFullBody=shot=>/全身|full[- ]body/i.test(shotFraming(shot));
  const preview=version.previewPanel;
  if(isFullBody(version.shots[preview-1]))return preview;
  return version.shots.findIndex(isFullBody)+1||(version.shots[preview-1]?preview:1);
}
function positionReference(image,panel) {
  image.style.left=-((panel-1)%3)*100+'%';
  image.style.top=-Math.floor((panel-1)/3)*100+'%';
}
function renderContext() {
  dialog.dataset.mode=frozen?'compose':'dashboard';
  $('tryon-flow').hidden=!frozen;
  $('tryon-composer').hidden = !frozen;
  $('tryon-selection').hidden = !frozen;
  if(!frozen)return;
  const look=frozenLook, version=look.versions.v2, panel=frozen.shot_index;
  for(const input of $('tryon-reference-picker').querySelectorAll('input'))input.checked=Number(input.value)===panel;
  $('tryon-context').textContent='LOOK '+String(look.id).padStart(3,'0')+' · '+look.title;
  const framing=shotFraming(version.shots[panel-1]);
  $('tryon-reference-framing').textContent=framing?'画面景别 / '+framing:'该画面未提供景别说明，请查看参考图确认覆盖的衣装。';
  if(window.WardrobeImages)window.WardrobeImages.set($('tryon-reference-image'),version);
  else $('tryon-reference-image').src=version.source_url||version.image;
  positionReference($('tryon-reference-image'),panel);
}
function chooseReference(panel) {
  if(!frozen||busy||failedReferences.has(panel)||panel===frozen.shot_index)return;
  frozen.shot_index=panel;renderContext();syncControls();
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
    positionReference(image,panel);
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
function prepareContext(context=currentContext, retryUnknown=false, mode='original') {
  submittedJobId=null;
  frozenLook=byId.get(context?.look_id);
  frozen=frozenLook?{...context,shot_index:context.shot_index??defaultReference(frozenLook.versions.v2)}:null;
  retryingUnknown=Boolean(frozen&&retryUnknown);
  poseMode=mode==='pose_grid'&&session?.pose_grid_available?'pose_grid':'original';
  $('tryon-reference-options').open=false;
  renderReferencePicker();renderContext();syncControls();
}
$('tryon-pose-mode').addEventListener('change',()=>{
  if(busy||!session?.pose_grid_available)return;
  poseMode=$('tryon-pose-mode').value==='pose_grid'?'pose_grid':'original';
  syncControls();
});
async function api(url, options = {}) {
  const revision=sessionRevision;
  const mutation=options.method && options.method!=='GET';
  const response = await fetch(url, {credentials:'same-origin', cache:'no-store', ...options,
    headers:{...(mutation?{'X-CSRF-Token':session?.csrf_token||''}:{}),...options.headers}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail=typeof body.detail==='string'?body.detail:Array.isArray(body.detail)?body.detail.map(item=>item.msg).filter(Boolean).join('；'):body.detail?.message;
    const message=body.error?.message||detail||'服务暂不可用，请稍后再试。';
    const error=new Error((body.error?.code?body.error.code+' · ':'')+message);
    error.code=body.error?.code;
    error.status=response.status;
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
const failedStatuses=new Set(['failed','unknown','needs_photo','expired','canceled']);
const statusNames={queued:'排队中',validating:'正在检查照片',generating:'正在生成',postprocessing:'正在处理结果',succeeded:'生成完成',failed:'试穿失败',unknown:'生成状态未确认，不自动重试。请先检查记录，不要重复提交。',needs_photo:'输入照片已失效，请重新选择照片并明确提交新的试穿。',expired:'成片已过期，当前浏览器没有保存副本。',canceled:'已取消'};
let jobs=[], remoteJobs=[], localJobs=new Map(), jobsRead=0, submittedReceipt=null;
let pollTimer, refreshing=false, refreshAgain=false, visiblePages=1;
let historyFilter={look:'',status:'all'}, historyLoaded=false;
let canStoreJobs=Boolean(storage), savingResults=false, cacheAgain=false;
const resultURLs = new Map(), resultFailures = new Set(), removingJobs = new Set();
function jobRoute(job,suffix='') {return '/api/tryons/'+encodeURIComponent(job.id)+suffix;}
function safeResultURL(job,kind) {const value=job[kind+'_url'];return value===jobRoute(job,'/'+(kind==='image'?'image':'download'))?value:null;}
function jobReference(job){
  const reference=job.reference??{
    asset_id:job.reference_asset_id, source_url:job.reference_source_url, shot_index:job.reference_shot_index,
  };
  const {asset_id,source_url,shot_index}=reference;
  if(typeof asset_id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(asset_id)
    ||source_url!=='/api/content/assets/'+asset_id||!Number.isInteger(shot_index)
    ||shot_index<1||shot_index>9||shot_index!==job.shot_index)return null;
  return reference;
}
function closeTryOnComparison(){
  if(comparisonDialog.open)comparisonDialog.close();
  $('tryon-comparison-result').removeAttribute('src');
  $('tryon-comparison-reference').removeAttribute('src');
  $('tryon-comparison-reference-link').removeAttribute('href');
}
function showTryOnComparison(job,reference){
  const url=savedResultURL(job)||(session&&job.online?safeResultURL(job,'image'):null);
  if(!url||comparisonDialog.open)return;
  const result=$('tryon-comparison-result'),source=$('tryon-comparison-reference');
  comparisonJob={id:job.id,cached:!!job.cachedImage};
  result.hidden=false;source.hidden=false;
  $('tryon-comparison-result-status').textContent='';
  $('tryon-comparison-reference-status').textContent='';
  $('tryon-comparison-reference-caption').textContent='服装参考 · 第 '+String(reference.shot_index).padStart(2,'0')+' 格';
  $('tryon-comparison-reference-link').href=reference.source_url;
  positionReference(source,reference.shot_index);
  comparisonDialog.showModal();
  result.src=url;
  source.src=reference.source_url;
}
$('tryon-comparison-close').addEventListener('click',closeTryOnComparison);
comparisonDialog.addEventListener('close',()=>{
  if(comparisonDialog.open)return;
  const id=comparisonJob?.id;
  comparisonJob=null;
  closeTryOnComparison();
  if(!id||!dialog.open)return;
  const card=$('tryon-jobs').querySelector('[data-job-id="'+CSS.escape(id)+'"]');
  (card?.querySelector('[data-job-action="compare"]')||card?.querySelector('h4')||$('tryon-jobs-title')).focus();
});
for(const [side,message] of [['result','成片暂不可用，请返回试穿记录刷新。'],['reference','参考镜头暂不可用，联网后可再次查看。']]){
  const image=$('tryon-comparison-'+side);
  image.addEventListener('error',()=>{
    if(!comparisonDialog.open)return;
    image.hidden=true;
    $('tryon-comparison-'+side+'-status').textContent=message;
  });
}
function updateJobs() {
  const shown=new Map();
  for(const job of remoteJobs){
    const local=localJobs.get(job.id);
    if(!local?.deleted)shown.set(job.id,{
      ...job,online:true,look_title:job.look_title||local?.look_title,cachedImage:local?.cachedImage,
      reference:jobReference(job)||(local?jobReference(local):null),
    });
  }
  for(const job of localJobs.values()){
    if(!job.deleted&&!shown.has(job.id)){
      shown.set(job.id,{...job,online:false,image_url:null,download_url:null});
    }
  }
  jobs=[...shown.values()].map(job=>job.cachedImage?{...job,status:'succeeded',error_message:null,error_code:null}:job);
  jobs.sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0));
  if(comparisonDialog.open&&comparisonJob){
    const job=shown.get(comparisonJob.id);
    if(!job||(comparisonJob.cached?!job.cachedImage:!session||!job.online||!safeResultURL(job,'image')))closeTryOnComparison();
  }
  $('tryon-pending-deletion').hidden=![...localJobs.values()].some(job=>job.deleted&&job.pending);
  renderJobs();
}
async function readLocalJobs() {
  if(!storage)return false;
  const read=++jobsRead;
  try {
    const records=await storage.listJobs();
    if(read!==jobsRead)return false;
    localJobs=new Map(records.map(job=>[job.id,job]));
    updateJobs();
    return true;
  } catch {
    if(read===jobsRead){
      canStoreJobs=false;
      $('tryon-storage-status').textContent='暂时无法读取本机试穿记录。';
      updateJobs();
    }
    return false;
  }
}
async function storeRemoteJobs(rows, updatedAt, revision) {
  if(!storage||!rows.length)return;
  const publicFields=rows.filter(job=>typeof job.id==='string'&&job.id).map(job=>{
    const reference=jobReference(job);
    return {
      id:job.id, status:job.status, look_id:job.look_id, edition:job.edition,
      shot_index:job.shot_index, pose_mode:job.pose_mode, created_at:job.created_at, queue_position:job.queue_position,
      error_code:job.error_code, error_message:job.error_message, look_title:job.look_title||byId.get(job.look_id)?.title, updatedAt,
      ...(reference?{reference_asset_id:reference.asset_id,reference_source_url:reference.source_url,reference_shot_index:reference.shot_index}:{}),
    };
  });
  try {
    await storage.putJobs(publicFields);
    canStoreJobs=true;
    if(revision===sessionRevision){
      await readLocalJobs();
      if(revision===sessionRevision){
        for(const job of remoteJobs)if(localJobs.get(job.id)?.pending)syncDeletedJob(job.id,revision);
        cacheResults();
      }
    }
  } catch {
    canStoreJobs=false;
    $('tryon-storage-status').textContent='试穿记录暂未保存到本机，在线结果仍可查看。';
    updateJobs();
  }
}
async function cacheResults() {
  if(!canStoreJobs||!session)return;
  if(savingResults){cacheAgain=true;return;}
  savingResults=true;
  const revision=sessionRevision;
  try {
    for(const job of remoteJobs){
      if(revision!==sessionRevision)break;
      const id=job.id, local=localJobs.get(id), url=safeResultURL(job,'image');
      if(job.status!=='succeeded'||!url||!local||local.cachedImage||local.deleted||resultFailures.has(id))continue;
      try {
        const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error'});
        if(!response.ok)throw new Error('Result unavailable');
        const image=await response.blob();
        if(image.type!=='image/webp'||!image.size)throw new Error('Invalid result image');
        if(revision!==sessionRevision)break;
        await storage.saveImage(id,image);
        await readLocalJobs();
      } catch {
        if(revision!==sessionRevision)break;
        resultFailures.add(id);
        $('tryon-storage-status').textContent='部分成片暂未保存到本机，可刷新后再保存。';
        updateJobs();
      }
    }
  } finally {
    savingResults=false;
    if(cacheAgain){cacheAgain=false;queueMicrotask(cacheResults);}
  }
}
function releaseResultURLs() {
  for(const url of resultURLs.values())URL.revokeObjectURL(url);
  resultURLs.clear();
}
function savedResultURL(job) {
  if(!dialog.open||!job.cachedImage)return null;
  if(!resultURLs.has(job.id))resultURLs.set(job.id,URL.createObjectURL(job.cachedImage));
  return resultURLs.get(job.id);
}
async function syncDeletedJob(id, revision) {
  if(revision!==sessionRevision||!session||!remoteJobs.some(job=>job.id===id)||removingJobs.has(id))return false;
  removingJobs.add(id);
  try {
    await api(jobRoute({id}),{method:'DELETE'});
    await storage.confirmDeletion(id);
    await readLocalJobs();
    return true;
  } catch(error) {
    $('tryon-jobs-status').textContent=error.message;
    return false;
  } finally {removingJobs.delete(id);}
}
async function removeRecord(job, button) {
  const local=localJobs.get(job.id);
  const cancel=activeStatuses.has(job.status)&&job.online;
  const localDelete=!cancel&&(canStoreJobs||Boolean(local));
  const prompt=localDelete
    ?'删除本机的这条记录和成片？在线结果会在可访问时同步清除。已开始的生成无法撤回。'
    :'取消或删除后不再保留结果，试穿记录仍会保留。已开始的生成无法撤回，确认继续？';
  if(!confirm(prompt))return;
  button.disabled=true;
  const revision=sessionRevision;
  try {
    if(localDelete){
      await storage.deleteJob(job.id,true);
      jobsRead++;
      localJobs.set(job.id,{id:job.id,deleted:true,pending:true});
      updateJobs();
      await readLocalJobs();
      if(!await syncDeletedJob(job.id,revision))return;
    }else {
      await api(jobRoute(job),{method:'DELETE'});
    }
    if(revision===sessionRevision&&session)await refreshJobs();
  } catch(error){
    $('tryon-jobs-status').textContent=error.message;button.disabled=false;
  }
}
function hasHistoryFilter(){
  return !!historyFilter.look||historyFilter.status!=='all';
}
function matchesJob(job,filter=historyFilter,serverMatched=false){
  if(filter.status==='active'&&!activeStatuses.has(job.status))return false;
  if(filter.status==='success'&&job.status!=='succeeded')return false;
  if(filter.status==='failed'&&!failedStatuses.has(job.status))return false;
  if(serverMatched||!filter.look)return true;
  const id=/^#?(\d+)$/.exec(filter.look);
  if(id)return Number(id[1])===job.look_id;
  return (job.look_title||byId.get(job.look_id)?.title||'').toLowerCase().includes(filter.look.toLowerCase());
}
function setHistoryFilter(look,status){
  if(historyFilter.look===look&&historyFilter.status===status)return;
  historyFilter={look,status};
  visiblePages=1;historyLoaded=false;
  remoteJobs=[];
  $('tryon-more').hidden=true;$('tryon-more-note').hidden=true;
  $('tryon-clear-history-filter').setAttribute('aria-disabled',String(!hasHistoryFilter()));
  $('tryon-jobs-status').textContent=session
    ?(hasHistoryFilter()?'正在筛选在线试穿记录…':'正在读取试穿记录…')
    :hasHistoryFilter()?'已筛选本机记录。联网并刷新后可查询在线记录。':'已显示本机试穿记录。';
  updateJobs();
  if(session)refreshJobs();
}
$('tryon-history-filter').addEventListener('submit',event=>{
  event.preventDefault();
  setHistoryFilter($('tryon-history-look').value.trim(),$('tryon-history-status').value);
});
$('tryon-clear-history-filter').addEventListener('click',()=>{
  if(!hasHistoryFilter())return;
  $('tryon-history-filter').reset();
  setHistoryFilter('','all');
  $('tryon-history-look').focus({preventScroll:true});
});
function filteredJobs(){
  return jobs.filter(job=>!(historyFilter.status==='active'&&historyLoaded&&!job.online)&&matchesJob(job,historyFilter,job.online));
}
function renderJobs() {
  const focused=listFocusedAction();
  const list=$('tryon-jobs');list.replaceChildren();
  syncFlow();
  const saved=new Set(jobs.filter(job=>job.cachedImage).map(job=>job.id));
  for(const [id,url] of resultURLs){
    if(!saved.has(id)){
      URL.revokeObjectURL(url);resultURLs.delete(id);
    }
  }
  const shown=filteredJobs();
  if(!shown.length){
    const message=hasHistoryFilter()?'当前没有符合筛选条件的试穿记录。':'还没有试穿记录。打开一套造型，点击「拍照试穿」开始。';
    list.append(element('p',message));
    if(focused)$('tryon-jobs-title').focus({preventScroll:true});
    return;
  }
  for(const job of shown){
    const card=element('article',undefined,'tryon-job');card.dataset.jobId=job.id;card.dataset.jobStatus=job.status;
    const look=byId.get(job.look_id);
    const heading=element('h4','LOOK '+String(job.look_id).padStart(3,'0')+' · 参考 '+String(job.shot_index).padStart(2,'0')+' · '+(job.look_title||look?.title||''));heading.tabIndex=-1;heading.dataset.jobAction='heading';card.append(heading);
    let status=statusNames[job.status]||'未知状态，请刷新进度确认。';
    if(job.pose_mode==='pose_grid')status='九宫格姿态 · '+status;
    if(job.cachedImage)status+=' · 已保存到本机';
    else if(!job.online)status='本机记录 · '+status;
    if(job.status==='queued'&&Number.isInteger(job.queue_position))status+=' · 前方 '+job.queue_position+' 个任务';
    card.append(element('p',status,'tryon-job-status'));
    if(job.online&&activeStatuses.has(job.status)){
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
      const localURL=savedResultURL(job);
      const useRemote=job.online&&(!canStoreJobs||resultFailures.has(job.id));
      const imageURL=localURL||(useRemote?safeResultURL(job,'image'):null);
      const downloadURL=localURL||(job.online?safeResultURL(job,'download'):null);
      if(imageURL){
        const image=element('img');image.src=imageURL;image.alt='AI 生成试穿结果 · LOOK '+job.look_id;image.loading='lazy';
        image.addEventListener('error',()=>{image.hidden=true;card.append(element('p','结果暂时无法读取，请刷新确认。'));});card.append(image);
      }
      if(!imageURL&&dialog.open&&!job.cachedImage)card.append(element('p',job.online?'正在保存成片到本机…':'成片尚未保存在本机，可联网后刷新进度。','tryon-hint'));
      if(downloadURL){const link=element('a','下载结果 ↓','outline-button');link.href=downloadURL;link.download='tryon-'+job.id+'.webp';link.dataset.jobAction='download';card.append(link);}
      const reference=jobReference(job);
      if((job.cachedImage||job.online&&safeResultURL(job,'image'))&&reference){
        const compare=element('button','对比服装参考','outline-button');
        compare.type='button';compare.dataset.jobAction='compare';compare.setAttribute('aria-haspopup','dialog');
        compare.addEventListener('click',()=>showTryOnComparison(job,reference));card.append(compare);
      }else if(!reference){
        card.append(element('p','这条记录未保存可核对的服装参考。','tryon-hint'));
      }
    }
    if(failedStatuses.has(job.status)&&job.edition==='v2'&&look?.versions.v2?.shots?.[job.shot_index-1]){
      const uncertain=job.status==='unknown';
      const retry=element('button',uncertain?'准备重试':'重新准备照片','outline-button');retry.dataset.jobRetry=job.id;retry.dataset.jobAction='retry';retry.addEventListener('click',()=>{
        if(busy)return;
        clearPhoto();
        if(uncertain)$('tryon-status').textContent='';
        prepareContext({look_id:job.look_id,edition:'v2',shot_index:job.shot_index},uncertain,job.pose_mode);
        jumpTo('tryon-photo-title');
      });card.append(retry);
    }
    const label=job.online&&activeStatuses.has(job.status)?'取消本次试穿':canStoreJobs||localJobs.has(job.id)?'删除记录':'删除生成结果';
    const remove=element('button',label,'text-button');remove.type='button';remove.dataset.jobDelete=job.id;remove.dataset.jobAction='delete';
    remove.addEventListener('click',()=>removeRecord(job,remove));card.append(remove);list.append(card);
  }
  if(focused){
    const card=list.querySelector('[data-job-id="'+CSS.escape(focused.id)+'"]');
    (card?.querySelector('[data-job-action="'+focused.action+'"]')||card?.querySelector('h4')||$('tryon-jobs-title')).focus({preventScroll:true});
  }
}
function listFocusedAction() {
  const active=document.activeElement;
  if(!$('tryon-jobs').contains(active)||!['heading','download','compare','retry','delete'].includes(active?.dataset?.jobAction))return null;
  return {id:active.closest('[data-job-id]').dataset.jobId,action:active.dataset.jobAction};
}
async function refreshJobs() {
  if(!session)return;
  if(refreshing){refreshAgain=true;return;}
  const revision=sessionRevision, started=Date.now(), filter=historyFilter;
  const current=()=>revision===sessionRevision&&filter===historyFilter;
  refreshing=true;clearTimeout(pollTimer);$('tryon-refresh').disabled=true;$('tryon-more').disabled=true;
  try {
    const collected=[];let response;
    for(let page=0;page<visiblePages;page++){
      const params=new URLSearchParams();
      if(page)params.set('offset',collected.length);
      if(filter.look)params.set('look',filter.look);
      if(filter.status!=='all')params.set('status',filter.status);
      response=await api('/api/tryons'+(params.size?'?'+params:''));
      if(!current())return;
      if(!Array.isArray(response.items))throw new Error('无法读取试穿记录，请刷新重试。');
      collected.push(...response.items);
      if(!response.has_more||!response.items.length)break;
    }
    const received=new Map(collected.map(job=>[job.id,job]));
    if(submittedReceipt?.at>=started&&matchesJob(submittedReceipt.job,filter)&&!received.has(submittedReceipt.job.id))received.set(submittedReceipt.job.id,submittedReceipt.job);
    remoteJobs=[...received.values()];historyLoaded=true;updateJobs();
    storeRemoteJobs(remoteJobs,started,revision);
    $('tryon-more-note').hidden=!response.has_more;$('tryon-more').hidden=!response.has_more;
    const matching=filteredJobs();
    const latest=matching.find(job=>activeStatuses.has(job.status))||matching[0];
    const notice='进度已更新。'+(latest?'最近试穿：'+(statusNames[latest.status]||'状态待确认')+'。':'')+recoveryNotice;
    if($('tryon-jobs-status').textContent!==notice)$('tryon-jobs-status').textContent=notice;
  } catch(error){
    if(current()){
      historyLoaded=false;
      renderJobs();
      $('tryon-jobs-status').textContent='进度暂未更新：'+error.message+' 当前内容可能不是最新状态。';
    }
  } finally {
    refreshing=false;$('tryon-refresh').disabled=false;$('tryon-more').disabled=false;
    if(refreshAgain){refreshAgain=false;queueMicrotask(refreshJobs);}
    else if(session&&jobs.some(job=>job.online&&activeStatuses.has(job.status)))pollTimer=setTimeout(refreshJobs,3000);
  }
}
$('tryon-more').addEventListener('click',()=>{if(!refreshing){visiblePages++;refreshJobs();}});
$('tryon-refresh').addEventListener('click',()=>{
  if(busy||refreshing)return;
  resultFailures.clear();$('tryon-storage-status').textContent='';
  readPhotos();readLocalJobs();
  if(session)refreshJobs();else bootstrap(true);
});
function jumpTo(id) {
  const heading=$(id);
  heading.focus({preventScroll:true});
  heading.scrollIntoView({block:'start',behavior:'instant'});
}
$('tryon-jump-photos').addEventListener('click',()=>jumpTo('tryon-photo-title'));
$('tryon-jump-jobs').addEventListener('click',()=>jumpTo('tryon-jobs-title'));
function open() {
  if(!dialog.open){dialog.showModal();dialog.scrollTop=0;}
  renderPhotos();updateJobs();readPhotos();readLocalJobs();
  if(session)refreshJobs();
}
storage?.onChange(type=>{
  if(type==='photos')readPhotos();
  if(type==='jobs')readLocalJobs();
});
window.addEventListener('online',()=>{
  if(dialog.open&&session)refreshJobs();
});
function photoValidationMessage(error) {
  if(error.status===422){
    if(error.code==='face_too_small')return '请选更清晰的全身原图，或裁掉周围多余空白，保留头顶和鞋履。';
    if(error.code==='face_count')return '请选单人正面全身照，让脸部清楚可见，保留头顶和鞋履。';
    if(error.code==='invalid_image')return '请换用清晰的 JPEG、PNG 或 WebP 全身照，保留头顶和鞋履。';
  }
  if(error.status===413&&error.code==='upload_too_large')return '请压缩照片文件或换一张，保留头顶和鞋履。';
  return '';
}
$('detail-tryon').addEventListener('click', () => {
  if(!busy)prepareContext();
  open();
  if(frozen){$('tryon-photo-title').focus({preventScroll:true});track('tryon_open',frozen);}
});
function openDashboard() {
  if(!busy){frozen=null;retryingUnknown=false;renderContext();syncControls();}
  open();
}
for(const id of ['tryon-history','tryon-header'])$(id).addEventListener('click',openDashboard);
$('tryon-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close',closeTryOnComparison);
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
    const form=new FormData();form.append('photo',file,'portrait.'+photoTypes[file.type]);
    for(const [key,value] of Object.entries(context))form.append(key,String(value));
    if(session.pose_grid_available&&poseMode==='pose_grid')form.append('pose_mode',poseMode);
    const submission=JSON.stringify([context.look_id,context.edition,context.shot_index,poseMode]);
    if(pendingSubmission?.context!==submission)pendingSubmission={context:submission,key:randomId()};
    form.append('idempotency_key',pendingSubmission.key);form.append('disclosure_version',session.disclosure.version);
    $('tryon-status').textContent='正在发送，请勿重复提交…';
    const job=await api('/api/tryons',{method:'POST',body:form});
    if(typeof job?.id!=='string'||!job.id||typeof job.status!=='string'||!job.status)throw new Error('暂未收到有效的试穿回执。');
    submittedJobId=job.id;submittedReceipt={at:Date.now(),job};
    if(matchesJob(job))remoteJobs=[job,...remoteJobs.filter(item=>item.id!==job.id)];
    updateJobs();
    storeRemoteJobs([job],submittedReceipt.at,sessionRevision);
    retryingUnknown=false;
    clearPhoto();
    $('tryon-library-status').textContent='';
    $('tryon-status').textContent='已提交 · '+(statusNames[job.status]||job.status)+'。可在我的试穿中查看进度。';
    await refreshJobs();
    if(dialog.open){
      const card=$('tryon-jobs').querySelector('[data-job-id="'+CSS.escape(job.id)+'"]');
      card?.querySelector('h4')?.focus({preventScroll:true});
      card?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
  } catch(error) {
    const guidance=photoValidationMessage(error);
    if(guidance){
      photoRejection='未创建试穿任务。'+guidance;
      $('tryon-status').textContent=photoRejection;
    }else{
      $('tryon-status').textContent=error.message+' 未自动重试；请先刷新进度确认是否已接收。';
    }
  } finally {busy=false;syncControls();}
});
async function bootstrap(explicit=false) {
  if(reconnecting)return;
  reconnecting=true;
  const previousVisitor=session?.visitor?.id, pages=visiblePages;
  if(explicit){
    clearSession();
    recoveryNotice=recoveryHistoryNotice+'未自动重试照片提交。';
  }
  $('tryon-refresh').disabled=true;
  try {
    if(!['http:','https:'].includes(location.protocol))throw new Error('本地离线浏览不支持在线试穿；衣橱和收藏仍可使用。');
    session = await api('/api/bootstrap');
    if(photo&&(photoLimit('max_upload_bytes')||photoLimit('max_image_dimension')||photoLimit('max_pixels'))){
      await previewPhoto(photo,savedPhotoId);
    }
    if(previousVisitor&&previousVisitor===session.visitor?.id)visiblePages=pages;
    track('page_view');if(currentContext)track('look_open',currentContext);
    $('tryon-disclosure-title').textContent=session.disclosure.title||'照片用途';
    $('tryon-disclosure-items').replaceChildren();
    for(const item of session.disclosure.items||[]){const li=document.createElement('li');li.textContent=item;$('tryon-disclosure-items').append(li);}
    $('tryon-consent-label').hidden=Boolean(session.disclosure.accepted);syncControls();
    const message = session.generation_available ? '在线试穿已连接' : '试穿暂不可用：生成服务尚未就绪，衣橱仍可浏览。';
    $('tryon-availability').textContent = message;
    if(!photoRejection)$('tryon-status').textContent = message+' '+recoveryNotice;
    await refreshJobs();
  } catch(error) {
    $('tryon-availability').textContent = '试穿暂不可用';
    $('tryon-status').textContent = error.message;
  } finally {reconnecting=false;$('tryon-refresh').disabled=false;syncControls();}
}
readLocalJobs().then(()=>bootstrap());
})();
