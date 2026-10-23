(() => {
'use strict';
const data = window.WARDROBE || {looks:[], target:100, generated:0};
const looks = data.looks, byId = new Map(looks.map(l => [l.id,l]));
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = id => String(id).padStart(3,'0');
const storageKey = 'wardrobe99:favorites:v1';
let saved = [];
try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(value)) saved = value.filter(id => Number.isInteger(id) && byId.has(id)); } catch {}
const favorites = new Set(saved), compare = new Set();
const state = {category:'', season:'', query:'', favoritesOnly:false, sort:'curated', limit:24, active:null, view:0, version:'v2'};
let filtered = [], toastTimer;
const heart = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 5.6c-2.2-2.5-5.9-1.8-8.5 1-2.6-2.8-6.3-3.5-8.5-1-3.2 3.5.3 8 8.5 13.5 8.2-5.5 11.7-10 8.5-13.5Z"/></svg>';
const comparison = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v18h6M15 3h6v18h-6M12 2v20"/></svg>';
const categoryOrder = data.categoryOrder;
const categories = categoryOrder.filter(c => looks.some(l => l.category === c));
function notify(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function palette(look) { return (look.palette || []).filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => '<span class="color-swatch" style="background:'+c+'" title="'+c+'"></span>').join(''); }
function versionOf(look) { return look.versions[state.version]; }
function photo(look, alt) {
 const v=versionOf(look),p=Math.min(9,Math.max(1,v.previewPanel||1)),next=p%9+1;
 const x=-((p-1)%3)*100,y=-Math.floor((p-1)/3)*100,nx=-((next-1)%3)*100,ny=-Math.floor((next-1)/3)*100;
 return '<div class="photo-window" style="--panel-x:'+x+'%;--panel-y:'+y+'%;--next-x:'+nx+'%;--next-y:'+ny+'%"><img src="'+esc(v.image)+'" alt="'+esc(alt || look.title+' · '+(v.shots[p-1]?.title||'写真'))+'" loading="lazy" decoding="async"></div>';
}
function updateEditionUI(){
 document.body.dataset.edition=state.version;
 document.querySelectorAll('[data-edition]').forEach(b=>{const active=b.dataset.edition===state.version;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 $('completion-note').textContent=state.version==='v2'?'生动':'造型';
 $('hero-kicker').textContent=state.version==='v2'?'A LITTLE CLOSER':'THE WARDROBE';
 const candidates=[13,70,40,1,99].map(id=>byId.get(id)).filter(l=>l&&versionOf(l).ready);
 const unique=[...new Set([...candidates,...looks.filter(l=>versionOf(l).ready)])].slice(0,2);
 for(let i=0;i<2;i++){const img=$('hero-image-'+i),look=unique[i];if(!look){img.parentElement.hidden=true;continue;}img.parentElement.hidden=false;const v=versionOf(look),p=v.previewPanel||1;img.hidden=false;img.src=v.image;img.alt=look.title+' · '+(v.shots[p-1]?.title||'造型');img.parentElement.style.setProperty('--panel-x',-((p-1)%3)*100+'%');img.parentElement.style.setProperty('--panel-y',-Math.floor((p-1)/3)*100+'%');}
 $('hero-edition-note').textContent=state.version==='v2'?'A LITTLE CLOSER':'THE WARDROBE INDEX';
}
function switchEdition(version){
 if(!['v1','v2'].includes(version))return;state.version=version;state.limit=24;
 updateEditionUI();renderGallery();renderActiveFilters();renderCompareTray();
 if($('detail-dialog').open&&state.active)openDetail(state.active);
 if($('compare-dialog').open)openComparison();
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
  $('category-list').addEventListener('click',event=>{
    const button = event.target.closest('[data-category]'); if(!button)return;
    state.category = button.dataset.category; refreshFilters();
  });
}
function matchLooks() {
  const q = state.query.trim().toLocaleLowerCase();
  filtered = looks.filter(l => {
    if (state.category && l.category !== state.category) return false;
    if (state.season && l.season !== state.season) return false;
    if (state.favoritesOnly && !favorites.has(l.id)) return false;
    if (q) {
      const terms = [number(l.id),String(l.id),l.title,l.category,l.season,l.description,...(l.tags||[]),...(l.pieces||[]).map(p=>p.name),...(l.details||[]),versionOf(l).story,versionOf(l).summary,...(versionOf(l).moods||[]),...(versionOf(l).shots||[]).flatMap(s=>[s.title,s.emotion,s.pose])].join(' ').toLocaleLowerCase();
      return q.split(/\s+/).every(word=>terms.includes(word));
    }
    return true;
  }).sort((a,b) => state.version==='v2'&&versionOf(a).ready!==versionOf(b).ready ? Number(versionOf(b).ready)-Number(versionOf(a).ready) : state.sort==='curated' ? a.editorialOrder-b.editorialOrder : state.sort==='pieces' ? b.pieces.length-a.pieces.length || a.id-b.id : state.sort==='favorites' ? Number(favorites.has(b.id))-Number(favorites.has(a.id)) || a.id-b.id : a.id-b.id);
}
function refreshFilters() {
  state.limit=24;
  document.querySelectorAll('input[name="season"]').forEach(input=>{input.checked=input.value===state.season;}); $('search').value=state.query; $('favorites-only').checked=state.favoritesOnly; $('sort').value=state.sort;
  document.querySelectorAll('[data-category]').forEach(b=>{const active=b.dataset.category===state.category;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  renderGallery(); renderActiveFilters();
}
function resetFilters() { Object.assign(state,{category:'',season:'',query:'',favoritesOnly:false,sort:'curated'});refreshFilters(); }
function renderActiveFilters() {
  const entries=[];
  if(state.category)entries.push(['category',state.category]);
  if(state.season)entries.push(['season',state.season]);
  if(state.query)entries.push(['query','“'+state.query+'”']);
  if(state.favoritesOnly)entries.push(['favoritesOnly','我的收藏']);
  $('active-filters').innerHTML=entries.map(([key,label])=>'<button class="filter-pill" data-clear="'+key+'" aria-label="清除'+esc(label)+'筛选">'+esc(label)+' <span aria-hidden="true">×</span></button>').join('');
}
function renderCard(l,index) {
  const liked=favorites.has(l.id), picked=compare.has(l.id);
  return '<article class="look-card" style="animation-delay:'+Math.min(index,8)*25+'ms" data-look-card="'+l.id+'"><div class="image-zone"><button class="look-photo-button" data-open="'+l.id+'" aria-label="查看 '+esc(l.title)+' 的九宫格写真和搭配设计">'+(versionOf(l).ready?photo(l):'<div class="card-pending"><span>'+number(l.id)+'</span><small>写真准备中</small></div>')+'<span class="card-number">'+number(l.id)+'</span>'+'<span class="open-caption">查看写真与设计 <span>↗</span></span></button><div class="card-actions"><button class="icon-button favorite'+(liked?' selected':'')+'" data-favorite="'+l.id+'" aria-pressed="'+liked+'" aria-label="'+(liked?'取消收藏':'收藏')+' '+esc(l.title)+'">'+heart+'</button><button class="icon-button compare'+(picked?' selected':'')+'" data-compare="'+l.id+'" aria-pressed="'+picked+'" aria-label="'+(picked?'移出对比':'加入对比')+' '+esc(l.title)+'">'+comparison+'</button></div></div><div class="card-meta"><div class="card-topline"><span>'+esc(l.category)+' / '+esc(l.season)+' · '+l.pieces.length+' 件搭配</span><div class="palette" aria-label="造型配色">'+palette(l)+'</div></div><button class="card-title" data-open="'+l.id+'">'+esc(l.title)+'</button><p class="card-tags">'+(state.version==='v2'?(versionOf(l).moods||l.tags||[]):(l.tags||[])).slice(0,4).map(esc).join(' · ')+'</p></div></article>';
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
$('active-filters').addEventListener('click',e=>{const b=e.target.closest('[data-clear]');if(!b)return;state[b.dataset.clear]=b.dataset.clear==='favoritesOnly'?false:'';refreshFilters();});
$('season').addEventListener('change',e=>{if(e.target.name!=='season')return;state.season=e.target.value;refreshFilters();});
$('search').addEventListener('input',e=>{state.query=e.target.value;state.limit=24;renderGallery();renderActiveFilters();});
$('favorites-only').addEventListener('change',e=>{state.favoritesOnly=e.target.checked;refreshFilters();});
$('sort').addEventListener('change',e=>{state.sort=e.target.value;refreshFilters();});
$('reset-filters').addEventListener('click',resetFilters);$('empty-reset').addEventListener('click',resetFilters);
$('header-favorites').addEventListener('click',()=>{resetFilters();state.favoritesOnly=true;refreshFilters();$('collection').scrollIntoView({behavior:'smooth'});});
$('load-more').addEventListener('click',()=>{const previous=state.limit;state.limit+=24;renderGallery();document.querySelector('[data-look-card="'+filtered[previous]?.id+'"] .look-photo-button')?.focus({preventScroll:true});});
function detailList() { return filtered.some(look=>look.id===state.active)?filtered:looks; }
function setView(view) {
  state.view=view;
  const frame=$('detail-photo-frame'),image=$('detail-image');
  frame.classList.toggle('single-view',view>0);
  if(view>0){image.style.left=-(view-1)%3*100+'%';image.style.top=-Math.floor((view-1)/3)*100+'%';}else{image.style.left='';image.style.top='';}
  document.querySelectorAll('[data-view]').forEach(b=>{const active=Number(b.dataset.view)===view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const current=versionOf(byId.get(state.active));const names=['完整九宫格',...current.shots.map(s=>s.title)];
  $('view-name').textContent=names[view]||'写真';const shot=current.shots[view-1];$('view-moment').textContent=state.version==='v2'?(shot?[shot.emotion,shot.pose,shot.framing].filter(Boolean).join(' · '):current.summary):'';
  const look=byId.get(state.active);image.alt=look.title+' · '+names[view];
}
function updateDetailActions() {
  const l=byId.get(state.active);if(!l)return;
  const f=favorites.has(l.id),c=compare.has(l.id);
  $('detail-favorite').textContent=f?'♥ 已收藏':'♡ 收藏这套';
  $('detail-favorite').setAttribute('aria-pressed',String(f));
  $('detail-compare').textContent=c?'− 移出对比':'+ 加入对比';
  $('detail-compare').setAttribute('aria-pressed',String(c));
}
function openDetail(id) {
  const l=byId.get(id);if(!l)return;state.active=id;
  $('detail-number').textContent='LOOK '+number(id)+' / '+l.category+' / '+l.season;
  $('detail-title').textContent=l.title;$('detail-story').hidden=state.version!=='v2';$('detail-story-title').textContent=versionOf(l).story;$('detail-story-summary').textContent=versionOf(l).summary;
  $('detail-palette').innerHTML=palette(l);
  $('detail-description').textContent=l.description;
  $('detail-tags').innerHTML=[...(l.tags||[]),...(state.version==='v2'?(versionOf(l).moods||[]):[])].map(t=>'<span>'+esc(t)+'</span>').join('');
  $('detail-pieces').innerHTML=l.pieces.map((p,i)=>'<li><span class="piece-number">'+String(i+1).padStart(2,'0')+'</span><span class="piece-role">'+esc(p.role)+'</span><span>'+esc(p.name)+'</span></li>').join('');
  $('detail-design').innerHTML=l.details.map(d=>'<li>'+esc(d)+'</li>').join('');
  $('detail-scene').textContent='写真场景 / '+l.scene;
  $('detail-image').hidden=!versionOf(l).ready;$('detail-photo-frame').classList.toggle('pending',!versionOf(l).ready);
  if(versionOf(l).ready)$('detail-image').src=versionOf(l).image;else $('detail-image').removeAttribute('src');
  $('original-link').href=versionOf(l).image;$('download-link').href=versionOf(l).image;$('download-link').download='LOOK-'+number(id)+'-'+state.version+'-'+l.title+'.png';
  $('original-link').hidden=!versionOf(l).ready;$('download-link').hidden=!versionOf(l).ready;
  $('view-selector').innerHTML=[0,1,2,3,4,5,6,7,8,9].map(v=>'<button data-view="'+v+'" aria-label="'+esc(v?(versionOf(l).shots[v-1]?.title||'写真'+v):'完整九宫格')+'" aria-pressed="'+!v+'">'+(v?String(v).padStart(2,'0'):'九宫格')+'</button>').join('');
  $('view-selector').hidden=!versionOf(l).ready;setView(0);updateDetailActions();
  const list=detailList(),position=list.findIndex(x=>x.id===id);
  $('detail-position').textContent=(position+1)+' / '+list.length;
  $('previous-look').disabled=position<=0;$('next-look').disabled=position>=list.length-1;
  if(!$('detail-dialog').open)$('detail-dialog').showModal();
  $('detail-dialog').scrollTop=0;
}
$('view-selector').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)setView(Number(b.dataset.view));});
$('close-detail').addEventListener('click',()=>$('detail-dialog').close());
$('detail-favorite').addEventListener('click',()=>toggleFavorite(state.active));
$('detail-compare').addEventListener('click',()=>toggleCompare(state.active));
function navigateLook(direction) {
  const list=detailList(),index=list.findIndex(l=>l.id===state.active);
  if(index+direction>=0 && index+direction<list.length)openDetail(list[index+direction].id);
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
$('about-to-gallery').addEventListener('click',()=>{$('about-dialog').close();$('collection').scrollIntoView({behavior:'smooth'});});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
document.addEventListener('keydown',e=>{
  const editable=e.target.matches('input,textarea,select,[contenteditable]');
  if(e.key==='/'&&!editable&&!document.querySelector('dialog[open]')){e.preventDefault();$('search').focus();$('search').scrollIntoView({block:'center',behavior:'smooth'});}
  if($('detail-dialog').open&&!$('edition-compare-dialog').open&&!$('compare-dialog').open&&!editable){if(e.key==='ArrowRight'){e.preventDefault();navigateLook(1);}if(e.key==='ArrowLeft'){e.preventDefault();navigateLook(-1);}}
});
window.addEventListener('storage',e=>{if(e.key!==storageKey)return;try{const values=JSON.parse(e.newValue||'[]');if(!Array.isArray(values))return;favorites.clear();values.filter(id=>byId.has(id)).forEach(id=>favorites.add(id));updateCounts();renderGallery();if(state.active)updateDetailActions();}catch{}});
document.querySelectorAll('[data-edition]').forEach(b=>b.addEventListener('click',()=>switchEdition(b.dataset.edition)));updateEditionUI();
$('edition-compare').addEventListener('click',()=>{
 const l=byId.get(state.active);if(!l)return;
 $('edition-comparison-content').innerHTML=['v1','v2'].map(key=>{const v=l.versions[key];return '<figure><figcaption>'+(key==='v1'?'造型':'生动')+'</figcaption>'+(v.ready?'<a href="'+esc(v.image)+'" target="_blank" rel="noopener"><img src="'+esc(v.image)+'" alt="'+esc(l.title)+(key==='v1'?'造型':'生动')+'"></a>':'<p>写真准备中</p>')+'</figure>';}).join('');
 $('edition-compare-title').textContent=l.title+' · 生动 / 造型';$('edition-compare-dialog').showModal();
});
$('close-edition-compare').addEventListener('click',()=>$('edition-compare-dialog').close());
buildCategories();updateCounts();renderGallery();
const initial=/^#look-(\d{1,3})$/.exec(location.hash);
if(initial&&byId.has(Number(initial[1])))openDetail(Number(initial[1]));
})();
