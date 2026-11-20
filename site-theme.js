/* One local preference seam; adapters arrange existing nodes, never business state. */
(() => {
'use strict';
const KEY='yixu:site-theme:v1',names=new Set(['editorial','studio']);
const normalize=value=>names.has(value)?value:'auto';
function create({document,storage,eventTarget}){
 let choice='auto',persisted=!!storage;
 try{choice=normalize(storage?.getItem(KEY));}catch{persisted=false;}
 const listeners=new Set(),controls=new Set();
 let adminLayout=null,adminPanels=null,adminNav=null;
 function arrangePublic(studio){
  const hero=document.querySelector('.latest-hero'),copy=hero?.querySelector('.hero-copy');
  if(hero&&copy){if(studio)hero.append(copy);else hero.prepend(copy);}
 }
 function arrangeAdmin(studio){
  const workspace=document.getElementById('workspace');if(!workspace)return;
  if(!adminPanels){adminNav=workspace.querySelector('.section-nav');adminPanels=[...workspace.children].filter(node=>node.matches('section.panel'));}
  if(!adminNav)return;
  if(studio){
   if(!adminLayout){adminLayout=document.createElement('div');adminLayout.className='site-admin-layout';const content=document.createElement('div');content.className='site-admin-content';adminLayout.append(content);}
   // All private nodes remain descendants of the original hidden workspace.
   workspace.append(adminLayout);adminLayout.prepend(adminNav);adminLayout.querySelector('.site-admin-content').append(...adminPanels);
  }else if(adminLayout?.parentNode){workspace.append(adminNav,...adminPanels);adminLayout.remove();}
 }
 const adapters=Object.freeze({
  editorial:{apply(){arrangePublic(false);arrangeAdmin(false);}},
  studio:{apply(){arrangePublic(true);arrangeAdmin(true);}}
 });
 function resolve(fallback='editorial',override){
  if(names.has(override))return override;
  return choice==='auto'?(names.has(fallback)?fallback:'editorial'):choice;
 }
 function apply(){
  const active=document.activeElement;
  const theme=resolve();document.documentElement.dataset.siteTheme=theme;
  document.documentElement.dataset.siteThemePreference=choice;
  adapters[theme].apply();
  for(const control of controls){control.select.querySelectorAll('option').forEach(option=>{option.selected=option.value===choice;});control.note.textContent=persisted?'前后台共用此浏览器的布局偏好。':'浏览器未能保存偏好；当前页面仍可切换。';}
  if(active?.isConnected&&document.activeElement!==active)active.focus?.({preventScroll:true});
 }
 function notify(){apply();for(const listener of listeners)listener({choice,theme:resolve()});}
 function choose(value){
  choice=normalize(value);
  try{if(!storage)throw Error('storage unavailable');if(choice==='auto')storage.removeItem(KEY);else storage.setItem(KEY,choice);persisted=true;}catch{persisted=false;}
  notify();
 }
 function mount(container){
  if(!container||container.dataset.themeMounted)return;
  container.dataset.themeMounted='true';container.classList.add('site-theme-control');
  const details=document.createElement('details'),summary=document.createElement('summary'),panel=document.createElement('div'),label=document.createElement('label'),select=document.createElement('select'),note=document.createElement('p');
  details.className='site-theme-chooser';summary.textContent='布局';summary.setAttribute('aria-label','切换浏览布局');panel.className='site-theme-panel';label.textContent='选择浏览布局';select.setAttribute('aria-label','选择浏览布局');
  for(const [value,text] of [['auto','编辑推荐 · 恢复默认'],['editorial','Editorial · 留白叙事'],['studio','Studio · 大图图库']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
  note.className='site-theme-note';note.setAttribute('role','status');label.append(select);panel.append(label,note);details.append(summary,panel);container.append(details);controls.add({select,note});
  select.addEventListener('change',()=>choose(select.value));
  details.addEventListener('keydown',event=>{if(event.key==='Escape'){details.open=false;summary.focus();}});
  apply();
 }
 eventTarget?.addEventListener('storage',event=>{
  if(event.key!==KEY&&event.key!==null)return;
  if(event.storageArea&&storage&&event.storageArea!==storage)return;
  choice=normalize(event.newValue);notify();
 });
 apply();
 return Object.freeze({choose,resolve,preference:()=>choice==='auto'?null:choice,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},mount});
}
let storage;try{storage=window.localStorage;}catch{}
const live=create({document,storage,eventTarget:window});
window.YixuSiteTheme=Object.freeze({...live,create,storageKey:KEY});
const boot=()=>document.querySelectorAll('[data-site-theme-control]').forEach(live.mount);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
