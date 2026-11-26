(() => {
'use strict';
let data = {}, looks = [], indexedLooks = [], categories = [], models = [];
const byId = new Map();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = id => String(id).padStart(3,'0');
const storageKey = 'wardrobe99:favorites:v1';
let saved = [];
try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(value)) saved = value.filter(id => Number.isSafeInteger(id) && id > 0); } catch {}
const favorites = new Set(saved), compare = new Set();
let compareFullBody = false;
const productStorageKey='yixu:product-favorites:v1';
let productSaved=[];
try{const value=JSON.parse(localStorage.getItem(productStorageKey)||'[]');if(Array.isArray(value))productSaved=value.filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id));}catch{}
const productFavorites=new Set(productSaved);
let favoriteStore=window.WardrobeFavorites?.create({lookKey:storageKey,productKey:productStorageKey});
const favoriteReads={look:0,product:0};
const favoriteWrites=new Set();
const state = {category:'', season:'', query:'', model:'', region:'', piece:'', colors:[], batch:'', latestOnly:false, favoritesOnly:false, sort:'latest', page:'home', profileModel:'', productId:'', scene:'', limit:24, active:null, view:0};
let filtered = [], toastTimer, detailReturnRoute = '#/home', routing = false, detailNavigation = null, focusArchive = false, routeDetailCloses = 0, detailSceneOpener = null, detailArchiveOpener = null;
let detailProductFocus = '';
const scenes = new Map((window.WARDROBE_SCENES || []).map(scene=>[scene.id,scene]));
const styleIdeas = new Map((window.WardrobeStylingIdeas || []).map(group=>[group.productId,group]));
const pieceMatch = window.WardrobePieceMatch;
const pieceTypes = new Map((pieceMatch?.categories || []).map(category=>[category.id,category.title]));
const colorMatch = window.WardrobeColorMatch;
const colorTypes = new Map((colorMatch?.families || []).map(color=>[color.id,color.label]));
const recentStore = window.WardrobeRecent;
let recentRender = 0;
let recentFocusLook = null;
let publications = new Map();
const snapshotRevision = window.WARDROBE?.revision;
function latestLooks(selection=indexedLooks) {
  const rank = new Map((data.latestOrder || []).map((id,index)=>[id,index]));
  return [...selection].sort((a,b)=> rank.has(a.id)&&rank.has(b.id) ? rank.get(a.id)-rank.get(b.id) : rank.has(a.id) ? -1 : rank.has(b.id) ? 1 : String(b.published_at||b.publish_date||'').localeCompare(String(a.published_at||a.publish_date||''))||b.id-a.id);
}
function publication(look) { return look.publish_date || (look.published_at ? look.published_at.slice(0,10) : '历史档案'); }
function featuredLook() {
  const featured=byId.get(data.home?.featured_look_id);
  return featured&&!featured.model_only?featured:latestLooks()[0];
}
const heart = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 5.6c-2.2-2.5-5.9-1.8-8.5 1-2.6-2.8-6.3-3.5-8.5-1-3.2 3.5.3 8 8.5 13.5 8.2-5.5 11.7-10 8.5-13.5Z"/></svg>';
const comparison = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v18h6M15 3h6v18h-6M12 2v20"/></svg>';
// The server provides only registered public assets. Never accept a private API
// URL, credentials, traversal, query, or an arbitrary cross-origin fallback.
function publicSource(value, download = false) {
  if(typeof value !== 'string' || /[\\?#%]/.test(value) || value.split('/').some(part=>part==='.'||part==='..'))return '';
  const clean=value.replace(/^\//,'');
  if(/^(?:images-v2|assets\/(?:looks|model-bases|products))\/[a-zA-Z0-9_./-]+\.webp$/.test(clean))return value;
  if(new RegExp('^/api/content/assets/[a-zA-Z0-9_-]+'+(download?'(?:/download)?':'')+'$').test(value))return value;
  return '';
}
function imageURL(version) {
  const source=publicSource(version.source_url || version.image);
  const preferred=version.image_url || version.image;
  if(preferred===source)return source;
  try { const url=new URL(preferred,location.href); if(url.protocol==='https:'&&!url.username&&!url.password)return url.href; } catch {}
  return source;
}
function imageAttributes(version) {
  return 'src="'+esc(imageURL(version))+'" data-source="'+esc(publicSource(version.source_url || version.image))+'" data-public-image="true"';
}
function setImage(image,version) {
  image.hidden=false; image.dataset.source=publicSource(version.source_url || version.image);
  image.dataset.publicImage='true'; delete image.dataset.fallback; delete image.dataset.failed;
  image.parentElement.classList.remove('image-unavailable'); image.src=imageURL(version);
}
function imageFailed(event) {
  const image=event.target;if(image?.dataset?.publicImage!=='true')return;
  const source=publicSource(image.dataset.source);
  if(!image.dataset.fallback && source && image.getAttribute('src')!==source){image.dataset.fallback='true';image.src=source;return;}
  image.dataset.failed='true';image.hidden=true;
  image.parentElement.classList.add('image-unavailable');image.parentElement.setAttribute('data-image-status','图片暂不可用');
}
document.addEventListener('error',imageFailed,true);
window.WardrobeImages={set:setImage};
function latestBatch() {
  return data.home?.latest_batch_id || latestLooks().find(l=>l.batch_id)?.batch_id || '';
}
function modelName(id) { return models.find(model=>model.id===id)?.name || id; }
function modelRoute(id) { return '#/models/'+encodeURIComponent(id); }
function modelLooks(id) { return latestLooks(looks.filter(look=>look.model_id===id)); }
function validProductPresentation(product){
 const slug=value=>typeof value==='string'&&value.trim()===value&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
 const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
 const presentation=product.presentation,copy=product.copy;
 if(presentation!==undefined&&(!object(presentation)||Object.keys(presentation).some(key=>!['theme','preset'].includes(key))||(presentation.theme!==undefined&&!slug(presentation.theme))||(presentation.preset!==undefined&&!slug(presentation.preset))))return false;
 const copyKeys=['hero_title','views_title','details_title','worn_title','related_title'];
 return copy===undefined||(object(copy)&&Object.entries(copy).every(([key,value])=>copyKeys.includes(key)&&typeof value==='string'&&value.trim().length>0&&[...value].length<=200));
}
function adoptCatalog(candidate) {
  if(!candidate || !Array.isArray(candidate.looks)||!Array.isArray(candidate.categoryOrder)||!candidate.categoryOrder.every(c=>typeof c==='string')||(candidate.models!==undefined&&(!Array.isArray(candidate.models)||!candidate.models.every(m=>m&&typeof (m.model_id||m.id)==='string'&&typeof m.name==='string'))))return false;
  const next=[], seen=new Set();
  for(const look of candidate.looks){
    const v=look?.versions?.v2;
    if(!Number.isSafeInteger(look?.id)||look.id<1||seen.has(look.id)||!v||v.ready===false||typeof look.title!=='string'||!Array.isArray(v.shots)||v.shots.length!==9||!v.shots.every(shot=>shot&&typeof shot.title==='string')||(v.moods!==undefined&&!Array.isArray(v.moods))||(look.region!=null&&typeof look.region!=='string'&&typeof look.region?.city!=='string')||['published_at','publish_date','batch_id','model_id'].some(key=>look[key]!=null&&typeof look[key]!=='string')||['palette','tags','details','pieces'].some(key=>look[key]!==undefined&&!Array.isArray(look[key]))||!publicSource(v.source_url||v.image))return false;
    if(look.model_only!==undefined&&typeof look.model_only!=='boolean')return false;
    if(look.model_only&&!candidate.models?.some(model=>(model.model_id||model.id)===look.model_id))return false;
    seen.add(look.id);next.push({...look,region:typeof look.region==='string'?look.region:(look.region?.city||''),pieces:Array.isArray(look.pieces)?look.pieces:[],details:Array.isArray(look.details)?look.details:[],versions:{v2:{...v,ready:true}}});
  }
  const offeredProducts=candidate.products??[];
  if(!Array.isArray(offeredProducts)||!offeredProducts.every(p=>{
    return p&&validProductPresentation(p)&&/^[A-Za-z0-9_-]+$/.test(p.product_id)&&['name','category','subtitle','description','color_name','design_material'].every(key=>typeof p[key]==='string')&&/^#[a-fA-F0-9]{6}$/.test(p.color_hex)&&Array.isArray(p.notes)&&p.notes.every(n=>typeof n==='string')&&publicSource(p.asset?.source_url||p.asset?.file)&&(p.gallery===undefined||(Array.isArray(p.gallery)&&p.gallery.length<=8&&p.gallery.every(image=>image&&typeof image.title==='string'&&typeof image.caption==='string'&&(image.role===undefined||['view','detail'].includes(image.role))&&(image.design_study===undefined||typeof image.design_study==='boolean')&&publicSource(image.asset?.source_url||image.asset?.file))))&&Array.isArray(p.appearances)&&p.appearances.every(a=>{const look=next.find(l=>l.id===a.look_id);return look&&Number.isSafeInteger(a.piece_index)&&a.piece_index>=1&&a.piece_index<=look.pieces.length&&a.reference_asset_id===look.versions.v2.asset?.asset_id&&Number.isInteger(a.shot_index)&&a.shot_index>=1&&a.shot_index<=9;});
  }))return false;
  if(new Set(offeredProducts.map(p=>p.product_id)).size!==offeredProducts.length)return false;
  const productAsset=a=>({...a,source_url:a.source_url||a.file,image_url:a.image_url||a.source_url||a.file});
  data={...candidate,products:offeredProducts.map(p=>({...p,presentation:{theme:'editorial',...p.presentation},copy:p.copy||{},asset:productAsset(p.asset),gallery:(p.gallery||[]).map(image=>({...image,asset:productAsset(image.asset)}))})),looks:next};looks=next;byId.clear();looks.forEach(l=>byId.set(l.id,l));
  models=Array.isArray(data.models)?data.models.map(model=>({...model,id:model.model_id||model.id})):[];
  indexedLooks=looks.filter(l=>!l.model_only);
  const directory=window.WardrobePublication?.build(data);
  publications=new Map((directory?.batches||[]).map(batch=>[batch.id,batch]));
  if(directory?.undatedLookIds.length)publications.set('undated',{id:'undated',title:'历史穿搭',lookIds:directory.undatedLookIds});
  categories=[...new Set([...(data.categoryOrder||[]),...indexedLooks.map(l=>l.category)])].filter(c=>indexedLooks.some(l=>l.category===c));
  window.WARDROBE=data;window.WardrobeTryOn?.setCatalog?.(data);
  if(state.category&&!categories.includes(state.category))state.category='';
  if(state.model&&!indexedLooks.some(l=>l.model_id===state.model))state.model='';
  if(state.region&&!indexedLooks.some(l=>l.region===state.region))state.region='';
  if(state.latestOnly&&!latestBatch())state.latestOnly=false;
  for(const id of compare)if(!byId.has(id)||byId.get(id).model_only)compare.delete(id);
  buildCategories();buildContentFilters();updateCounts();updateEditionUI();renderModels();refreshFilters();renderCompareTray();
  if($('compare-dialog').open){if(compare.size>=2)openComparison();else $('compare-dialog').close();}
  routeFromURL(false,location.hash,{hydrating:true});
  if($('wardrobe-list-picker').open)wardrobeListPage?.render();
  productComparison?.refresh();
  return true;
}
function buildContentFilters(){
  $('model-filter').innerHTML='<option value="">全部模特</option>'+[...new Set(indexedLooks.map(l=>l.model_id).filter(Boolean))].map(id=>'<option value="'+esc(id)+'">'+esc(modelName(id))+'</option>').join('');
  $('region-filter').innerHTML='<option value="">全部地区</option>'+[...new Set(indexedLooks.map(l=>l.region).filter(Boolean))].sort().map(region=>'<option value="'+esc(region)+'">'+esc(region)+'</option>').join('');
  $('latest-only').disabled=!latestBatch();
}
async function hydrateCatalog(){
  if(!['http:','https:'].includes(location.protocol)||typeof fetch!=='function')return;
  try{
    const response=await fetch('/api/content/catalog',{credentials:'omit',cache:'no-cache',headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('catalog');
    const candidate=await response.json();
    if(snapshotRevision && candidate.revision && snapshotRevision!==candidate.revision){$('catalog-status').textContent='内容同步中，当前展示已发布版本';return;}
    if(!adoptCatalog(candidate))throw new Error('catalog');
    $('catalog-status').textContent='';
  }catch{$('catalog-status').textContent='正在浏览本地内容快照';}
}
function notify(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function palette(look) { return (look.palette || []).filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => '<span class="color-swatch" style="background:'+c+'" title="'+c+'"></span>').join(''); }
function versionOf(look) { return look.versions.v2; }
function photo(look, alt) {
 const v=versionOf(look),p=Math.min(9,Math.max(1,v.previewPanel||1)),next=p%9+1;
 const x=-((p-1)%3)*100,y=-Math.floor((p-1)/3)*100,nx=-((next-1)%3)*100,ny=-Math.floor((next-1)/3)*100;
 return '<div class="photo-window" style="--panel-x:'+x+'%;--panel-y:'+y+'%;--next-x:'+nx+'%;--next-y:'+ny+'%"><img '+imageAttributes(v)+' alt="'+esc(alt || look.title+' · '+(v.shots[p-1]?.title||'写真'))+'" loading="lazy" decoding="async"></div>';
}
function updateHeroCover(look, theme) {
 const v=versionOf(look),panel=Math.min(9,Math.max(1,v.previewPanel||1));
 const image=$('hero-image-0'),frame=image.parentElement,fullSheet=theme==='contact-sheet';
 const caption=fullSheet?'完整九宫格':(v.shots[panel-1]?.title||'生动写真');
 if(fullSheet)frame.classList.add('full-sheet');
 else frame.classList.remove('full-sheet');
 image.alt=look.title+' · '+caption;
 frame.style.setProperty('--panel-x',-((panel-1)%3)*100+'%');
 frame.style.setProperty('--panel-y',-Math.floor((panel-1)/3)*100+'%');
 $('hero-edition-note').textContent='LOOK '+number(look.id)+' / '+caption;
}
function updateEditionUI(){
 renderHomeProducts();
 $('completion-note').textContent=indexedLooks.length+' 套生动穿搭';
 $('hero-total').textContent=indexedLooks.length+' 套穿搭，持续更新';
 const look=featuredLook();
 $('latest-feature').hidden=!look;
 if(!look){$('recent-gallery').innerHTML='';$('recent-gallery').parentElement.hidden=true;return;}
 const v=versionOf(look);
 $('hero-title').textContent=look.title;
 $('hero-publication').textContent=publication(look)+' · LOOK '+number(look.id);
 $('hero-kicker').innerHTML='<span class="small-line"></span>'+((look.published_at||look.publish_date)?'最新一期 / THE LATEST EDIT':'历史精选 / FROM THE ARCHIVE');
 $('hero-meta').textContent=[look.region,look.model_id?modelName(look.model_id):'',look.category].filter(Boolean).join(' / ');
 $('hero-description').textContent=look.description||v.summary||'';
 $('hero-detail').dataset.open=look.id;$('hero-detail').disabled=false;
 $('hero-photo-button').dataset.open=look.id;$('hero-photo-button').disabled=false;
 $('hero-photo-button').setAttribute('aria-label','查看 '+look.title+' 的穿搭详情');
 $('hero-favorite').dataset.favorite=look.id;
 const liked=favorites.has(look.id);$('hero-favorite').textContent=liked?'♥ 已收藏':'♡ 收藏这套';$('hero-favorite').setAttribute('aria-pressed',String(liked));
 setImage($('hero-image-0'),v);
 updateHeroCover(look,window.YixuSiteTheme?.resolve());
 const recentIds=Array.isArray(data.home?.recent_look_ids)?data.home.recent_look_ids:null;
 const recent=(recentIds?recentIds.map(id=>byId.get(id)):latestLooks()).filter(l=>l&&!l.model_only&&l.id!==look.id).slice(0,6);
 $('recent-gallery').innerHTML=recent.map((look,index)=>renderCard(look,index)).join('');
 $('recent-note').textContent=recent.some(l=>!l.published_at&&!l.publish_date)?'最新一期之后，接着翻阅历史档案。':'';
 $('recent-gallery').parentElement.hidden=!recent.length;
}
function renderModels(){
 $('model-gallery').innerHTML=models.map(model=>{
   const owned=modelLooks(model.id),cover=owned[0];
   if(!cover)return '';
   const href=owned.some(look=>look.model_only)?modelRoute(model.id):'#/looks?model='+encodeURIComponent(model.id);
   return '<article class="model-card"><a href="'+href+'" aria-label="查看 '+esc(model.name)+' 的穿搭">'+photo(cover,model.name+' · '+cover.title)+'</a><p class="eyebrow">'+esc(model.id)+'</p><h2>'+esc(model.name)+'</h2><p>'+owned.length+' 套已发布穿搭</p><a class="model-looks-link" href="'+href+'">查看穿搭 ↗</a></article>';
 }).join('');
 $('models-empty').hidden=!!$('model-gallery').children.length;
}
function renderModelProfile(id) {
  const model=models.find(item=>item.id===id),owned=model?modelLooks(id):[];
  $('model-directory').hidden=!!owned.length;
  $('model-profile').hidden=!owned.length;
  $('model-looks-gallery').innerHTML=owned.map((look,index)=>renderCard(look,index)).join('');
  if(!owned.length)return;
  $('model-profile-id').textContent=model.id;
  $('model-profile-title').textContent=model.name+'的穿搭';
}
function saveFavorites() {
  try { localStorage.setItem(storageKey,JSON.stringify([...favorites])); }
  catch { notify('已在本次浏览中收藏；当前浏览器不允许持久保存'); }
}
function toggleFavorite(id,button) {
  if(favoriteStore){saveStoredFavorite('look',id,!favorites.has(id),button);return;}
  toggleLocalFavorite(id);
}
function toggleLocalFavorite(id) {
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  saveFavorites(); updateCounts();
  if (state.favoritesOnly || state.sort === 'favorites') renderGallery();
  syncCardButtons(id);
  if (state.active === id) updateDetailActions();
  updateEditionUI();
}
function syncProductFavorite(id){
  const product=(data.products||[]).find(item=>item.product_id===id);
  if(!product)return;
  const liked=productFavorites.has(id);
  document.querySelectorAll('[data-product-favorite="'+id+'"]').forEach(button=>{
    button.textContent=liked?'♥ 已收藏':'♡ 收藏单品';
    button.setAttribute('aria-pressed',String(liked));
    button.setAttribute('aria-label',(liked?'取消收藏':'收藏单品')+' '+product.name);
  });
}
function applyStoredFavorites(kind,ids){
  const target=kind==='look'?favorites:productFavorites;
  const next=new Set(ids);
  const changed=[...new Set([...target,...next])].filter(id=>target.has(id)!==next.has(id));
  if(!changed.length)return;
  target.clear();
  for(const id of next)target.add(id);
  if(kind==='look'){
    updateCounts();
    if(state.page==='favorites'||state.favoritesOnly||state.sort==='favorites')renderGallery();
    changed.filter(id=>byId.has(id)).forEach(syncCardButtons);
    if(state.active)updateDetailActions();
    updateEditionUI();
  }else{
    changed.forEach(syncProductFavorite);
    if(state.page==='products'&&new URLSearchParams(location.hash.split('?')[1]).get('saved')==='1')renderProducts();
  }
}
async function refreshStoredFavorites(kind){
  const request=++favoriteReads[kind];
  try{
    const ids=await favoriteStore.load(kind);
    if(favoriteStore&&request===favoriteReads[kind])applyStoredFavorites(kind,ids);
  }catch{}
}
function toggleLocalProductFavorite(id) {
  productFavorites.has(id)?productFavorites.delete(id):productFavorites.add(id);
  try{localStorage.setItem(productStorageKey,JSON.stringify([...productFavorites]));}catch{notify('当前浏览器无法保存单品收藏');}
  syncProductFavorite(id);
  if(state.page==='products'&&new URLSearchParams(location.hash.split('?')[1]).get('saved')==='1')renderProducts();
}
async function saveStoredFavorite(kind,id,enabled,button){
  const action=kind+':'+id;
  if(favoriteWrites.has(action))return;
  favoriteWrites.add(action);
  button?.setAttribute('aria-disabled','true');
  try{
    const store=favoriteStore;
    await store.set(kind,id,enabled);
    await refreshStoredFavorites(kind);
  }catch(error){
    if(error?.code==='indexeddb-unavailable'){
      favoriteStore=null;
      const set=kind==='look'?favorites:productFavorites;
      if(set.has(id)!==enabled)(kind==='look'?toggleLocalFavorite:toggleLocalProductFavorite)(id);
    }else notify(error?.message||'当前浏览器无法保存收藏。');
  }finally{
    favoriteWrites.delete(action);
    button?.removeAttribute('aria-disabled');
  }
}
function toggleCompare(id) {
  if(byId.get(id)?.model_only)return;
  if (compare.has(id)) compare.delete(id);
  else if (compare.size < 3) compare.add(id);
  else { notify('最多同时对比 3 套，请先移除一套'); return; }
  syncCardButtons(id); renderCompareTray();
  if (state.active === id) updateDetailActions();
}
function updateCounts() {
  const count=[...favorites].filter(id=>!byId.get(id)?.model_only).length;
  $('fav-top-count').textContent = count;
  $('favorites-count').textContent = count;
}
function syncCardButtons(id) {
  document.querySelectorAll('[data-favorite="'+id+'"]').forEach(button => {
    const on = favorites.has(id);
    button.classList.toggle('selected',on); button.setAttribute('aria-pressed',String(on));
    button.setAttribute('aria-label',(on?'取消收藏':'收藏')+' '+byId.get(id).title);
  });
  document.querySelectorAll('[data-compare="'+id+'"]').forEach(button => {
    const on = compare.has(id);
    button.classList.toggle('selected',on); button.setAttribute('aria-pressed',String(on));
    button.setAttribute('aria-label',(on?'移出对比':'加入对比')+' '+byId.get(id).title);
  });
}
function buildCategories() {
  const entries = [{name:'',label:'全部造型',count:indexedLooks.length},...categories.map(name => ({name,label:name,count:indexedLooks.filter(l=>l.category===name).length}))];
  $('category-list').innerHTML = entries.map(c=>'<button class="category-button'+(!c.name?' active':'')+'" data-category="'+esc(c.name)+'" aria-pressed="'+!c.name+'"><span>'+esc(c.label)+'</span><span class="cat-count">'+String(c.count).padStart(2,'0')+'</span></button>').join('');

}
function matchesSearch(look,query) {
  const words=String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length)return true;
  const terms=[number(look.id),String(look.id),look.title,look.category,look.season,look.description,look.region,modelName(look.model_id),...(look.tags||[]),...(look.pieces||[]).map(piece=>piece.name),...(look.details||[]),versionOf(look).story,versionOf(look).summary,...(versionOf(look).moods||[]),...(versionOf(look).shots||[]).flatMap(shot=>[shot.title,shot.emotion,shot.pose])].join(' ').toLocaleLowerCase();
  return words.every(word=>terms.includes(word));
}
function matchLooks() {
  const latest=state.latestOnly?latestBatch():'',latestRank=new Map(latestLooks().map((look,index)=>[look.id,index]));
  const batchIds=state.batch?new Set(publications.get(state.batch)?.lookIds):null;
  filtered = indexedLooks.filter(l => {
    if (state.category && l.category !== state.category) return false;
    if (state.season && l.season !== state.season) return false;
    if (state.model && l.model_id !== state.model) return false;
    if (state.region && l.region !== state.region) return false;
    if (state.piece && !pieceMatch.matchingPieces(l,state.piece).length) return false;
    if (state.colors.length && !colorMatch.matchPalette(l.palette,state.colors)) return false;
    if (batchIds && !batchIds.has(l.id)) return false;
    if (state.latestOnly && l.batch_id !== latest) return false;
    if ((state.page==='favorites'||state.favoritesOnly) && !favorites.has(l.id)) return false;
    return matchesSearch(l,state.query);
  }).sort((a,b) => versionOf(a).ready!==versionOf(b).ready ? Number(versionOf(b).ready)-Number(versionOf(a).ready) : state.sort==='latest' ? latestRank.get(a.id)-latestRank.get(b.id) : state.sort==='curated' ? (a.editorialOrder??a.id)-(b.editorialOrder??b.id) : state.sort==='pieces' ? b.pieces.length-a.pieces.length || a.id-b.id : state.sort==='favorites' ? Number(favorites.has(b.id))-Number(favorites.has(a.id)) || a.id-b.id : a.id-b.id);
}
function refreshFilters() {
  state.limit=24;
  $('model-filter').value=state.model;$('region-filter').value=state.region;$('latest-only').checked=state.latestOnly;
  $('piece-filter').value=state.piece;
  $('piece-filter-wrap').hidden=state.page!=='looks'||!pieceTypes.size;
  const [firstColor='',secondColor='']=state.colors;
  syncColorOption($('color-filter-first'),firstColor,secondColor);
  syncColorOption($('color-filter-second'),secondColor,firstColor);
  $('color-filter-wrap').hidden=state.page!=='looks'||!colorTypes.size;
  document.querySelectorAll('input[name="season"]').forEach(input=>{input.checked=input.value===state.season;}); $('search').value=state.query; $('favorites-only').checked=state.page==='favorites'||state.favoritesOnly; $('favorites-only').disabled=state.page==='favorites'; $('sort').value=state.sort;
  document.querySelectorAll('[data-category]').forEach(b=>{const active=b.dataset.category===state.category;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  renderGallery(); renderActiveFilters();syncArchiveURL();
}
function resetFilters() { Object.assign(state,{category:'',season:'',query:'',model:'',region:'',piece:'',colors:[],batch:'',latestOnly:false,favoritesOnly:false,sort:'latest'});refreshFilters(); }
function renderActiveFilters() {
  const entries=[];
  if(state.category)entries.push(['category',state.category]);
  if(state.season)entries.push(['season',state.season]);
  if(state.model)entries.push(['model',modelName(state.model)]);
  if(state.region)entries.push(['region',state.region]);
  if(state.piece)entries.push(['piece','手头单品 '+pieceTypes.get(state.piece)]);
  for(const id of state.colors)entries.push(['color:'+id,'色系 '+colorTypes.get(id)]);
  if(state.batch)entries.push(['batch',publications.get(state.batch)?.date||'历史穿搭']);
  if(state.latestOnly)entries.push(['latestOnly','最新批次']);
  if(state.query)entries.push(['query','“'+state.query+'”']);
  if(state.favoritesOnly&&state.page!=='favorites')entries.push(['favoritesOnly','我的收藏']);
  $('filter-count').textContent=entries.length?'('+entries.length+')':'';
  $('active-filters').innerHTML=entries.map(([key,label])=>'<button class="filter-pill" data-clear="'+key+'" aria-label="清除'+esc(label)+'筛选">'+esc(label)+' <span aria-hidden="true">×</span></button>').join('');
}
function sceneRoute(id) { return '#/looks?'+new URLSearchParams({scene:id}); }
function renderPublications(){
  $('publication-batches').innerHTML=[...publications.values()].map(({id,date,title,lookIds})=>{
    const dateLabel=date?'<time datetime="'+esc(date)+'">'+esc(date)+'</time>':'<span>未登记日期</span>';
    const href='#/looks?'+new URLSearchParams({batch:id});
    return '<li><a class="publication-entry" href="'+esc(href)+'">'+dateLabel+'<strong>'+esc(title)+'</strong><span>'+lookIds.length+' 套 ↗</span></a></li>';
  }).join('');
  $('publication-empty').hidden=[...publications.keys()].some(id=>id!=='undated');
}
async function renderRecent(){
  const request=++recentRender;
  try{
    const entries=await recentStore.load();
    if(request!==recentRender||state.page!=='recent')return;
    const focusedHref=recentFocusLook===null
      ? document.activeElement?.closest('#recent-items a')?.getAttribute('href')
      : '#look-'+recentFocusLook;
    const available=entries.flatMap(({type,id})=>{
      const item=publicWardrobeEntry(type,id);
      return item?[{...item,type}]:[];
    });
    $('recent-items').innerHTML=available.map(({title,href,type})=>'<li><a class="recent-entry" href="'+esc(href)+'"><span>'+(type==='look'?'穿搭':'单品')+'</span><strong>'+esc(title)+'</strong><span aria-hidden="true">↗</span></a></li>').join('');
    $('recent-page-status').textContent=available.length?'':'还没有可以打开的浏览记录。';
    $('recent-clear').hidden=!entries.length;
    if(focusedHref){
      const link=[...$('recent-items').querySelectorAll('a')].find(item=>item.getAttribute('href')===focusedHref);
      (link||$('recent-page-title')).focus({preventScroll:true});
      recentFocusLook=null;
    }
  }catch(error){
    if(request!==recentRender||state.page!=='recent')return;
    const restoreHeading=recentFocusLook!==null||$('recent-items').contains(document.activeElement);
    $('recent-items').innerHTML='';
    if(restoreHeading)$('recent-page-title').focus({preventScroll:true});
    recentFocusLook=null;
    $('recent-page-status').textContent=error?.message||'此浏览器无法读取浏览记录。';
    $('recent-clear').hidden=false;
  }
}
function rememberView(type,id){
  if(recentStore&&publicWardrobeEntry(type,id))recentStore.remember(type,id).catch(()=>{});
}
function sceneLook(id) {
  const look=byId.get(id);
  return look&&!look.model_only&&versionOf(look).ready ? look : null;
}
function availableScene(id) {
  const scene=scenes.get(id);
  return scene?.entries.some(entry=>sceneLook(entry.lookId)) ? scene : null;
}
function renderSceneControls() {
  const scene=scenes.get(state.scene);
  $('scene-navigation').hidden=state.page!=='looks'||![...scenes.keys()].some(availableScene);
  document.querySelectorAll('#scene-links [data-scene]').forEach(link=>{
    link.hidden=!availableScene(link.dataset.scene);
    if(link.dataset.scene===state.scene)link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  $('scene-summary').hidden=!scene;
  $('scene-description').textContent=scene?.description||'';
  $('completion-note').hidden=!!scene;
  $('open-filters').hidden=!!scene;
  $('filter-dialog').hidden=!!scene;
  $('archive-toolbar').hidden=!!scene;
  $('collection-title').innerHTML=esc(scene?.title||(state.page==='favorites'?'我的收藏':'全部穿搭'))+'<span class="heading-period">.</span>';
}
function renderCard(l,index,{tip,matchingPieces=[],matchingColors}={}) {
  const liked=favorites.has(l.id), picked=compare.has(l.id);
  const compareAction=l.model_only?'':'<button class="icon-button compare'+(picked?' selected':'')+'" data-compare="'+l.id+'" aria-pressed="'+picked+'" aria-label="'+(picked?'移出对比':'加入对比')+' '+esc(l.title)+'">'+comparison+'</button>';
  const match=matchingPieces.length?'<p class="card-piece-match">匹配单品 · '+matchingPieces.map(esc).join('、')+'</p>':'';
  const colors=matchingColors?.map(({id,colors})=>{
    const label=esc(colorTypes.get(id));
    const chips=colors.map(hex=>'<span class="card-color-chip" style="--matched-color:'+esc(hex)+'" role="img" aria-label="'+label+' '+esc(hex)+'" title="'+esc(hex)+'"></span>').join('');
    return '<span class="card-color-group" data-color-match="'+esc(id)+'">'+label+chips+'</span>';
  }).join('');
  const paletteEvidence=colors?'<div class="card-color-evidence" aria-label="色板匹配">'+colors+'</div>':'';
  const notes=tip?'<p class="scene-tip">'+esc(tip)+'</p>'
    :match+paletteEvidence+'<p class="card-publication">'+esc(publication(l))+'</p><p class="card-tags">'+(versionOf(l).moods||l.tags||[]).slice(0,4).map(esc).join(' · ')+'</p>';
  return '<article class="look-card" style="animation-delay:'+Math.min(index,8)*25+'ms" data-look-card="'+l.id+'"><div class="image-zone"><button class="look-photo-button" data-open="'+l.id+'" aria-label="查看 '+esc(l.title)+' 的九宫格写真和搭配设计">'+(versionOf(l).ready?photo(l):'<div class="card-pending"><span>'+number(l.id)+'</span><small>写真准备中</small></div>')+'<span class="card-number">'+number(l.id)+'</span>'+'<span class="open-caption">查看写真与设计 <span>↗</span></span></button><div class="card-actions"><button class="icon-button favorite'+(liked?' selected':'')+'" data-favorite="'+l.id+'" aria-pressed="'+liked+'" aria-label="'+(liked?'取消收藏':'收藏')+' '+esc(l.title)+'">'+heart+'</button>'+compareAction+'</div></div><div class="card-meta"><div class="card-topline"><span>'+esc(l.category)+' / '+esc(l.season)+' · '+l.pieces.length+' 件搭配</span><div class="palette" aria-label="造型配色">'+palette(l)+'</div></div><button class="card-title" data-open="'+l.id+'">'+esc(l.title)+'</button>'+notes+'</div></article>';
}
function renderGallery() {
  const scene=scenes.get(state.scene);
  const tips=scene?new Map(scene.entries.map(entry=>[entry.lookId,entry.tip])):null;
  if(scene)filtered=scene.entries.map(entry=>sceneLook(entry.lookId)).filter(Boolean);
  else matchLooks();
  $('gallery').innerHTML=filtered.slice(0,state.limit).map((look,index)=>renderCard(look,index,{
    tip:tips?.get(look.id),matchingPieces:state.piece?pieceMatch.matchingPieces(look,state.piece):[],
    matchingColors:state.colors.length?colorMatch.matchPalette(look.palette,state.colors):null,
  })).join('');
  $('result-count').textContent=filtered.length+' 套造型';
  $('scene-result-count').textContent=scene?filtered.length+' 套穿搭':'';
  $('empty-state').hidden=filtered.length!==0;
  $('load-more').hidden=filtered.length<=state.limit;
  $('gallery-end').hidden=!!scene;
  $('gallery-end').textContent=filtered.length && filtered.length<=state.limit ? '— END OF THIS SELECTION —' : filtered.length ? '已展示 '+Math.min(state.limit,filtered.length)+' / '+filtered.length+' 套' : '';
}
function delegatedActions(event) {
  const favorite=event.target.closest('[data-favorite]'); if(favorite){toggleFavorite(Number(favorite.dataset.favorite),favorite);return;}
  const compareButton=event.target.closest('[data-compare]');if(compareButton){toggleCompare(Number(compareButton.dataset.compare));return;}
  const opener=event.target.closest('[data-open]');if(opener)openDetail(Number(opener.dataset.open));
}
$('gallery').addEventListener('click',delegatedActions);
$('home-page').addEventListener('click',delegatedActions);
$('model-looks-gallery').addEventListener('click',delegatedActions);
$('category-list').addEventListener('click',event=>{const button=event.target.closest('[data-category]');if(button){state.category=button.dataset.category;refreshFilters();}});
$('model-filter').addEventListener('change',e=>{state.model=e.target.value;refreshFilters();});
$('region-filter').addEventListener('change',e=>{state.region=e.target.value;refreshFilters();});
$('piece-filter').addEventListener('change',e=>{state.piece=pieceTypes.has(e.target.value)?e.target.value:'';refreshFilters();});
function syncColorOption(input,selected,other){
  input.value=selected;
  for(const option of input.options||[])option.disabled=Boolean(other)&&option.value===other;
}
function selectedColors(values){
  return [...new Set(values.filter(value=>colorTypes.has(value)))].slice(0,2);
}
function updateColorFilters(){
  state.colors=selectedColors([$('color-filter-first').value,$('color-filter-second').value]);
  refreshFilters();
}
$('color-filter-first').addEventListener('change',updateColorFilters);
$('color-filter-second').addEventListener('change',updateColorFilters);
$('latest-only').addEventListener('change',e=>{state.latestOnly=e.target.checked;refreshFilters();});
$('active-filters').addEventListener('click',e=>{
 const key=e.target.closest('[data-clear]')?.dataset.clear;
 if(!key)return;
 if(key.startsWith('color:'))state.colors=state.colors.filter(id=>id!==key.slice('color:'.length));
 else state[key]=['favoritesOnly','latestOnly'].includes(key)?false:'';
 refreshFilters();
 if(key==='piece')$('piece-filter').focus();
 if(key.startsWith('color:'))$('color-filter-first').focus();
 if(key==='batch')document.querySelector('#publication-entry-link a')?.focus();
});
$('season').addEventListener('change',e=>{if(e.target.name!=='season')return;state.season=e.target.value;refreshFilters();});
$('search').addEventListener('input',e=>{state.query=e.target.value;state.limit=24;renderGallery();renderActiveFilters();syncArchiveURL();});
$('favorites-only').addEventListener('change',e=>{state.favoritesOnly=e.target.checked;refreshFilters();});
$('sort').addEventListener('change',e=>{state.sort=e.target.value;refreshFilters();});
$('reset-filters').addEventListener('click',resetFilters);$('empty-reset').addEventListener('click',resetFilters);
$('load-more').addEventListener('click',()=>{const previous=state.limit;state.limit+=24;renderGallery();document.querySelector('[data-look-card="'+filtered[previous]?.id+'"] .look-photo-button')?.focus({preventScroll:true});});
const detailHashPattern=/^#look-(\d+)(?:\?(.*))?$/;
const onlineDocument=()=>location.protocol==='http:'||location.protocol==='https:';
let shareAttempt=0, viewedShareAsset='';
function shareAsset(look) {
  if(!look||look.model_only)return '';
  const version=versionOf(look),asset=version.asset;
  return version.ready&&asset?.visibility==='public'&&typeof asset.asset_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(asset.asset_id) ? asset.asset_id : '';
}
function lookRoute(look,view=0) {
  const hash='#look-'+look.id,asset=view>0?shareAsset(look):'';
  return asset ? hash+'?'+new URLSearchParams({shot:String(view),photo:asset}) : hash;
}
function linkedShot(look,query) {
  const params=new URLSearchParams(query),shot=params.get('shot'),asset=shareAsset(look);
  return asset&&params.size===2&&/^[1-9]$/.test(shot)&&params.get('photo')===asset ? Number(shot) : 0;
}
function detailList() { return detailNavigation ? detailNavigation.map(id=>byId.get(id)).filter(Boolean) : latestLooks(); }
function setView(view,preserveShareFeedback=false) {
  const look=byId.get(state.active),asset=shareAsset(look);
  const keepFeedback=preserveShareFeedback&&view===state.view&&asset===viewedShareAsset;
  state.view=view;
  viewedShareAsset=asset;
  const frame=$('detail-photo-frame'),image=$('detail-image');
  frame.classList.toggle('single-view',view>0);
  if(view>0){image.style.left=-(view-1)%3*100+'%';image.style.top=-Math.floor((view-1)/3)*100+'%';}else{image.style.left='';image.style.top='';}
  document.querySelectorAll('[data-view]').forEach(b=>{const active=Number(b.dataset.view)===view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const current=versionOf(byId.get(state.active));const names=['完整九宫格',...current.shots.map(s=>s.title)];
  $('view-name').textContent=names[view]||'写真';const shot=current.shots[view-1];$('view-moment').textContent=shot?[shot.emotion,shot.pose,shot.framing].filter(Boolean).join(' · '):current.summary;
  image.alt=look.title+' · '+names[view];
  $('share-shot').hidden=!view||!asset;
  if(keepFeedback)return;
  shareAttempt++;
  $('share-shot').textContent=onlineDocument()?'复制单格链接':'复制单格链接片段';
  $('share-shot-status').textContent='';
  $('share-shot-manual').hidden=true;
  $('share-shot-link').value='';
}
async function shareShot() {
  const look=byId.get(state.active),view=state.view;
  if(!view||!shareAsset(look))return;
  const attempt=++shareAttempt;
  const hash=lookRoute(look,view),online=onlineDocument();
  const url=online?new URL(location.href):null;
  if(url){url.search='';url.username='';url.password='';url.hash=hash;}
  const text=url?.href||hash;
  let copied=false;
  try{await navigator.clipboard.writeText(text);copied=true;}catch{}
  if(attempt!==shareAttempt||!$('detail-dialog').open)return;
  const status=$('share-shot-status'),manual=$('share-shot-manual'),field=$('share-shot-link');
  manual.hidden=copied;
  if(copied){status.textContent=online?'已复制单格链接。':'已复制链接片段，可粘贴到衣序页面地址末尾。';return;}
  status.textContent=online?'请选择下方链接手动复制。':'可手动复制下方片段，再粘贴到衣序页面地址末尾。';
  field.value=text;
  field.focus();
  field.select();
}
function revisionPair(look) {
  if(!look)return null;
  const previous=look.previous_photo,current=versionOf(look);
  const previousSource=publicSource(previous?.source_url||previous?.image);
  const currentSource=publicSource(current?.source_url||current?.image);
  if(!current?.ready||!previous?.asset?.asset_id||!current.asset?.asset_id||previous.asset.asset_id===current.asset.asset_id||!previousSource||!currentSource||previousSource===currentSource)return null;
  return [[previous,previousSource],[current,currentSource]];
}
function renderLookRevision(look,pair) {
  $('look-revision-title').textContent=look.title+' · 写真版本对比';
  const render=(side,[version,source])=>{
    const image=$(side+'-look-image');
    image.alt=side==='previous'?'上一版九宫格':'当前九宫格';
    setImage(image,version);
    $(side+'-look-source').href=source;
  };
  render('previous',pair[0]);
  render('current',pair[1]);
}
const revisionDialog=$('look-revision-dialog');
function closeLookRevision(){
  if(revisionDialog.open)revisionDialog.close();
}
$('detail-revision').addEventListener('click',()=>{
  const look=byId.get(state.active),pair=revisionPair(look);
  if(!pair||revisionDialog.open)return;
  renderLookRevision(look,pair);
  revisionDialog.showModal();
});
$('close-look-revision').addEventListener('click',closeLookRevision);
revisionDialog.addEventListener('close',()=>{
  if(!revisionDialog.open&&$('detail-dialog').open&&!$('detail-revision').hidden)$('detail-revision').focus({preventScroll:true});
});
function updateDetailActions() {
  const l=byId.get(state.active);if(!l)return;
  const f=favorites.has(l.id),c=compare.has(l.id);
  $('detail-favorite').textContent=f?'♥ 已收藏':'♡ 收藏这套';
  $('detail-favorite').setAttribute('aria-pressed',String(f));
  $('detail-compare').hidden=!!l.model_only;
  $('detail-list-add').hidden=!!l.model_only;
  $('detail-compare').textContent=c?'− 移出对比':'+ 加入对比';
  $('detail-compare').setAttribute('aria-pressed',String(c));
}
function openDetail(id,preserveNavigation=false,{view=0,routed=false,hydrating=false,openerId=''}={}) {
  const l=byId.get(id);if(!l)return;
  const alreadyOpen=$('detail-dialog').open,detailRoute=detailHashPattern.test(location.hash);
  const newView=!alreadyOpen||state.active!==id;
  const preserveView=hydrating&&alreadyOpen&&state.active===id&&state.view===view;
  const revisions=revisionPair(l);
  $('detail-revision').hidden=!revisions;
  if(revisionDialog.open){
    if(newView||!revisions)closeLookRevision();
    else if(hydrating)renderLookRevision(l,revisions);
  }
  const restored=!alreadyOpen&&detailRoute?history.state?.wardrobeDetail:null;
  if(restored&&typeof restored.returnRoute==='string'&&/^#\/(home|looks|models|favorites|products|product|lists|publications|recent|week|packing|backup)(?:[/?]|$)/.test(restored.returnRoute))detailReturnRoute=restored.returnRoute;
  else if(!alreadyOpen)detailReturnRoute=detailRoute?(l.model_only?modelRoute(l.model_id):'#/home'):location.hash||'#/home';
  if(!alreadyOpen)detailSceneOpener=restored?.sceneOpener??(!detailRoute&&state.scene?id:null);
  if(!alreadyOpen)detailProductFocus=restored?.productFocusId||openerId;
  if(!alreadyOpen){
    const fromFilteredArchive=state.page==='looks'&&(state.piece||state.colors.length||state.batch);
    detailArchiveOpener=restored?.archiveOpener??(!detailRoute&&(fromFilteredArchive||state.page==='recent')?id:null);
  }
  if(restored&&Array.isArray(restored.navigation)&&restored.navigation.includes(id))detailNavigation=restored.navigation.filter(key=>byId.has(key));
  else if(!preserveNavigation||!detailNavigation?.includes(id)){
    const profile=l.model_only?l.model_id:state.profileModel;
    const selection=profile&&l.model_id===profile?modelLooks(profile)
      :(['looks','favorites'].includes(state.page)&&filtered.some(look=>look.id===id)?filtered:latestLooks());
    detailNavigation=selection.map(look=>look.id);
  }
  const entry={...history.state,wardrobeDetail:{returnRoute:detailReturnRoute,navigation:detailNavigation,sceneOpener:detailSceneOpener,archiveOpener:detailArchiveOpener,productFocusId:detailProductFocus}};
  const hash=lookRoute(l,view);
  // Treat the scene's detail carousel as a single visit so Back can return to the list.
  if(routed||location.hash===hash||(alreadyOpen&&detailSceneOpener!==null))history.replaceState(entry,'',hash);
  else history.pushState(entry,'',hash);
  state.active=id;
  $('detail-number').textContent='LOOK '+number(id)+' / '+l.category+' / '+l.season;
  $('detail-title').textContent=l.title;$('detail-story-title').textContent=versionOf(l).story;$('detail-story-summary').textContent=versionOf(l).summary;
  $('detail-palette').innerHTML=palette(l);
  $('detail-description').textContent=l.description;
  $('detail-tags').innerHTML=(l.tags||[]).map(tag=>{
    if(typeof tag!=='string'||!tag.trim()||!indexedLooks.some(other=>other.id!==id&&matchesSearch(other,tag)))return '<span>'+esc(tag)+'</span>';
    const href='#/looks?'+new URLSearchParams({q:tag});
    return '<a href="'+esc(href)+'" data-explore-tag aria-label="搜索标签 '+esc(tag)+'">'+esc(tag)+' <span aria-hidden="true">↗</span></a>';
  }).join('')+(versionOf(l).moods||[]).map(mood=>'<span>'+esc(mood)+'</span>').join('');
  const ownedPiece=detailReturnRoute.startsWith('#/looks?')?new URLSearchParams(detailReturnRoute.split('?')[1]).get('piece'):'';
  $('detail-pieces').innerHTML=l.pieces.map((p,i)=>{
    const matches=!l.model_only&&ownedPiece&&pieceMatch?.matchingPieceName(p,ownedPiece);
    const label=matches?'<span class="detail-piece-match">匹配单品</span>':'';
    return '<li><span class="piece-number">'+String(i+1).padStart(2,'0')+'</span><span class="piece-role">'+esc(p.role)+'</span><span>'+esc(p.name)+label+'</span></li>';
  }).join('');
  renderLookProducts(id);
  $('detail-design').innerHTML=l.details.map(d=>'<li>'+esc(d)+'</li>').join('');
  $('detail-scene').textContent='写真场景 / '+l.scene;
  $('detail-image').hidden=!versionOf(l).ready;$('detail-photo-frame').classList.toggle('pending',!versionOf(l).ready);
  if(versionOf(l).ready)setImage($('detail-image'),versionOf(l));else $('detail-image').removeAttribute('src');
  $('original-link').href=imageURL(versionOf(l));$('download-link').href=publicSource(versionOf(l).download_url,true)||publicSource(versionOf(l).source_url||versionOf(l).image);$('download-link').download='LOOK-'+number(id)+'-v2-'+l.title+'.webp';
  $('original-link').hidden=!versionOf(l).ready;$('download-link').hidden=!versionOf(l).ready;
  $('view-selector').innerHTML=[0,1,2,3,4,5,6,7,8,9].map(v=>'<button data-view="'+v+'" aria-label="'+esc(v?String(v).padStart(2,'0')+' · '+(versionOf(l).shots[v-1]?.title||'写真'+v):'完整九宫格')+'" aria-pressed="'+!v+'">'+(v?'<span class="shot-number">'+String(v).padStart(2,'0')+'</span><span class="shot-title">'+esc(versionOf(l).shots[v-1]?.title||'写真'+v)+'</span>':'九宫格')+'</button>').join('');
  $('view-selector').hidden=!versionOf(l).ready;setView(view,preserveView);updateDetailActions();
  window.WardrobeTryOn?.setContext?.({look_id:id,edition:'v2'});
  window.WardrobeTryOn?.track?.('look_open',{look_id:id,edition:'v2'});
  const list=detailList(),position=list.findIndex(x=>x.id===id);
  $('detail-position').textContent=(position+1)+' / '+list.length;
  $('previous-look').disabled=position<=0;$('next-look').disabled=position>=list.length-1;
  if(!$('detail-dialog').open)$('detail-dialog').showModal();
  if(!preserveView)$('detail-dialog').scrollTop=0;
  if(newView)rememberView('look',id);
}
$('view-selector').addEventListener('click',e=>{
  const button=e.target.closest('[data-view]');if(!button)return;
  setView(Number(button.dataset.view));
  const hash=lookRoute(byId.get(state.active),state.view);
  if(location.hash!==hash)history.replaceState(history.state,'',hash);
});
$('share-shot').addEventListener('click',shareShot);
$('detail-tags').addEventListener('click',event=>{if(event.target.closest('[data-explore-tag]')&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)focusArchive=true;});
$('close-detail').addEventListener('click',()=>$('detail-dialog').close());
$('detail-favorite').addEventListener('click',event=>toggleFavorite(state.active,event.currentTarget));
$('detail-list-add').addEventListener('click',event=>wardrobeListPage?.choose('look',state.active,event.currentTarget));
$('detail-compare').addEventListener('click',()=>toggleCompare(state.active));
function navigateLook(direction) {
  const list=detailList(),index=list.findIndex(l=>l.id===state.active);
  if(index+direction>=0 && index+direction<list.length)openDetail(list[index+direction].id,true);
}
$('previous-look').addEventListener('click',()=>navigateLook(-1));$('next-look').addEventListener('click',()=>navigateLook(1));
function renderCompareTray() {
  $('compare-tray').hidden=!compare.size;
  $('compare-count').textContent=compare.size+' / 3 套';
  $('open-compare').disabled=compare.size<2;
  $('compare-items').innerHTML=[...compare].map(id=>{const l=byId.get(id);return '<div class="compare-item">'+(versionOf(l).ready?photo(l):'<span>'+number(id)+'</span>')+'<span>'+esc(l.title)+'</span><button data-remove-compare="'+id+'" aria-label="从对比移除'+esc(l.title)+'">×</button></div>';}).join('');
}
$('compare-items').addEventListener('click',e=>{const b=e.target.closest('[data-remove-compare]');if(b)toggleCompare(Number(b.dataset.removeCompare));});
$('clear-compare').addEventListener('click',()=>{const ids=[...compare];compare.clear();ids.forEach(syncCardButtons);renderCompareTray();updateDetailActions();});
function renderComparison() {
  const content=$('comparison-content');
  $('compare-full-body').setAttribute('aria-pressed',String(compareFullBody));
  content.style.setProperty('--compare-cols',String(compare.size));
  content.innerHTML=[...compare].map(id=>{
    const look=byId.get(id),version=versionOf(look);
    const shot=compareFullBody&&version.ready?window.WardrobeFraming?.fullBodyShot(version.shots):null;
    const shown=shot?{...look,versions:{v2:{...version,previewPanel:shot}}}:look;
    const picture=version.ready?photo(shown):'<div class="card-pending"><span>'+number(id)+'</span><small>写真制作中</small></div>';
    const caption=compareFullBody?'<p class="comparison-framing">'+(shot?'全身 · 第 '+shot+' 镜头':'暂无已确认的全身镜头')+'</p>':'';
    const action=shot?'查看全身镜头':'查看九宫格写真';
    return '<article class="comparison-card" data-compared-look="'+id+'">'+picture+caption+'<h3>'+esc(look.title)+'</h3><p class="eyebrow">LOOK '+number(id)+' · '+esc(look.category)+'</p><div class="palette">'+palette(look)+'</div><p>'+esc(look.description)+'</p><h4>搭配单品 / '+look.pieces.length+' 件</h4><ul>'+look.pieces.map(piece=>'<li>'+esc(piece.name)+'</li>').join('')+'</ul><h4>设计思路</h4><ul>'+look.details.map(detail=>'<li>'+esc(detail)+'</li>').join('')+'</ul><button class="solid-button" data-compare-detail="'+id+'" data-compare-shot="'+(shot||0)+'">'+action+' ↗</button></article>';
  }).join('');
}
function openComparison() {
  if(compare.size<2)return;
  if(!$('compare-dialog').open)compareFullBody=false;
  renderComparison();
  if(!$('compare-dialog').open)$('compare-dialog').showModal();
}
$('open-compare').addEventListener('click',openComparison);$('close-compare').addEventListener('click',()=>$('compare-dialog').close());
$('compare-full-body').addEventListener('click',()=>{
  compareFullBody=!compareFullBody;
  renderComparison();
});
$('comparison-content').addEventListener('click',e=>{
  const button=e.target.closest('[data-compare-detail]');
  if(!button)return;
  $('compare-dialog').close();
  openDetail(Number(button.dataset.compareDetail),false,{view:Number(button.dataset.compareShot)||0});
});
$('about-button').addEventListener('click',()=>$('about-dialog').showModal());$('close-about').addEventListener('click',()=>$('about-dialog').close());
$('about-to-gallery').addEventListener('click',()=>{$('about-dialog').close();location.hash='#/looks';});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
document.addEventListener('keydown',e=>{
  const editable=e.target.matches('input,textarea,select,[contenteditable]');
  if(e.key==='/'&&!editable&&!document.querySelector('dialog[open]')){e.preventDefault();if(state.scene||!['looks','favorites'].includes(state.page)){history.pushState(null,'','#/looks');routeFromURL(false);}$('search').focus();$('search').scrollIntoView({block:'center',behavior:'smooth'});}
  if($('detail-dialog').open&&!revisionDialog.open&&!$('tryon-dialog')?.open&&!$('compare-dialog').open&&!$('wardrobe-list-picker').open&&!editable&&!e.target.closest('#view-selector, #detail-tags a')){if(e.key==='ArrowRight'){e.preventDefault();navigateLook(1);}if(e.key==='ArrowLeft'){e.preventDefault();navigateLook(-1);}}
});
window.addEventListener('storage',e=>{
 const kind=e.key===storageKey?'look':e.key===productStorageKey?'product':'';
 if(favoriteStore&&kind){refreshStoredFavorites(kind);return;}
 if(e.key===productStorageKey){try{const values=JSON.parse(e.newValue||'[]');if(!Array.isArray(values))return;productFavorites.clear();values.filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id)).forEach(id=>productFavorites.add(id));renderHomeProducts();if(state.page==='products')renderProducts();if(state.page==='product'){const id=/^#\/product\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(location.hash)?.[1];if(id)renderProduct(id);}if(state.active)renderLookProducts(state.active);}catch{}return;}if(e.key!==storageKey)return;try{const values=JSON.parse(e.newValue||'[]');if(!Array.isArray(values))return;favorites.clear();values.filter(id=>Number.isSafeInteger(id)&&id>0).forEach(id=>favorites.add(id));updateCounts();renderGallery();updateEditionUI();if(state.profileModel)renderModelProfile(state.profileModel);if(state.active)updateDetailActions();}catch{}});
function archiveRoute(){
 if(state.scene)return sceneRoute(state.scene);
 const params=new URLSearchParams();
 for(const [key,value] of [['category',state.category],['season',state.season],['q',state.query],['model',state.model],['region',state.region],['piece',state.piece],['batch',state.batch],['latest',state.latestOnly?'1':''],['saved',state.favoritesOnly&&state.page!=='favorites'?'1':''],['sort',state.sort==='latest'?'':state.sort]])if(value)params.set(key,value);
 for(const color of state.colors)params.append('color',color);
 return '#/'+state.page+(params.size?'?'+params:'');
}
function syncArchiveURL(){if(!routing&&['looks','favorites'].includes(state.page)&&!$('detail-dialog').open)history.replaceState(null,'',archiveRoute());}
function routeFromURL(scroll=true,hash=location.hash,{hydrating=false}={}){
 const detail=detailHashPattern.exec(hash);
 if(detail){
  const id=Number(detail[1]),look=byId.get(id),alreadyOpen=$('detail-dialog').open;
  if(hydrating&&!alreadyOpen&&state.active===id)return;
  if(look){
   const restored=history.state?.wardrobeDetail;
   const sceneId=/^#\/looks\?scene=([a-z0-9-]+)$/.exec(restored?.returnRoute)?.[1];
   if(!alreadyOpen&&restored?.sceneOpener&&sceneId!==state.scene&&availableScene(sceneId))routeFromURL(false,restored.returnRoute);
   const unlinked=hydrating&&alreadyOpen&&state.active===id&&detail[2]===undefined&&!shareAsset(look);
   const view=unlinked?state.view:linkedShot(look,detail[2]);
   openDetail(id,alreadyOpen,{view,routed:true,hydrating});
   return;
  }
  notify('这套穿搭暂未发布');
 }
 const productRoute=/^#\/product\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(hash);
 const profile=/^#\/models\/([A-Za-z0-9_-]+)$/.exec(hash);
 const route=/^#\/(home|looks|models|favorites|products|lists|publications|recent|week|packing|backup)(?:\?(.*))?$/.exec(hash),page=productRoute?'product':profile?'models':route?.[1]||'home';
 const productId=productRoute?.[1]||'';
 const newProduct=productId&&state.productId!==productId;
 const params=new URLSearchParams(route?.[2]||'');
 const scene=page==='looks'?availableScene(params.get('scene')):null;
 const sceneFocus=scene&&detailReturnRoute===hash?detailSceneOpener:null,leavingScene=state.scene&&!scene;
 const archiveFocus=page==='looks'&&detailReturnRoute===hash?detailArchiveOpener:null;
 const productFocus=page==='product'&&detailReturnRoute===hash?detailProductFocus:'';
 recentFocusLook=page==='recent'&&detailReturnRoute===hash?detailArchiveOpener:null;
 const openingPublications=page==='publications'&&state.page!==page;
 const openingRecent=page==='recent'&&state.page!==page;
 const openingWeek=page==='week'&&state.page!==page;
 const openingPacking=page==='packing'&&state.page!==page;
 const openingBackup=page==='backup'&&state.page!==page;
 routing=true;
 state.page=page;state.profileModel=profile?.[1]||'';state.scene=scene?.id||'';state.productId=productId;
 // Native dialog close events are queued. A route-driven close must not later
 // overwrite a detail URL restored by Back before that close event arrives.
 if($('detail-dialog').open){routeDetailCloses++;$('detail-dialog').close();}state.active=null;detailNavigation=null;detailSceneOpener=null;detailArchiveOpener=null;
 detailProductFocus='';
 $('home-page').hidden=page!=='home';$('models-page').hidden=page!=='models';$('collection').hidden=!['looks','favorites'].includes(page);$('closing-note').hidden=page!=='home';
 $('products-page').hidden=page!=='products';$('product-page').hidden=page!=='product';
 $('wardrobe-list-page').hidden=page!=='lists';$('wardrobe-list-entry-link').hidden=page!=='favorites';
 $('publication-page').hidden=page!=='publications';$('publication-entry-link').hidden=page!=='looks';
 $('recent-page').hidden=page!=='recent';
 $('week-page').hidden=page!=='week';
 $('packing-page').hidden=page!=='packing';
 $('backup-page').hidden=page!=='backup';
 if(page==='lists')wardrobeListPage?.render();
 if(page==='publications')renderPublications();
 if(page==='recent')renderRecent();
 if(page==='week'&&wardrobeWeekPage){
  const requestedDate=params.get('date'),date=requestedDate||window.WardrobeWeekPlan.todayKey();
  if(!requestedDate&&hash===location.hash)history.replaceState(history.state,'','#/week?'+new URLSearchParams({date}));
  wardrobeWeekPage.render(date);
 }
 if(page==='packing')wardrobePackingPage?.render();
 if(page==='models')renderModelProfile(state.profileModel);
 if(page==='products')renderProducts();
 if(page==='product'){
  renderProduct(productId);
  if(newProduct)rememberView('product',productId);
 }
 renderSceneControls();
 document.querySelectorAll('[data-page]').forEach(link=>{if(link.dataset.page===page||(page==='product'&&link.dataset.page==='products'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
 if(['looks','favorites'].includes(page)){
  const filters=scene?new URLSearchParams():params;
  const piece=filters.get('piece');
  const colors=page==='looks'?selectedColors(filters.getAll('color')):[];
  const requestedBatch=page==='looks'?filters.get('batch'):null;
  const batch=publications.has(requestedBatch)?requestedBatch:'';
  if(requestedBatch&&!batch)notify('这一批次暂不可用，已返回穿搭档案。');
  Object.assign(state,{category:filters.get('category')||'',season:filters.get('season')||'',query:filters.get('q')||'',model:filters.get('model')||'',region:filters.get('region')||'',piece:page==='looks'&&pieceTypes.has(piece)?piece:'',colors,batch,latestOnly:filters.get('latest')==='1',favoritesOnly:page==='favorites'||filters.get('saved')==='1',sort:['latest','curated','id','pieces','favorites'].includes(filters.get('sort'))?filters.get('sort'):'latest'});
  refreshFilters();
  if((params.has('scene')||params.has('piece')||params.has('color')||params.has('batch'))&&hash===location.hash&&archiveRoute()!==hash)history.replaceState(history.state,'',archiveRoute());
 }
 if($('filter-dialog').open)$('filter-dialog').close();
 routing=false;
 const productFocusTarget=/^product-styling-link-\d+$/.test(productFocus)?$(productFocus):null;
 if(scroll&&sceneFocus===null&&archiveFocus===null&&!productFocusTarget)window.scrollTo({top:0,behavior:'instant'});
 if(productFocusTarget){
  productFocusTarget.focus({preventScroll:true});
  productFocusTarget.scrollIntoView({block:'nearest',behavior:'instant'});
 }
 if(openingPublications)$('publication-title').focus({preventScroll:true});
 if(openingRecent)$('recent-page-title').focus({preventScroll:true});
 if(openingWeek)$('week-title').focus({preventScroll:true});
 if(openingPacking)$('packing-title').focus({preventScroll:true});
 if(openingBackup)$('backup-title').focus({preventScroll:true});
 if(sceneFocus!==null){
  const target=document.querySelector('#gallery .look-photo-button[data-open="'+sceneFocus+'"]')||document.querySelector('#scene-links [aria-current="page"]');
  target?.focus();
 }
 if(archiveFocus!==null){
  const card=document.querySelector('#gallery .look-photo-button[data-open="'+archiveFocus+'"]');
  const fallback=state.piece?$('piece-filter'):state.colors.length?$('color-filter-first'):document.querySelector('#publication-entry-link a');
  (card||fallback)?.focus();
 }
 if((focusArchive||leavingScene)&&page==='looks'){focusArchive=false;$('collection-title').tabIndex=-1;$('collection-title').focus({preventScroll:true});}
}
$('detail-dialog').addEventListener('close',()=>{
 closeLookRevision();
 if(routeDetailCloses){routeDetailCloses--;return;}
 if($('detail-dialog').open)return;
 state.active=null;detailNavigation=null;
 if(detailHashPattern.test(location.hash)){
  if(detailSceneOpener!==null){history.back();return;}
  history.replaceState(null,'',detailReturnRoute);routeFromURL(false);
 }
});
window.addEventListener('hashchange',()=>{
 closeLookRevision();
 if($('product-image-dialog').open)$('product-image-dialog').close();
 if($('wardrobe-list-picker').open)$('wardrobe-list-picker').close();
 if($('piece-compare-dialog').open)$('piece-compare-dialog').close();
 routeFromURL();
});
$('open-filters').addEventListener('click',()=>{$('filter-dialog').showModal();});
$('close-filters').addEventListener('click',()=>$('filter-dialog').close());
$('apply-filters').addEventListener('click',()=>$('filter-dialog').close());
function productsForLook(id){return (data.products||[]).filter(p=>p.appearances.some(a=>a.look_id===id));}
function publicAppearances(product){return product.appearances.filter(a=>!byId.get(a.look_id)?.model_only);}
function indexedProducts(){return (data.products||[]).filter(product=>publicAppearances(product).length);}
function comparableProduct(product){return product.asset?.visibility==='public'&&!!publicSource(product.asset.source_url||product.asset.file);}
function publicWardrobeEntry(type,id){
 if(type==='look'){
  const look=byId.get(id);
  return look&&!look.model_only?{title:look.title,href:lookRoute(look)}:null;
 }
 const product=(data.products||[]).find(item=>item.product_id===id);
 return product&&publicAppearances(product).length?{title:product.name,href:'#/product/'+id}:null;
}
const wardrobeListPage=window.WardrobeListPage?.create({escapeText:esc,resolveEntry:publicWardrobeEntry});
const wardrobeWeekPage=window.WardrobeWeekPage?.create({
 escapeText:esc,looks:()=>latestLooks(),resolveEntry:id=>publicWardrobeEntry('look',id),
});
const wardrobePackingPage=window.WardrobePackingPage?.create({
 escapeText:esc,catalog:()=>data,resolveEntry:publicWardrobeEntry,
});
const wardrobeBackup=favoriteStore?window.WardrobeBackup?.create({favorites:favoriteStore}):null;
if(wardrobeBackup)window.WardrobeBackupPage?.create({...wardrobeBackup,escapeText:esc});
const productComparison=window.WardrobeProductCompare?.create({
 products:()=>indexedProducts().filter(comparableProduct),escapeText:esc,imageAttributes,
});
function renderLookProducts(id){
 const linked=productsForLook(id),fromModel=byId.get(id)?.model_only;
 $('detail-products').hidden=!linked.length;
 $('detail-product-gallery').innerHTML=linked.map(product=>productCard(product,{lookId:fromModel?id:null})).join('');
}
function productCard(product,{lookId=null,compare=false}={}){
 const liked=productFavorites.has(product.product_id);
 const href='#/product/'+product.product_id+(lookId&&publicAppearances(product).length?'?look='+lookId:'');
 const productId=esc(product.product_id),name=esc(product.name);
 const favorite=`<button class="product-save" data-product-favorite="${productId}" aria-pressed="${liked}" aria-label="${liked?'取消收藏':'收藏单品'} ${name}">${liked?'♥ 已收藏':'♡ 收藏单品'}</button>`;
 const actions=compare?`<div class="product-card-actions">${favorite}<button type="button" class="product-compare-trigger" id="piece-compare-add-${productId}" data-product-compare="${productId}" aria-haspopup="dialog" aria-label="对比 ${name}">对比单品</button></div>`:favorite;
 return `<article class="product-card" data-product-card="${productId}"><a class="product-card-photo" href="${href}" aria-label="查看 ${name}"><img ${imageAttributes(product.asset)} alt="${name} · AI设计单品" loading="lazy" decoding="async"></a><div class="product-card-meta"><p>${esc(product.category)} <span>DESIGN OBJECT</span></p><h3><a href="${href}">${name}</a></h3><span class="product-color"><i style="background:${product.color_hex}"></i>${esc(product.color_name)}</span>${actions}</div></article>`;
}
function renderHomeProducts(){
 const selected=productsForLook(featuredLook()?.id);$('home-products').hidden=!selected.length;
 $('home-product-gallery').innerHTML=selected.slice(0,3).map(p=>productCard(p)).join('');
}
function renderProducts(){
 const params=new URLSearchParams(location.hash.split('?')[1]),category=params.get('category')||'',saved=params.get('saved')==='1';
 const products=indexedProducts(),categories=[...new Set(products.map(p=>p.category))];
 const choices=[['全部单品','#/products',!category&&!saved],...categories.map(c=>[c,'#/products?'+new URLSearchParams({category:c}),category===c&&!saved]),['我的单品收藏','#/products?saved=1',saved]];
 $('product-filters').innerHTML=choices.map(([title,href,active])=>`<a href="${esc(href)}" ${active?'aria-current="page"':''}>${esc(title)}</a>`).join('');
 const selected=products.filter(p=>(!category||p.category===category)&&(!saved||productFavorites.has(p.product_id)));
 $('product-gallery').innerHTML=selected.map(product=>productCard(product,{compare:comparableProduct(product)})).join('');$('product-empty').hidden=!!selected.length;
}
const productPage=window.YixuProductPage.create({
 isLiked:id=>productFavorites.has(id),
 root:$('product-page'),dialog:$('product-image-dialog'),media:{attributes:imageAttributes,set:setImage},
 renderWorn(a){
  const look=byId.get(a.look_id),version={...versionOf(look),previewPanel:a.shot_index};
  const shown={...look,versions:{v2:version}};
  return `<a class="product-worn" data-product-look="${look.id}" href="${esc(lookRoute(look,a.shot_index))}">${photo(shown)}<div><p class="eyebrow">LOOK ${String(look.id).padStart(3,'0')} / ${esc(publication(look))}</p><h3>${esc(look.title)}</h3><p>${esc(look.description)}</p><p class="product-worn-source">原写真穿着参考 · 第 ${a.shot_index} 镜头</p><span class="product-worn-link">走进这套穿搭 <span aria-hidden="true">↗</span></span></div></a>`;
 }
});
function stylingIdeas(product){
 const group=styleIdeas.get(product?.product_id);
 if(!group||!publicAppearances(product).length)return null;
 const items=group.entries.flatMap(({lookId,pieceIndex,shotIndex,referenceAssetId,tip})=>{
  const look=byId.get(lookId);
  if(!look||look.model_only||shareAsset(look)!==referenceAssetId||!look.pieces[pieceIndex-1])return [];
  const version=versionOf(look);
  const same=product.appearances.some(appearance=>appearance.look_id===lookId&&appearance.piece_index===pieceIndex&&appearance.reference_asset_id===referenceAssetId);
  const preview=photo({...look,versions:{v2:{...version,previewPanel:shotIndex}}});
  return [{lookId,title:look.title,piece:look.pieces[pieceIndex-1].name,shotIndex,tip,same,href:lookRoute(look,shotIndex),preview}];
 });
 return items.length?{title:group.title,items}:null;
}
function renderProduct(id){
 const product=(data.products||[]).find(p=>p.product_id===id);
 const requested=Number(new URLSearchParams(location.hash.split('?')[1]).get('look'));
 const fromModel=product?.appearances.some(a=>a.look_id===requested&&byId.get(a.look_id)?.model_only);
 const indexed=product?publicAppearances(product):[];
 const appearances=fromModel?product.appearances.filter(a=>a.look_id===requested):indexed.length?indexed:product?.appearances||[];
 const related=[...new Map(appearances.flatMap(a=>productsForLook(a.look_id)).filter(p=>p.product_id!==id).map(p=>[p.product_id,p])).values()];
 const modelContext=appearances.map(a=>byId.get(a.look_id)).find(l=>l?.model_only);
 productPage.render({product,number:String((data.products||[]).indexOf(product)+1).padStart(3,'0'),liked:productFavorites.has(id),listable:indexed.length>0,appearances,related,styling:stylingIdeas(product),
   renderCard:p=>productCard(p,{lookId:modelContext?.id}),modelLink:modelContext?{href:modelRoute(modelContext.model_id),name:modelName(modelContext.model_id)}:null});
}
document.addEventListener('click',event=>{
 const compareProduct=event.target.closest('[data-product-compare]');
 if(compareProduct){productComparison?.open(compareProduct.dataset.productCompare,compareProduct);return;}
 const listProduct=event.target.closest('[data-product-list]');
 if(listProduct){wardrobeListPage?.choose('product',listProduct.dataset.productList,listProduct);return;}
 const localLook=event.target.closest('#wardrobe-list-panels a[href^="#look-"], #recent-items a[href^="#look-"], #week-days a[href^="#look-"], #packing-entries a[href^="#look-"]');
 if(localLook&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){
  const id=Number(detailHashPattern.exec(localLook.hash)?.[1]);
  if(publicWardrobeEntry('look',id)){event.preventDefault();openDetail(id);}
  return;
 }
 const worn=event.target.closest('[data-product-look]');
 if(worn&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){
  const id=Number(worn.dataset.productLook),look=byId.get(id);
  if(look){event.preventDefault();openDetail(id,false,{view:linkedShot(look,detailHashPattern.exec(worn.hash)?.[2]),openerId:worn.id});}
  return;
 }
 const button=event.target.closest('[data-product-favorite]');
 if(button){
  const id=button.dataset.productFavorite,product=(data.products||[]).find(p=>p.product_id===id);if(!product)return;
  if(favoriteStore)saveStoredFavorite('product',id,!productFavorites.has(id),button);
  else toggleLocalProductFavorite(id);
 }
});
window.matchMedia('(min-width: 801px)').addEventListener('change',event=>{if(event.matches&&$('filter-dialog').open)$('filter-dialog').close();});
recentStore?.subscribe(()=>{if(state.page==='recent')renderRecent();});
$('recent-clear').addEventListener('click',async()=>{
 try{
  await recentStore.clear();
  await renderRecent();
  if(state.page==='recent')$('recent-page-title').focus();
 }catch(error){
  if(state.page==='recent')$('recent-page-status').textContent=error?.message||'无法清空记录。';
 }
});
window.YixuSiteTheme?.subscribe(({theme})=>{
 const look=featuredLook();
 if(look)updateHeroCover(look,theme);
});
$('scene-links').innerHTML=[...scenes.values()].map(scene=>'<a data-scene="'+esc(scene.id)+'" href="'+esc(sceneRoute(scene.id))+'">'+esc(scene.title)+'</a>').join('');
$('piece-filter').innerHTML='<option value="">全部单品类型</option>'+[...pieceTypes].map(([id,title])=>'<option value="'+esc(id)+'">'+esc(title)+'</option>').join('');
const colorOptions=[...colorTypes].map(([id,label])=>'<option value="'+esc(id)+'">'+esc(label)+'</option>').join('');
$('color-filter-first').innerHTML='<option value="">不选</option>'+colorOptions;
$('color-filter-second').innerHTML='<option value="">不选</option>'+colorOptions;
adoptCatalog(window.WARDROBE || {looks:[],categoryOrder:[]});updateCounts();
if(favoriteStore){
 favoriteStore.subscribe(refreshStoredFavorites);
 refreshStoredFavorites('look');refreshStoredFavorites('product');
}
hydrateCatalog();
})();
