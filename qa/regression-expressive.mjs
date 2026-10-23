import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Runs the actual static app against a deliberately small synthetic DOM.
// This checks state transitions; browser layout, focus and native Escape still
// require the separate real-browser verification.
const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const nodes = new Map();
const editions = [];
const seasonRadios = [];
function node(id) {
  if (nodes.has(id)) return nodes.get(id);
  const element = {
    id, dataset: {}, open: false, hidden: false, value: '', checked: false,
    disabled: false, textContent: '', innerHTML: '', attrs: {}, events: {},
    style: { setProperty(key, value) { this[key] = value; } },
    classList: { toggle() {}, add() {}, remove() {} },
    parentElement: { hidden: false, style: { setProperty(key, value) { this[key] = value; } } },
    addEventListener(type, callback) { (this.events[type] ??= []).push(callback); },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  };
  nodes.set(id, element);
  return element;
}
for (const match of html.matchAll(/id="([^"]+)"/g)) node(match[1]);
for (const match of html.matchAll(/<button[^>]*data-edition="([^"]+)"[^>]*>/g)) {
  const button = node('edition-button-' + editions.length);
  button.dataset.edition = match[1];
  editions.push(button);
}
for (const match of html.matchAll(/<input\b[^>]*>/g)) {
  const markup = match[0];
  if (!/\btype="radio"/.test(markup) || !/\bname="season"/.test(markup)) continue;
  const radio = node('season-radio-' + seasonRadios.length);
  radio.type = 'radio';
  radio.name = 'season';
  radio.value = markup.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
  radio.checked = /\bchecked(?:\s|>|=)/.test(markup);
  seasonRadios.push(radio);
}
const dialogs = ['detail-dialog', 'compare-dialog', 'about-dialog', 'edition-compare-dialog'].map(node);
const documentEvents = {};
const windowEvents = {};
const storage = new Map();
const context = {
  window: { addEventListener(type, callback) { windowEvents[type] = callback; } },
  document: {
    body: { dataset: {} },
    getElementById: node,
    querySelectorAll(selector) {
      if (selector === '[data-edition]') return editions;
      if (selector === 'input[name="season"]') return seasonRadios;
      if (selector === 'dialog') return dialogs;
      return [];
    },
    querySelector(selector) {
      return selector === 'dialog[open]' ? dialogs.find(dialog => dialog.open) || null : null;
    },
    addEventListener(type, callback) { (documentEvents[type] ??= []).push(callback); }
  },
  localStorage: {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value)
  },
  location: { hash: '' },
  console,
  setTimeout: () => 1,
  clearTimeout() {}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'catalog.js'), 'utf8'), context);
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.match(app, /\}\)\(\);\s*$/);
const instrumented = app.replace(/\}\)\(\);\s*$/, `window.__audit = {
  state, byId, favorites, compare, openDetail, switchEdition, setView,
  toggleFavorite, toggleCompare, openComparison, refreshFilters,
  renderGallery, navigateLook, resetFilters, getFiltered: () => filtered
};})();`);
vm.runInContext(instrumented, context);
const a = context.window.__audit;
const checks = [];
function check(name, fn) { fn(); checks.push(name); }

check('unified catalog has ten collections of ten and curated cross-collection order', () => {
  const data = context.window.WARDROBE;
  assert.equal(data.looks.length, 100);
  assert.equal(data.categoryOrder.length, 10);
  assert.equal(new Set(data.categoryOrder).size, 10);
  assert.equal(new Set(data.displayOrder).size, 100);
  assert.deepEqual(Array.from(data.displayOrder).sort((a,b) => a-b), Array.from({length:100},(_,i) => i+1));
  for (const category of data.categoryOrder) {
    assert.equal(data.looks.filter(look => look.category === category).length, 10);
    a.state.category = category;
    a.refreshFilters();
    assert.equal(a.getFiltered().length, 10);
    assert.ok(a.getFiltered().every(look => look.category === category));
  }
  a.resetFilters();
  assert.equal(a.state.sort, 'curated');
  assert.equal(a.state.version, 'v2');
  assert.deepEqual(Array.from(a.getFiltered(), look => look.id), Array.from(data.displayOrder));
  assert.equal(new Set(a.getFiltered().slice(0,10).map(look => look.category)).size, 10);
  assert.equal(node('result-count').textContent, '100 套造型');
});
check('legacy new-batch filters and badges are absent', () => {
  assert.ok(!Object.hasOwn(a.state, 'newOnly'));
  assert.ok(!/newOnly|new-only|只看新增|初选九套|\bNEW\b/.test(html + '\n' + app));
  assert.ok(!node('category-list').innerHTML.includes('初选'));
});
function assertSeason(value) {
  assert.equal(a.state.season, value);
  assert.deepEqual(seasonRadios.filter(radio => radio.checked).map(radio => radio.value), [value]);
  const expected = context.window.WARDROBE.displayOrder
    .filter(id => !value || a.byId.get(id).season === value);
  assert.deepEqual(Array.from(a.getFiltered(), look => look.id), Array.from(expected));
  assert.equal(node('result-count').textContent, expected.length + ' 套造型');
}
function changeSeason(value) {
  const target = seasonRadios.find(radio => radio.value === value);
  assert.ok(target, 'Season radio exists: ' + value);
  // A single bubbled change must update results immediately. The app's
  // refresh synchronizes the whole radio group, including clear/reset flows.
  target.checked = true;
  assert.equal(node('season').events.change.length, 1);
  node('season').events.change[0]({ target });
}
check('season controls are five native radios with a default all option', () => {
  assert.match(html, /<fieldset\b[^>]*class="season-filter"[^>]*><legend>穿着季节<\/legend>/);
  assert.ok(!/<select\b[^>]*(?:id|name)="season"/.test(html));
  assert.ok(!/第一版|第二版/.test(html));
  assert.deepEqual(seasonRadios.map(radio => radio.value), ['', '春秋', '夏季', '冬季', '四季']);
  assertSeason('');
});
check('one season change filters immediately and leaves exactly one selected radio', () => {
  for (const value of ['夏季', '冬季', '春秋', '四季', '']) {
    changeSeason(value);
    assertSeason(value);
  }
  const before = a.state.season;
  node('season').events.change[0]({target:{name:'unrelated',value:'冬季'}});
  assert.equal(a.state.season,before);
});
check('season clear pill and reset button both restore the complete collection', () => {
  changeSeason('冬季');
  assert.match(node('active-filters').innerHTML, /data-clear="season"/);
  node('active-filters').events.click[0]({
    target:{closest:() => ({dataset:{clear:'season'}})}
  });
  assertSeason('');
  assert.ok(!node('active-filters').innerHTML.includes('data-clear="season"'));
  changeSeason('春秋');
  node('reset-filters').events.click[0]();
  assertSeason('');
  assert.equal(a.state.sort,'curated');
});
check('switching photography styles preserves season and matching outfits', () => {
  changeSeason('夏季');
  const expected = Array.from(a.getFiltered(),look=>look.id);
  for(const version of ['v1','v2']){
    const button = editions.find(item=>item.dataset.edition===version);
    button.events.click[0]();
    assert.equal(a.state.version,version);
    assertSeason('夏季');
    assert.deepEqual(Array.from(a.getFiltered(),look=>look.id),expected);
  }
  node('reset-filters').events.click[0]();
  assertSeason('');
});

check('look 100 is searchable and its two editions, panels and navigation are complete', () => {
  const look = a.byId.get(100);
  assert.ok(look);
  for (const query of ['100', look.title]) {
    a.state.query = query;
    a.refreshFilters();
    assert.deepEqual(Array.from(a.getFiltered(), item => item.id), [100]);
  }
  a.openDetail(100);
  assert.equal(node('detail-position').textContent, '1 / 1');
  assert.equal(node('previous-look').disabled, true);
  assert.equal(node('next-look').disabled, true);
  a.switchEdition('v1');
  assert.equal(node('detail-image').src, 'images/look-100.png');
  assert.equal(node('download-link').href, 'images/look-100.png');
  a.switchEdition('v2');
  assert.equal(node('detail-image').src, 'images-v2/look-100.png');
  for(let panel=1;panel<=9;panel++){
    a.setView(panel);
    assert.equal(node('view-name').textContent,look.versions.v2.shots[panel-1].title);
    assert.ok(node('view-moment').textContent.includes(look.versions.v2.shots[panel-1].emotion));
  }
  node('edition-compare').events.click[0]();
  assert.match(node('edition-comparison-content').innerHTML,/images\/look-100\.png/);
  assert.match(node('edition-comparison-content').innerHTML,/images-v2\/look-100\.png/);
  node('edition-compare-dialog').close();
  a.resetFilters();
  a.openDetail(100);
  const expected = Array.from(context.window.WARDROBE.displayOrder);
  const index = expected.indexOf(100);
  assert.equal(node('detail-position').textContent, (index+1)+' / 100');
  a.navigateLook(1);
  assert.equal(a.state.active, expected[index+1]);
  a.navigateLook(-1);
  assert.equal(a.state.active, 100);
  node('detail-dialog').close();
});

// Reproduces the reported defect through the real comparison click handler:
// selected outfits remain available when the current gallery filter excludes them.
check('filtered gallery -> comparison detail -> valid full-list navigation', () => {
  a.toggleCompare(70);
  a.toggleCompare(71);
  a.state.query = '丝绒';
  a.refreshFilters();
  a.openComparison();
  node('comparison-content').events.click[0]({
    target: { closest: () => ({ dataset: { compareDetail: '70' } }) }
  });
  assert.equal(node('detail-position').textContent, '70 / 100');
  a.navigateLook(1);
  assert.equal(a.state.active, 71);
  assert.equal(node('detail-position').textContent, '71 / 100');
  a.navigateLook(-1);
  assert.equal(a.state.active, 70);
});
check('in-filter detail retains filtered navigation bounds', () => {
  a.state.query = a.byId.get(70).title;
  a.refreshFilters();
  a.openDetail(70);
  assert.equal(node('detail-position').textContent, '1 / 1');
  assert.equal(node('previous-look').disabled, true);
  assert.equal(node('next-look').disabled, true);
});
check('edition change with edition-only query does not create position zero', () => {
  a.switchEdition('v2');
  a.state.query = a.byId.get(70).versions.v2.story;
  a.refreshFilters();
  a.openDetail(70);
  assert.equal(node('detail-position').textContent, '1 / 1');
  a.switchEdition('v1');
  assert.equal(node('detail-position').textContent, '70 / 100');
});
check('open detail links, filename and shot description track edition', () => {
  assert.equal(node('detail-image').src, 'images/look-070.png');
  assert.equal(node('original-link').href, 'images/look-070.png');
  assert.equal(node('download-link').href, 'images/look-070.png');
  assert.match(node('download-link').download, /-v1-/);
  assert.equal(node('view-moment').textContent, '');
  a.switchEdition('v2');
  assert.equal(node('detail-image').src, 'images-v2/look-070.png');
  assert.equal(node('download-link').href, 'images-v2/look-070.png');
  assert.match(node('download-link').download, /-v2-/);
  a.setView(5);
  assert.ok(node('view-moment').textContent.includes(a.byId.get(70).versions.v2.shots[4].pose));
});
check('favorites are shared by outfit ID across both editions', () => {
  a.toggleFavorite(70);
  a.switchEdition('v1');
  assert.equal(a.favorites.has(70), true);
  assert.equal(node('detail-favorite').attrs['aria-pressed'], 'true');
  a.switchEdition('v2');
  assert.equal(a.favorites.has(70), true);
  assert.deepEqual(JSON.parse(storage.get('wardrobe99:favorites:v1')), [70]);
});
check('open comparison updates image paths when edition changes', () => {
  a.openComparison();
  assert.match(node('comparison-content').innerHTML, /images-v2\/look-070\.png/);
  a.switchEdition('v1');
  assert.match(node('comparison-content').innerHTML, /images\/look-071\.png/);
  assert.ok(!node('comparison-content').innerHTML.includes('images-v2/'));
  node('compare-dialog').close();
});
check('nested two-edition modal blocks underlying detail arrow navigation', () => {
  node('edition-compare').events.click[0]();
  const before = a.state.active;
  let prevented = false;
  documentEvents.keydown[0]({
    key: 'ArrowRight', target: { matches: () => false },
    preventDefault() { prevented = true; }
  });
  assert.equal(a.state.active, before);
  assert.equal(prevented, false);
  node('edition-compare-dialog').close();
});
check('catalog HTML text is escaped, not interpreted as markup', () => {
  const look = a.byId.get(70), previous = look.title;
  look.title = '<img src=x onerror=evil()> & "test"';
  a.state.query = '';
  a.state.limit = 100;
  a.renderGallery();
  const rendered = node('gallery').innerHTML;
  assert.ok(!rendered.includes(look.title));
  assert.ok(rendered.includes('&lt;img src=x onerror=evil()&gt;'));
  look.title = previous;
});
check('all 100 records have local, distinct-edition image paths and nine shots', () => {
  const looks = context.window.WARDROBE.looks;
  assert.equal(looks.length, 100);
  assert.equal(new Set(looks.map(look => look.id)).size, 100);
  for (const look of looks) {
    const id = String(look.id).padStart(3, '0');
    assert.equal(look.versions.v1.image, 'images/look-' + id + '.png');
    assert.equal(look.versions.v2.image, 'images-v2/look-' + id + '.png');
    assert.equal(look.versions.v1.shots.length, 9);
    assert.equal(look.versions.v2.shots.length, 9);
  }
});
check('page and styles have no remote dependencies', () => {
  const styles = ['style.css', 'expressive.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:)?\/\//i.test(html));
  assert.ok(!/@import\s|url\(\s*["']?(?:https?:)?\/\//i.test(styles));
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\b/.test(app));
});
for (const name of checks) console.log('PASS ' + name);
console.log('Synthetic DOM regression: ' + checks.length + ' checks passed.');
