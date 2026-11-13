(() => {
'use strict';
let data = {}, looks = [], categories = [], models = [];
const byId = new Map();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = id => String(id).padStart(3,'0');
const storageKey = 'wardrobe99:favorites:v1';
let saved = [];
try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(value)) saved = value.filter(id => Number.isSafeInteger(id) && id > 0); } catch {}
const favorites = new Set(saved), compare = new Set();
const productStorageKey='yixu:product-favorites:v1';
let productSaved=[];
try{const value=JSON.parse(localStorage.getItem(productStorageKey)||'[]');if(Array.isArray(value))productSaved=value.filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id));}catch{}
const productFavorites=new Set(productSaved);
const state = {category:'', season:'', query:'', model:'', region:'', latestOnly:false, favoritesOnly:false, sort:'latest', page:'home', limit:24, active:null, view:0, version:'v2'};
let filtered = [], toastTimer, detailReturnRoute = '#/home', routing = false, detailNavigation = null, focusArchive = false, routeDetailCloses = 0;
const snapshotRevision = window.WARDROBE?.revision;
function latestLooks() {
  const rank = new Map((data.latestOrder || []).map((id,index)=>[id,index]));
  return [...looks].sort((a,b)=> rank.has(a.id)&&rank.has(b.id) ? rank.get(a.id)-rank.get(b.id) : rank.has(a.id) ? -1 : rank.has(b.id) ? 1 : String(b.published_at||b.publish_date||'').localeCompare(String(a.published_at||a.publish_date||''))||b.id-a.id);
}
function publication(look) { return look.publish_date || (look.published_at ? look.published_at.slice(0,10) : '历史档案'); }
function featuredLook() { return byId.get(data.home?.featured_look_id) || latestLooks()[0]; }
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
function adoptCatalog(candidate) {
  if(!candidate || !Array.isArray(candidate.looks)||!Array.isArray(candidate.categoryOrder)||!candidate.categoryOrder.every(c=>typeof c==='string')||(candidate.models!==undefined&&(!Array.isArray(candidate.models)||!candidate.models.every(m=>m&&typeof (m.model_id||m.id)==='string'&&typeof m.name==='string'))))return false;
  const next=[], seen=new Set();
  for(const look of candidate.looks){
    const v=look?.versions?.v2;
    if(!Number.isSafeInteger(look?.id)||look.id<1||seen.has(look.id)||!v||v.ready===false||typeof look.title!=='string'||!Array.isArray(v.shots)||v.shots.length!==9||!v.shots.every(shot=>shot&&typeof shot.title==='string')||(v.moods!==undefined&&!Array.isArray(v.moods))||(look.region!=null&&typeof look.region!=='string'&&typeof look.region?.city!=='string')||['published_at','publish_date','batch_id','model_id'].some(key=>look[key]!=null&&typeof look[key]!=='string')||['palette','tags','details','pieces'].some(key=>look[key]!==undefined&&!Array.isArray(look[key]))||!publicSource(v.source_url||v.image))return false;
    seen.add(look.id);next.push({...look,region:typeof look.region==='string'?look.region:(look.region?.city||''),pieces:Array.isArray(look.pieces)?look.pieces:[],details:Array.isArray(look.details)?look.details:[],versions:{v2:{...v,ready:true}}});
  }
  const offeredProducts=candidate.products??[];
  if(!Array.isArray(offeredProducts)||!offeredProducts.every(p=>{
    return p&&/^[A-Za-z0-9_-]+$/.test(p.product_id)&&['name','category','subtitle','description','color_name','design_material'].every(key=>typeof p[key]==='string')&&/^#[a-fA-F0-9]{6}$/.test(p.color_hex)&&Array.isArray(p.notes)&&p.notes.every(n=>typeof n==='string')&&publicSource(p.asset?.source_url||p.asset?.file)&&Array.isArray(p.appearances)&&p.appearances.every(a=>{const look=next.find(l=>l.id===a.look_id);return look&&Number.isSafeInteger(a.piece_index)&&a.piece_index>=1&&a.piece_index<=look.pieces.length&&a.reference_asset_id===look.versions.v2.asset?.asset_id&&Number.isInteger(a.shot_index)&&a.shot_index>=1&&a.shot_index<=9;});
  }))return false;
  if(new Set(offeredProducts.map(p=>p.product_id)).size!==offeredProducts.length)return false;
  data={...candidate,products:offeredProducts.map(p=>({...p,asset:{...p.asset,source_url:p.asset.source_url||p.asset.file,image_url:p.asset.image_url||p.asset.source_url||p.asset.file}})),looks:next};looks=next;byId.clear();looks.forEach(l=>byId.set(l.id,l));
  models=Array.isArray(data.models)?data.models.map(model=>({...model,id:model.model_id||model.id})):[];
  categories=[...new Set([...(data.categoryOrder||[]),...looks.map(l=>l.category)])].filter(c=>looks.some(l=>l.category===c));
  window.WARDROBE=data;window.WardrobeTryOn?.setCatalog?.(data);
  if(state.category&&!categories.includes(state.category))state.category='';
  if(state.model&&!looks.some(l=>l.model_id===state.model))state.model='';
  if(state.region&&!looks.some(l=>l.region===state.region))state.region='';
  if(state.latestOnly&&!latestBatch())state.latestOnly=false;
  for(const id of compare)if(!byId.has(id))compare.delete(id);
  buildCategories();buildContentFilters();updateEditionUI();renderModels();refreshFilters();renderCompareTray();
  if($('detail-dialog').open){if(byId.has(state.active)){const view=state.view;openDetail(state.active,true);setView(view);}else{$('detail-dialog').close();state.active=null;}}
  if($('compare-dialog').open){if(compare.size>=2)openComparison();else $('compare-dialog').close();}
  routeFromURL(false);
  return true;
}
function buildContentFilters(){
  $('model-filter').innerHTML='<option value="">全部模特</option>'+[...new Set(looks.map(l=>l.model_id).filter(Boolean))].map(id=>'<option value="'+esc(id)+'">'+esc(modelName(id))+'</option>').join('');
  $('region-filter').innerHTML='<option value="">全部地区</option>'+[...new Set(looks.map(l=>l.region).filter(Boolean))].sort().map(region=>'<option value="'+esc(region)+'">'+esc(region)+'</option>').join('');
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
function updateEditionUI(){
 renderHomeProducts();
 $('completion-note').textContent=looks.length+' 套生动穿搭';
 $('hero-total').textContent=looks.length+' 套穿搭，持续更新';
 const look=featuredLook();
 $('latest-feature').hidden=!look;
 if(!look){$('recent-gallery').innerHTML='';$('recent-gallery').parentElement.hidden=true;return;}
 const v=versionOf(look),p=Math.min(9,Math.max(1,v.previewPanel||1));
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
 const image=$('hero-image-0');setImage(image,v);image.alt=look.title+' · '+(v.shots[p-1]?.title||'生动写真');
 image.parentElement.style.setProperty('--panel-x',-((p-1)%3)*100+'%');image.parentElement.style.setProperty('--panel-y',-Math.floor((p-1)/3)*100+'%');
 $('hero-edition-note').textContent='LOOK '+number(look.id)+' / '+(v.shots[p-1]?.title||'生动写真');
 const recentIds=Array.isArray(data.home?.recent_look_ids)?data.home.recent_look_ids:null;
 const recent=(recentIds?recentIds.map(id=>byId.get(id)).filter(Boolean):latestLooks()).filter(l=>l.id!==look.id).slice(0,6);
 $('recent-gallery').innerHTML=recent.map(renderCard).join('');
 $('recent-note').textContent=recent.some(l=>!l.published_at&&!l.publish_date)?'最新一期之后，接着翻阅历史档案。':'';
 $('recent-gallery').parentElement.hidden=!recent.length;
}
function renderModels(){
 $('model-gallery').innerHTML=models.map(model=>{
   const owned=latestLooks().filter(look=>look.model_id===model.id),cover=owned[0];
   if(!cover)return '';
   const href='#/looks?model='+encodeURIComponent(model.id);
   return '<article class="model-card"><a href="'+href+'" aria-label="查看 '+esc(model.name)+' 的穿搭">'+photo(cover,model.name+' · '+cover.title)+'</a><p class="eyebrow">'+esc(model.id)+'</p><h2>'+esc(model.name)+'</h2><p>'+owned.length+' 套已发布穿搭</p><a class="model-looks-link" href="'+href+'">查看她的穿搭 ↗</a></article>';
 }).join('');
 $('models-empty').hidden=!!$('model-gallery').children.length;
}
function saveFavorites() {
  try { localStorage.setItem(storageKey,JSON.stringify([...favorites])); }
  catch { notify('已在本次浏览中收藏；当前浏览器不允许持久保存'); }
}
function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  saveFavorites(); updateCounts();
  if (state.favoritesOnly || state.sort === 'favorites') renderGallery(); else syncCardButtons(id);
  if (state.active === id) updateDetailActions();
  updateEditionUI();
}
function toggleCompare(id) {
  if (compare.has(id)) compare.delete(id);
  else if (compare.size < 3) compare.add(id);
  else { notify('最多同时对比 3 套，请先移除一套'); return; }
  syncCardButtons(id); renderCompareTray();
  if (state.active === id) updateDetailActions();
}
function updateCounts() {
  $('fav-top-count').textContent = favorites.size;
  $('favorites-count').textContent = favorites.size;
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
  const entries = [{name:'',label:'全部造型',count:looks.length},...categories.map(name => ({name,label:name,count:looks.filter(l=>l.category===name).length}))];
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
  filtered = looks.filter(l => {
    if (state.category && l.category !== state.category) return false;
    if (state.season && l.season !== state.season) return false;
    if (state.model && l.model_id !== state.model) return false;
    if (state.region && l.region !== state.region) return false;
    if (state.latestOnly && l.batch_id !== latest) return false;
    if ((state.page==='favorites'||state.favoritesOnly) && !favorites.has(l.id)) return false;
    return matchesSearch(l,state.query);
  }).sort((a,b) => state.version==='v2'&&versionOf(a).ready!==versionOf(b).ready ? Number(versionOf(b).ready)-Number(versionOf(a).ready) : state.sort==='latest' ? latestRank.get(a.id)-latestRank.get(b.id) : state.sort==='curated' ? (a.editorialOrder??a.id)-(b.editorialOrder??b.id) : state.sort==='pieces' ? b.pieces.length-a.pieces.length || a.id-b.id : state.sort==='favorites' ? Number(favorites.has(b.id))-Number(favorites.has(a.id)) || a.id-b.id : a.id-b.id);
}
function refreshFilters() {
  state.limit=24;
  $('model-filter').value=state.model;$('region-filter').value=state.region;$('latest-only').checked=state.latestOnly;
  document.querySelectorAll('input[name="season"]').forEach(input=>{input.checked=input.value===state.season;}); $('search').value=state.query; $('favorites-only').checked=state.page==='favorites'||state.favoritesOnly; $('favorites-only').disabled=state.page==='favorites'; $('sort').value=state.sort;
  document.querySelectorAll('[data-category]').forEach(b=>{const active=b.dataset.category===state.category;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  renderGallery(); renderActiveFilters();syncArchiveURL();
}
function resetFilters() { Object.assign(state,{category:'',season:'',query:'',model:'',region:'',latestOnly:false,favoritesOnly:false,sort:'latest'});refreshFilters(); }
function renderActiveFilters() {
  const entries=[];
  if(state.category)entries.push(['category',state.category]);
  if(state.season)entries.push(['season',state.season]);
  if(state.model)entries.push(['model',modelName(state.model)]);
  if(state.region)entries.push(['region',state.region]);
  if(state.latestOnly)entries.push(['latestOnly','最新批次']);
  if(state.query)entries.push(['query','“'+state.query+'”']);
  if(state.favoritesOnly&&state.page!=='favorites')entries.push(['favoritesOnly','我的收藏']);
  $('filter-count').textContent=entries.length?'('+entries.length+')':'';
  $('active-filters').innerHTML=entries.map(([key,label])=>'<button class="filter-pill" data-clear="'+key+'" aria-label="清除'+esc(label)+'筛选">'+esc(label)+' <span aria-hidden="true">×</span></button>').join('');
}
function renderCard(l,index) {
  const liked=favorites.has(l.id), picked=compare.has(l.id);
  return '<article class="look-card" style="animation-delay:'+Math.min(index,8)*25+'ms" data-look-card="'+l.id+'"><div class="image-zone"><button class="look-photo-button" data-open="'+l.id+'" aria-label="查看 '+esc(l.title)+' 的九宫格写真和搭配设计">'+(versionOf(l).ready?photo(l):'<div class="card-pending"><span>'+number(l.id)+'</span><small>写真准备中</small></div>')+'<span class="card-number">'+number(l.id)+'</span>'+'<span class="open-caption">查看写真与设计 <span>↗</span></span></button><div class="card-actions"><button class="icon-button favorite'+(liked?' selected':'')+'" data-favorite="'+l.id+'" aria-pressed="'+liked+'" aria-label="'+(liked?'取消收藏':'收藏')+' '+esc(l.title)+'">'+heart+'</button><button class="icon-button compare'+(picked?' selected':'')+'" data-compare="'+l.id+'" aria-pressed="'+picked+'" aria-label="'+(picked?'移出对比':'加入对比')+' '+esc(l.title)+'">'+comparison+'</button></div></div><div class="card-meta"><div class="card-topline"><span>'+esc(l.category)+' / '+esc(l.season)+' · '+l.pieces.length+' 件搭配</span><div class="palette" aria-label="造型配色">'+palette(l)+'</div></div><button class="card-title" data-open="'+l.id+'">'+esc(l.title)+'</button><p class="card-publication">'+esc(publication(l))+'</p><p class="card-tags">'+(state.version==='v2'?(versionOf(l).moods||l.tags||[]):(l.tags||[])).slice(0,4).map(esc).join(' · ')+'</p></div></article>';
}
function renderGallery() {
  matchLooks();
  $('gallery').innerHTML=filtered.slice(0,state.limit).map(renderCard).join('');
  $('result-count').textContent=filtered.length+' 套造型';
  $('empty-state').hidden=filtered.length!==0;
  $('load-more').hidden=filtered.length<=state.limit;
  $('gallery-end').textContent=filtered.length && filtered.length<=state.limit ? '— END OF THIS SELECTION —' : filtered.length ? '已展示 '+Math.min(state.limit,filtered.length)+' / '+filtered.length+' 套' : '';
}
function delegatedActions(event) {
  const favorite=event.target.closest('[data-favorite]'); if(favorite){toggleFavorite(Number(favorite.dataset.favorite));return;}
  const compareButton=event.target.closest('[data-compare]');if(compareButton){toggleCompare(Number(compareButton.dataset.compare));return;}
  const opener=event.target.closest('[data-open]');if(opener)openDetail(Number(opener.dataset.open));
}
$('gallery').addEventListener('click',delegatedActions);
$('home-page').addEventListener('click',delegatedActions);
$('category-list').addEventListener('click',event=>{const button=event.target.closest('[data-category]');if(button){state.category=button.dataset.category;refreshFilters();}});
$('model-filter').addEventListener('change',e=>{state.model=e.target.value;refreshFilters();});
$('region-filter').addEventListener('change',e=>{state.region=e.target.value;refreshFilters();});
$('latest-only').addEventListener('change',e=>{state.latestOnly=e.target.checked;refreshFilters();});
$('active-filters').addEventListener('click',e=>{const b=e.target.closest('[data-clear]');if(!b)return;state[b.dataset.clear]=['favoritesOnly','latestOnly'].includes(b.dataset.clear)?false:'';refreshFilters();});
$('season').addEventListener('change',e=>{if(e.target.name!=='season')return;state.season=e.target.value;refreshFilters();});
$('search').addEventListener('input',e=>{state.query=e.target.value;state.limit=24;renderGallery();renderActiveFilters();syncArchiveURL();});
$('favorites-only').addEventListener('change',e=>{state.favoritesOnly=e.target.checked;refreshFilters();});
$('sort').addEventListener('change',e=>{state.sort=e.target.value;refreshFilters();});
$('reset-filters').addEventListener('click',resetFilters);$('empty-reset').addEventListener('click',resetFilters);
$('load-more').addEventListener('click',()=>{const previous=state.limit;state.limit+=24;renderGallery();document.querySelector('[data-look-card="'+filtered[previous]?.id+'"] .look-photo-button')?.focus({preventScroll:true});});
function detailList() { return detailNavigation ? detailNavigation.map(id=>byId.get(id)).filter(Boolean) : latestLooks(); }
function setView(view) {
  state.view=view;
  const frame=$('detail-photo-frame'),image=$('detail-image');
  frame.classList.toggle('single-view',view>0);
  if(view>0){image.style.left=-(view-1)%3*100+'%';image.style.top=-Math.floor((view-1)/3)*100+'%';}else{image.style.left='';image.style.top='';}
  document.querySelectorAll('[data-view]').forEach(b=>{const active=Number(b.dataset.view)===view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const current=versionOf(byId.get(state.active));const names=['完整九宫格',...current.shots.map(s=>s.title)];
  $('view-name').textContent=names[view]||'写真';const shot=current.shots[view-1];$('view-moment').textContent=state.version==='v2'?(shot?[shot.emotion,shot.pose,shot.framing].filter(Boolean).join(' · '):current.summary):'';
  const look=byId.get(state.active);image.alt=look.title+' · '+names[view];
  window.WardrobeTryOn?.setContext?.({look_id:look.id,edition:state.version,shot_index:view});
}
function updateDetailActions() {
  const l=byId.get(state.active);if(!l)return;
  const f=favorites.has(l.id),c=compare.has(l.id);
  $('detail-favorite').textContent=f?'♥ 已收藏':'♡ 收藏这套';
  $('detail-favorite').setAttribute('aria-pressed',String(f));
  $('detail-compare').textContent=c?'− 移出对比':'+ 加入对比';
  $('detail-compare').setAttribute('aria-pressed',String(c));
}
function openDetail(id,preserveNavigation=false) {
  const l=byId.get(id);if(!l)return;
  const detailRoute=/^#look-/.test(location.hash),restored=!$('detail-dialog').open&&detailRoute?history.state?.wardrobeDetail:null;
  if(restored&&typeof restored.returnRoute==='string'&&/^#\/(home|looks|models|favorites|products|product)(?:[/?]|$)/.test(restored.returnRoute))detailReturnRoute=restored.returnRoute;
  else if(!$('detail-dialog').open)detailReturnRoute=detailRoute?'#/home':location.hash||'#/home';
  if(restored&&Array.isArray(restored.navigation)&&restored.navigation.includes(id))detailNavigation=restored.navigation.filter(key=>byId.has(key));
  else if(!preserveNavigation||!detailNavigation)detailNavigation=((state.page==='looks'||state.page==='favorites')&&filtered.some(look=>look.id===id)?filtered:latestLooks()).map(look=>look.id);
  const entry={...history.state,wardrobeDetail:{returnRoute:detailReturnRoute,navigation:detailNavigation}};
  if(location.hash!=='#look-'+id)history.pushState(entry,'','#look-'+id);
  else history.replaceState(entry,'',location.hash);
  state.active=id;
  $('detail-number').textContent='LOOK '+number(id)+' / '+l.category+' / '+l.season;
  $('detail-title').textContent=l.title;$('detail-story').hidden=state.version!=='v2';$('detail-story-title').textContent=versionOf(l).story;$('detail-story-summary').textContent=versionOf(l).summary;
  $('detail-palette').innerHTML=palette(l);
  $('detail-description').textContent=l.description;
  $('detail-tags').innerHTML=(l.tags||[]).map(tag=>{
    if(typeof tag!=='string'||!tag.trim()||!looks.some(other=>other.id!==id&&matchesSearch(other,tag)))return '<span>'+esc(tag)+'</span>';
    const href='#/looks?'+new URLSearchParams({q:tag});
    return '<a href="'+esc(href)+'" data-explore-tag aria-label="搜索标签 '+esc(tag)+'">'+esc(tag)+' <span aria-hidden="true">↗</span></a>';
  }).join('')+(versionOf(l).moods||[]).map(mood=>'<span>'+esc(mood)+'</span>').join('');
  $('detail-pieces').innerHTML=l.pieces.map((p,i)=>'<li><span class="piece-number">'+String(i+1).padStart(2,'0')+'</span><span class="piece-role">'+esc(p.role)+'</span><span>'+esc(p.name)+'</span></li>').join('');
  const linkedProducts=productsForLook(id);$('detail-products').hidden=!linkedProducts.length;$('detail-product-gallery').innerHTML=linkedProducts.map(productCard).join('');
  $('detail-design').innerHTML=l.details.map(d=>'<li>'+esc(d)+'</li>').join('');
  $('detail-scene').textContent='写真场景 / '+l.scene;
  $('detail-image').hidden=!versionOf(l).ready;$('detail-photo-frame').classList.toggle('pending',!versionOf(l).ready);
  if(versionOf(l).ready)setImage($('detail-image'),versionOf(l));else $('detail-image').removeAttribute('src');
  $('original-link').href=imageURL(versionOf(l));$('download-link').href=publicSource(versionOf(l).download_url,true)||publicSource(versionOf(l).source_url||versionOf(l).image);$('download-link').download='LOOK-'+number(id)+'-'+state.version+'-'+l.title+'.webp';
  $('original-link').hidden=!versionOf(l).ready;$('download-link').hidden=!versionOf(l).ready;
  $('view-selector').innerHTML=[0,1,2,3,4,5,6,7,8,9].map(v=>'<button data-view="'+v+'" aria-label="'+esc(v?String(v).padStart(2,'0')+' · '+(versionOf(l).shots[v-1]?.title||'写真'+v):'完整九宫格')+'" aria-pressed="'+!v+'">'+(v?'<span class="shot-number">'+String(v).padStart(2,'0')+'</span><span class="shot-title">'+esc(versionOf(l).shots[v-1]?.title||'写真'+v)+'</span>':'九宫格')+'</button>').join('');
  $('view-selector').hidden=!versionOf(l).ready;setView(0);updateDetailActions();
  window.WardrobeTryOn?.track?.('look_open',{look_id:id,edition:state.version});
  const list=detailList(),position=list.findIndex(x=>x.id===id);
  $('detail-position').textContent=(position+1)+' / '+list.length;
  $('previous-look').disabled=position<=0;$('next-look').disabled=position>=list.length-1;
  if(!$('detail-dialog').open)$('detail-dialog').showModal();
  $('detail-dialog').scrollTop=0;
}
$('view-selector').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)setView(Number(b.dataset.view));});
$('detail-tags').addEventListener('click',event=>{if(event.target.closest('[data-explore-tag]')&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)focusArchive=true;});
$('close-detail').addEventListener('click',()=>$('detail-dialog').close());
$('detail-favorite').addEventListener('click',()=>toggleFavorite(state.active));
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
function openComparison() {
  if(compare.size<2)return;
  const content=$('comparison-content');
  content.style.setProperty('--compare-cols',String(compare.size));
  content.innerHTML=[...compare].map(id=>{const l=byId.get(id);return '<article class="comparison-card">'+(versionOf(l).ready?photo(l):'<div class="card-pending"><span>'+number(l.id)+'</span><small>写真制作中</small></div>')+'<h3>'+esc(l.title)+'</h3><p class="eyebrow">LOOK '+number(l.id)+' · '+esc(l.category)+'</p><div class="palette">'+palette(l)+'</div><p>'+esc(l.description)+'</p><h4>搭配单品 / '+l.pieces.length+' 件</h4><ul>'+l.pieces.map(p=>'<li>'+esc(p.name)+'</li>').join('')+'</ul><h4>设计思路</h4><ul>'+l.details.map(d=>'<li>'+esc(d)+'</li>').join('')+'</ul><button class="solid-button" data-compare-detail="'+l.id+'">查看九宫格写真 ↗</button></article>';}).join('');
  if(!$('compare-dialog').open)$('compare-dialog').showModal();
}
$('open-compare').addEventListener('click',openComparison);$('close-compare').addEventListener('click',()=>$('compare-dialog').close());
$('comparison-content').addEventListener('click',e=>{const b=e.target.closest('[data-compare-detail]');if(b){$('compare-dialog').close();openDetail(Number(b.dataset.compareDetail));}});
$('about-button').addEventListener('click',()=>$('about-dialog').showModal());$('close-about').addEventListener('click',()=>$('about-dialog').close());
$('about-to-gallery').addEventListener('click',()=>{$('about-dialog').close();location.hash='#/looks';});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
document.addEventListener('keydown',e=>{
  const editable=e.target.matches('input,textarea,select,[contenteditable]');
  if(e.key==='/'&&!editable&&!document.querySelector('dialog[open]')){e.preventDefault();if(!['looks','favorites'].includes(state.page)){history.pushState(null,'','#/looks');routeFromURL(false);}$('search').focus();$('search').scrollIntoView({block:'center',behavior:'smooth'});}
  if($('detail-dialog').open&&!$('tryon-dialog')?.open&&!$('compare-dialog').open&&!editable&&!e.target.closest('#view-selector, #detail-tags a')){if(e.key==='ArrowRight'){e.preventDefault();navigateLook(1);}if(e.key==='ArrowLeft'){e.preventDefault();navigateLook(-1);}}
});
window.addEventListener('storage',e=>{if(e.key===productStorageKey){try{const values=JSON.parse(e.newValue||'[]');if(!Array.isArray(values))return;productFavorites.clear();values.filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id)).forEach(id=>productFavorites.add(id));renderHomeProducts();if(state.page==='products')renderProducts();if(state.page==='product'){const id=/^#\/product\/([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1];if(id)renderProduct(id);}if(state.active)$('detail-product-gallery').innerHTML=productsForLook(state.active).map(productCard).join('');}catch{}return;}if(e.key!==storageKey)return;try{const values=JSON.parse(e.newValue||'[]');if(!Array.isArray(values))return;favorites.clear();values.filter(id=>Number.isSafeInteger(id)&&id>0).forEach(id=>favorites.add(id));updateCounts();renderGallery();updateEditionUI();if(state.active)updateDetailActions();}catch{}});
function archiveRoute(){
 const params=new URLSearchParams();
 for(const [key,value] of [['category',state.category],['season',state.season],['q',state.query],['model',state.model],['region',state.region],['latest',state.latestOnly?'1':''],['saved',state.favoritesOnly&&state.page!=='favorites'?'1':''],['sort',state.sort==='latest'?'':state.sort]])if(value)params.set(key,value);
 return '#/'+state.page+(params.size?'?'+params:'');
}
function syncArchiveURL(){if(!routing&&['looks','favorites'].includes(state.page)&&!$('detail-dialog').open)history.replaceState(null,'',archiveRoute());}
function routeFromURL(scroll=true){
 const detail=/^#look-(\d+)$/.exec(location.hash);
 if(detail){const id=Number(detail[1]);if(byId.has(id)){openDetail(id,$('detail-dialog').open);return;}notify('这套穿搭暂未发布');}
 const productRoute=/^#\/product\/([A-Za-z0-9_-]+)$/.exec(location.hash);
 const route=/^#\/(home|looks|models|favorites|products)(?:\?(.*))?$/.exec(location.hash),page=productRoute?'product':route?.[1]||'home';
 routing=true;
 state.page=page;
 // Native dialog close events are queued. A route-driven close must not later
 // overwrite a detail URL restored by Back before that close event arrives.
 if($('detail-dialog').open){routeDetailCloses++;$('detail-dialog').close();}state.active=null;detailNavigation=null;
 $('home-page').hidden=page!=='home';$('models-page').hidden=page!=='models';$('collection').hidden=!['looks','favorites'].includes(page);$('closing-note').hidden=page!=='home';
 $('products-page').hidden=page!=='products';$('product-page').hidden=page!=='product';
 if(page==='products')renderProducts();if(page==='product')renderProduct(productRoute[1]);
 $('collection-title').innerHTML=(page==='favorites'?'我的收藏':'全部穿搭')+'<span class="heading-period">.</span>';
 document.querySelectorAll('[data-page]').forEach(link=>{if(link.dataset.page===page||(page==='product'&&link.dataset.page==='products'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
 if(['looks','favorites'].includes(page)){
  const params=new URLSearchParams(route?.[2]||'');
  Object.assign(state,{category:params.get('category')||'',season:params.get('season')||'',query:params.get('q')||'',model:params.get('model')||'',region:params.get('region')||'',latestOnly:params.get('latest')==='1',favoritesOnly:page==='favorites'||params.get('saved')==='1',sort:['latest','curated','id','pieces','favorites'].includes(params.get('sort'))?params.get('sort'):'latest'});
  refreshFilters();
 }
 if($('filter-dialog').open)$('filter-dialog').close();
 routing=false;
 if(scroll)window.scrollTo({top:0,behavior:'instant'});
 if(focusArchive&&page==='looks'){focusArchive=false;$('collection-title').tabIndex=-1;$('collection-title').focus({preventScroll:true});}
}
$('detail-dialog').addEventListener('close',()=>{
 if(routeDetailCloses){routeDetailCloses--;return;}
 if($('detail-dialog').open)return;
 state.active=null;detailNavigation=null;
 if(/^#look-/.test(location.hash)){history.replaceState(null,'',detailReturnRoute);routeFromURL(false);}
});
window.addEventListener('hashchange',()=>{if($('product-image-dialog').open)$('product-image-dialog').close();routeFromURL();});
$('open-filters').addEventListener('click',()=>{$('filter-dialog').showModal();});
$('close-filters').addEventListener('click',()=>$('filter-dialog').close());
$('apply-filters').addEventListener('click',()=>$('filter-dialog').close());
function productsForLook(id){return (data.products||[]).filter(p=>p.appearances.some(a=>a.look_id===id));}
function productCard(product){
 const liked=productFavorites.has(product.product_id),href='#/product/'+product.product_id;
 return `<article class="product-card" data-product-card="${esc(product.product_id)}"><a class="product-card-photo" href="${href}" aria-label="查看 ${esc(product.name)}"><img ${imageAttributes(product.asset)} alt="${esc(product.name)} · AI设计单品" loading="lazy" decoding="async"></a><div class="product-card-meta"><p>${esc(product.category)} <span>DESIGN OBJECT</span></p><h3><a href="${href}">${esc(product.name)}</a></h3><span class="product-color"><i style="background:${product.color_hex}"></i>${esc(product.color_name)}</span><button class="product-save" data-product-favorite="${esc(product.product_id)}" aria-pressed="${liked}" aria-label="${liked?'取消收藏':'收藏单品'} ${esc(product.name)}">${liked?'♥ 已收藏':'♡ 收藏单品'}</button></div></article>`;
}
function renderHomeProducts(){
 const selected=productsForLook(featuredLook()?.id);$('home-products').hidden=!selected.length;
 $('home-product-gallery').innerHTML=selected.slice(0,3).map(productCard).join('');
}
function renderProducts(){
 const params=new URLSearchParams(location.hash.split('?')[1]),category=params.get('category')||'',saved=params.get('saved')==='1';
 const products=data.products||[],categories=[...new Set(products.map(p=>p.category))];
 const choices=[['全部单品','#/products',!category&&!saved],...categories.map(c=>[c,'#/products?'+new URLSearchParams({category:c}),category===c&&!saved]),['我的单品收藏','#/products?saved=1',saved]];
 $('product-filters').innerHTML=choices.map(([title,href,active])=>`<a href="${esc(href)}" ${active?'aria-current="page"':''}>${esc(title)}</a>`).join('');
 const selected=products.filter(p=>(!category||p.category===category)&&(!saved||productFavorites.has(p.product_id)));
 $('product-gallery').innerHTML=selected.map(productCard).join('');$('product-empty').hidden=!!selected.length;
}
function renderProduct(id){
 const product=(data.products||[]).find(p=>p.product_id===id);
 if(!product){$('product-page').innerHTML='<p class="eyebrow">THE OBJECT EDIT</p><h1>这件单品暂未发布。</h1><a class="outline-button" href="#/products">浏览全部单品 ↗</a>';return;}
 const number=String((data.products||[]).indexOf(product)+1).padStart(3,'0'),liked=productFavorites.has(id);
 const appearances=product.appearances.filter(a=>byId.has(a.look_id));
 const related=[...new Map(appearances.flatMap(a=>productsForLook(a.look_id)).filter(p=>p.product_id!==id).map(p=>[p.product_id,p])).values()];
 const worn=appearances.map(a=>{
  const look=byId.get(a.look_id),version={...versionOf(look),previewPanel:a.shot_index};
  const shown={...look,versions:{v2:version}};
  return `<a class="product-worn" data-product-look="${look.id}" href="#look-${look.id}">${photo(shown)}<div><p class="eyebrow">LOOK ${String(look.id).padStart(3,'0')} / ${esc(publication(look))}</p><h3>${esc(look.title)}</h3><p>${esc(version.shots[a.shot_index-1]?.title||'模特穿着参考')}</p><span>查看整套穿搭 ↗</span></div></a>`;
 }).join('');
 $('product-page').innerHTML=`<div class="product-breadcrumb"><a href="#/products">单品</a><span>/</span><span>${esc(product.category)}</span></div><div class="product-hero"><button class="product-main-image" data-product-zoom="${id}" aria-label="放大查看 ${esc(product.name)}"><img ${imageAttributes(product.asset)} alt="${esc(product.name)} · 完整产品图" fetchpriority="high" decoding="async"><span>放大细看 ↗</span></button><article class="product-copy"><p class="eyebrow">THE OBJECT EDIT / ${number}</p><p class="product-category">${esc(product.category)} · AI 设计单品</p><h1>${esc(product.name)}</h1><p class="product-subtitle">${esc(product.subtitle)}</p><p class="product-description">${esc(product.description)}</p><dl class="product-facts"><div><dt>颜色</dt><dd><span class="product-color"><i style="background:${product.color_hex}"></i>${esc(product.color_name)}</span></dd></div><div><dt>肌理</dt><dd>${esc(product.design_material)}</dd></div><div><dt>穿搭</dt><dd>${appearances.length} 套穿着参考</dd></div></dl><div class="product-actions"><button class="solid-button" data-product-favorite="${id}" aria-pressed="${liked}">${liked?'♥ 已收藏':'♡ 收藏单品'}</button><button class="outline-button" data-product-worn>看模特怎么穿 ↓</button></div><p class="product-disclosure">AI 设计展示，供穿搭灵感参考。独立产品图依据写真演绎；未展示部分为设计补充，实际衣装细节请结合穿着参考查看。</p></article></div><section class="product-observation"><div><p class="eyebrow">FORM & TEXTURE</p><h2>细节，让日常不同。</h2><p>从完整轮廓，到值得停留的肌理。</p><ol>${product.notes.map((note,i)=>`<li><span>0${i+1}</span>${esc(note)}</li>`).join('')}</ol></div><button class="product-macro" data-product-zoom="${id}" aria-label="放大单品肌理"><img ${imageAttributes(product.asset)} alt="${esc(product.name)} · 主图局部放大" loading="lazy"><span>主图局部 · 点击查看完整图 ↗</span></button></section><section id="product-worn-section" class="product-worn-section"><div class="section-heading"><div><p class="eyebrow">ON THE MODEL</p><h2>回到穿着的那一刻。</h2></div></div><div class="product-worn-grid">${worn}</div></section>${related.length?`<section class="product-related"><div class="section-heading"><div><p class="eyebrow">THE COMPLETE LOOK</p><h2>一起，刚刚好。</h2></div></div><div class="product-grid">${related.map(productCard).join('')}</div></section>`:''}`;
}
document.addEventListener('click',event=>{
 const worn=event.target.closest('[data-product-look]');
 if(worn&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();openDetail(Number(worn.dataset.productLook));return;}
 if(event.target.closest('[data-product-worn]')){document.querySelector('#product-worn-section')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 const button=event.target.closest('[data-product-favorite]');
 if(button){
  const id=button.dataset.productFavorite,product=(data.products||[]).find(p=>p.product_id===id);if(!product)return;
  productFavorites.has(id)?productFavorites.delete(id):productFavorites.add(id);
  try{localStorage.setItem(productStorageKey,JSON.stringify([...productFavorites]));}catch{notify('当前浏览器无法保存单品收藏');}
  document.querySelectorAll('[data-product-favorite]').forEach(b=>{if(b.dataset.productFavorite!==id)return;const liked=productFavorites.has(id);b.textContent=liked?'♥ 已收藏':'♡ 收藏单品';b.setAttribute('aria-pressed',String(liked));b.setAttribute('aria-label',(liked?'取消收藏':'收藏单品')+' '+product.name);});
  if(state.page==='products'&&new URLSearchParams(location.hash.split('?')[1]).get('saved')==='1')renderProducts();return;
 }
 const zoom=event.target.closest('[data-product-zoom]');
 if(zoom){const product=(data.products||[]).find(p=>p.product_id===zoom.dataset.productZoom);if(!product)return;setImage($('product-zoom-image'),product.asset);$('product-zoom-image').alt=product.name+' · 完整产品图';$('product-image-dialog').showModal();}
});
$('close-product-image').addEventListener('click',()=>$('product-image-dialog').close());

window.matchMedia('(min-width: 801px)').addEventListener('change',event=>{if(event.matches&&$('filter-dialog').open)$('filter-dialog').close();});
adoptCatalog(window.WARDROBE || {looks:[],categoryOrder:[]});updateCounts();
hydrateCatalog();
})();
