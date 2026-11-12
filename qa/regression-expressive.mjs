import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// State and data-boundary regression for the actual app. The Chromium suite
// separately verifies layout, native events, private uploads, and modal focus.
const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const nodes = new Map(), seasonRadios = [], documentEvents = {}, windowEvents = {};
function node(id) {
  if (nodes.has(id)) return nodes.get(id);
  const element = {
    id, dataset: {}, open: false, hidden: false, value: '', checked: false, children: [],
    disabled: false, textContent: '', innerHTML: '', attrs: {}, events: {},
    style: { setProperty(key, value) { this[key] = value; } },
    classList: { toggle() {}, add() {}, remove() {} },
    parentElement: { hidden: false, attrs:{}, classList:{add(){},remove(){}},setAttribute(key,value){this.attrs[key]=value;},style: { setProperty(key, value) { this[key] = value; } } },
    addEventListener(type, callback) { (this.events[type] ??= []).push(callback); },
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this[key] ?? this.attrs[key] ?? null; },
    removeAttribute(key) { delete this.attrs[key];delete this[key]; },
    showModal() { this.open = true; },close() { this.open = false; },
    focus() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  };nodes.set(id, element);return element;
}
for (const match of html.matchAll(/id="([^"]+)"/g)) node(match[1]);
for (const match of html.matchAll(/<input\b[^>]*>/g)) {
  const markup = match[0];
  if (!/\btype="radio"/.test(markup) || !/\bname="season"/.test(markup)) continue;
  const radio = node('season-radio-' + seasonRadios.length);
  radio.name='season';radio.value=markup.match(/\bvalue="([^"]*)"/)?.[1]??'';
  radio.checked=/\bchecked(?:\s|>|=)/.test(markup);seasonRadios.push(radio);
}
const dialogs=['detail-dialog','compare-dialog','about-dialog','tryon-dialog'].map(node);
const storage=new Map([['wardrobe99:favorites:v1','[9999]']]);
const context={
  window:{addEventListener(type,callback){windowEvents[type]=callback;},scrollTo(){},matchMedia(){return {matches:false,addEventListener(){}};}},
  document:{body:{dataset:{}},getElementById:node,
    querySelectorAll(selector){if(selector==='input[name="season"]')return seasonRadios;if(selector==='dialog')return dialogs;return [];},
    querySelector(selector){return selector==='dialog[open]'?dialogs.find(d=>d.open)||null:null;},
    addEventListener(type,callback){(documentEvents[type]??=[]).push(callback);}},
  localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
  location:{hash:'#/looks',protocol:'file:',href:'file:///offline/index.html#/looks'},URL,URLSearchParams,console,setTimeout:()=>1,clearTimeout(){}
};
context.history={pushState(_state,_title,hash){context.location.hash=hash;},replaceState(_state,_title,hash){context.location.hash=hash;}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'catalog.js'),'utf8'),context);
context.window.WARDROBE.revision='synthetic-static-revision';
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const instrumented=app.replace(/\}\)\(\);\s*$/,`window.__audit={state,byId,favorites,compare,openDetail,setView,toggleFavorite,toggleCompare,openComparison,refreshFilters,renderGallery,navigateLook,resetFilters,adoptCatalog,hydrateCatalog,imageFailed,setImage,publicSource,getFiltered:()=>filtered};})();`);
vm.runInContext(instrumented,context);
const a=context.window.__audit,baseline=JSON.parse(JSON.stringify(context.window.WARDROBE));
const checks=[];
function check(name,fn){fn();checks.push(name);}
check('footer preserves the linked exact ICP number',()=>assert.match(html,/<a\b[^>]*href="https:\/\/beian\.miit\.gov\.cn\/"[^>]*>浙ICP备2026098002号<\/a>/));
check('public UI has no archived edition controls or fixed capacity labels',()=>{
  assert.doesNotMatch(html,/data-edition|edition-compare|百套|>100<|THE ORIGINAL/);
  assert.equal(a.state.version,'v2');assert.equal(node('hero-total').textContent,baseline.looks.length+' 套穿搭，持续更新');
  for(const look of context.window.WARDROBE.looks){assert.deepEqual(Object.keys(look.versions),['v2']);assert.equal(look.versions.v2.shots.length,9);}
  assert.doesNotMatch(node('gallery').innerHTML,/images\/look-/);
});
check('offline snapshot preserves curated category exploration without fixed category sizes',()=>{
  for(const category of baseline.categoryOrder){a.state.category=category;a.refreshFilters();assert.ok(a.getFiltered().every(l=>l.category===category));}
  a.resetFilters();assert.equal(a.state.sort,'latest');assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),baseline.looks.map(l=>l.id).sort((a,b)=>b-a));
  a.state.sort='curated';a.refreshFilters();assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),baseline.displayOrder);
  assert.equal(node('result-count').textContent,baseline.looks.length+' 套造型');
});
function season(value){const target=seasonRadios.find(r=>r.value===value);target.checked=true;node('season').events.change[0]({target});}
check('native season radio changes, clear pills, and reset keep selected state consistent',()=>{
  assert.deepEqual(seasonRadios.map(r=>r.value),['','春秋','夏季','冬季','四季']);
  for(const value of ['夏季','冬季','春秋','四季','']){season(value);assert.deepEqual(seasonRadios.filter(r=>r.checked).map(r=>r.value),[value]);assert.ok(a.getFiltered().every(l=>!value||l.season===value));}
  season('冬季');assert.match(node('active-filters').innerHTML,/data-clear="season"/);
  node('active-filters').events.click[0]({target:{closest:()=>({dataset:{clear:'season'}})}});
  assert.equal(a.state.season,'');season('春秋');node('reset-filters').events.click[0]();assert.equal(a.state.season,'');
});
check('old ID search, all nine panels, download and detail navigation stay associated',()=>{
  const look=a.byId.get(100);for(const query of ['100',look.title]){a.state.query=query;a.refreshFilters();assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),[100]);}
  a.openDetail(100);assert.equal(node('detail-position').textContent,'1 / 1');assert.equal(node('previous-look').disabled,true);assert.equal(node('next-look').disabled,true);
  assert.equal(node('detail-image').src,look.versions.v2.image);assert.equal(node('download-link').href,look.versions.v2.source_url||look.versions.v2.image);assert.match(node('download-link').download,/-v2-.*\.webp$/);
  for(let panel=1;panel<=9;panel++){a.setView(panel);assert.equal(node('view-name').textContent,look.versions.v2.shots[panel-1].title);assert.ok(node('view-moment').textContent.includes(look.versions.v2.shots[panel-1].emotion));}
  a.resetFilters();a.openDetail(100);const ids=Array.from(a.getFiltered(),l=>l.id),index=ids.indexOf(100);a.navigateLook(1);assert.equal(a.state.active,ids[index+1]);a.navigateLook(-1);assert.equal(a.state.active,100);
});
check('comparison details outside the filter retain valid full-list navigation',()=>{
  a.toggleCompare(70);a.toggleCompare(71);a.state.query='丝绒';a.refreshFilters();a.openComparison();
  assert.doesNotMatch(node('comparison-content').innerHTML,/images\/look-/);
  node('comparison-content').events.click[0]({target:{closest:()=>({dataset:{compareDetail:'70'}})}});
  assert.equal(node('detail-position').textContent,(baseline.looks.length-70+1)+' / '+baseline.looks.length);a.navigateLook(1);assert.equal(a.state.active,69);a.navigateLook(-1);assert.equal(a.state.active,70);
  a.state.query=a.byId.get(70).title;a.refreshFilters();a.openDetail(70);assert.equal(node('detail-position').textContent,'1 / 1');
});
check('favorites preserve unknown IDs through toggles and cross-tab updates',()=>{
  assert.equal(a.favorites.has(9999),true);a.toggleFavorite(70);assert.deepEqual(JSON.parse(storage.get('wardrobe99:favorites:v1')),[9999,70]);
  windowEvents.storage({key:'wardrobe99:favorites:v1',newValue:'[9999,70,101,-1,"102"]'});assert.deepEqual(Array.from(a.favorites),[9999,70,101]);
});
check('catalog text is escaped as text in cards and filters',()=>{
  const look=a.byId.get(70),previous=look.title;look.title='<img src=x onerror=evil()> & "test"';a.resetFilters();a.state.limit=1000;a.renderGallery();assert.ok(!node('gallery').innerHTML.includes(look.title));assert.match(node('gallery').innerHTML,/&lt;img src=x onerror=evil\(\)&gt;/);look.title=previous;
});
check('try-on bridge carries exact expressive look and montage/panel context offline',()=>{
  const received=[];context.window.WardrobeTryOn={setContext(value){received.push(JSON.parse(JSON.stringify(value)));},track(){}};
  for(const look of baseline.looks){a.openDetail(look.id);for(let shot=0;shot<=9;shot++){a.setView(shot);assert.deepEqual(received.at(-1),{look_id:look.id,edition:'v2',shot_index:shot});}}
});
check('try-on and comparison modals block underlying detail keyboard navigation',()=>{
  a.resetFilters();a.openDetail(70);const before=a.state.active;node('tryon-dialog').open=true;
  documentEvents.keydown[0]({key:'ArrowRight',target:{matches:()=>false},preventDefault(){throw Error('Underlying navigation intercepted modal key');}});assert.equal(a.state.active,before);node('tryon-dialog').open=false;
});
const dynamic=JSON.parse(JSON.stringify(baseline));
dynamic.models=[{model_id:'female-01',name:'01 号模特'},{model_id:'female-02',name:'02 号模特'}];
for(const [id,model,region,date] of [[101,'female-01','上海','2026-11-12'],[102,'female-02','成都','2026-11-13']]){
  const look=JSON.parse(JSON.stringify(dynamic.looks[0]));Object.assign(look,{id,title:'新增穿搭 '+id,editorialOrder:id,model_id:model,region:{country:'中国',city:region},publish_date:date,batch_id:date+'-01'});
  Object.assign(look.versions.v2,{image:'https://cdn.example/'+id+'.webp',image_url:'https://cdn.example/'+id+'.webp',source_url:'/api/content/assets/look-'+id,download_url:'/api/content/assets/look-'+id+'/download'});dynamic.looks.push(look);
}
let fetchCalls=[];
context.location={protocol:'https:',href:'https://wardrobe.example/',hash:''};
context.fetch=async(url,options)=>{fetchCalls.push({url,options});return{ok:true,json:async()=>dynamic};};
await a.hydrateCatalog();
check('online catalog hydration adopts new IDs and model registry without leaking visitor credentials',()=>{
  assert.equal(fetchCalls.length,1);assert.equal(fetchCalls[0].url,'/api/content/catalog');assert.equal(fetchCalls[0].options.credentials,'omit');
  assert.equal(a.byId.size,baseline.looks.length+2);assert.ok(a.byId.has(102));assert.equal(a.favorites.has(9999),true);assert.equal(a.favorites.has(101),true);
  assert.match(node('model-filter').innerHTML,/female-02/);assert.match(node('region-filter').innerHTML,/成都/);assert.equal(node('hero-total').textContent,(baseline.looks.length+2)+' 套穿搭，持续更新');
});
context.fetch=async()=>({ok:true,json:async()=>({...baseline,revision:'older-server-revision'})});await a.hydrateCatalog();
check('a stale API cannot replace a newer built snapshot or its latest hero',()=>{
  assert.ok(a.byId.has(102));assert.equal(node('hero-detail').dataset.open,102);
  assert.equal(node('catalog-status').textContent,'内容同步中，当前展示已发布版本');
});
check('model, region, latest batch and newest ordering use live data',()=>{
  a.resetFilters();node('model-filter').events.change[0]({target:{value:'female-02'}});assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),[102]);
  a.resetFilters();node('region-filter').events.change[0]({target:{value:'上海'}});assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),[101]);
  a.resetFilters();node('latest-only').events.change[0]({target:{checked:true}});assert.deepEqual(Array.from(a.getFiltered(),l=>l.id),[102]);
  a.resetFilters();a.state.sort='latest';a.refreshFilters();assert.deepEqual(Array.from(a.getFiltered().slice(0,2),l=>l.id),[102,101]);
  a.state.favoritesOnly=true;a.refreshFilters();assert.ok(a.getFiltered().some(l=>l.id===101));
  a.resetFilters();a.openDetail(102);assert.equal(node('detail-image').src,'https://cdn.example/102.webp');assert.equal(node('download-link').href,'/api/content/assets/look-102/download');
});
check('CDN images fall back once to allowlisted public sources and surface final errors',()=>{
  const image=node('image-fixture');a.setImage(image,a.byId.get(102).versions.v2);a.imageFailed({target:image});assert.equal(image.src,'/api/content/assets/look-102');assert.equal(image.dataset.fallback,'true');
  a.imageFailed({target:image});assert.equal(image.hidden,true);assert.equal(image.dataset.failed,'true');assert.equal(image.parentElement.attrs['data-image-status'],'图片暂不可用');
  for(const value of ['/api/tryons/private/image','/api/admin/config','https://other.example/a.webp','images-v2/../private.webp','/images-v2/%2e%2e/private.webp','//evil.example/a.webp'])assert.equal(a.publicSource(value),'');
  const malicious=JSON.parse(JSON.stringify(dynamic));malicious.looks.at(-1).versions.v2.source_url='/api/tryons/private/image';assert.equal(a.adoptCatalog(malicious),false);assert.ok(a.byId.has(102));
});
context.fetch=async()=>{throw Error('offline');};await a.hydrateCatalog();
check('missing or malformed API preserves the full usable snapshot',()=>{
  assert.equal(a.byId.size,baseline.looks.length+2);assert.equal(node('catalog-status').textContent,'正在浏览本地内容快照');assert.equal(a.adoptCatalog({looks:[{id:103}]}),false);assert.ok(a.byId.has(102));
});
check('an intentionally empty valid catalog renders gracefully without deleting favorites',()=>{
  a.adoptCatalog({looks:[],categoryOrder:[],models:[]});assert.equal(a.byId.size,0);assert.equal(node('empty-state').hidden,false);assert.equal(a.favorites.has(9999),true);assert.equal(a.favorites.has(101),true);assert.equal(node('detail-dialog').open,false);
  a.adoptCatalog(baseline);assert.equal(a.byId.size,baseline.looks.length);
});
check('page styles and scripts retain local dependencies for direct offline opening',()=>{
  const styles=['style.css','expressive.css','tryon.css'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');assert.doesNotMatch(html,/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:)?\/\//i);assert.doesNotMatch(styles,/@import\s|url\(\s*["']?(?:https?:)?\/\//i);
});
for(const name of checks)console.log('PASS '+name);
console.log('Synthetic DOM regression: '+checks.length+' checks passed.');
await import('./regression-assets.mjs');
if(process.env.GITHUB_ACTIONS==='true'&&process.env.YIXU_VERIFY_CHILD!=='1')await import('../scripts/verify-application.mjs');
