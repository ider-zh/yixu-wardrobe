(() => {
  'use strict';

  function create({escapeText, catalog, resolveEntry}) {
    const byId = id => document.getElementById(id);
    const page = byId('packing-page');
    const sourceForm = byId('packing-source-form');
    const source = byId('packing-source');
    const current = byId('packing-current');
    const name = byId('packing-current-name');
    const clear = byId('packing-clear');
    const status = byId('packing-status');
    const entries = byId('packing-entries');
    const missing = byId('packing-missing');
    const mergeForm = byId('packing-merge-form');
    const target = byId('packing-merge-target');
    const from = byId('packing-merge-source');
    const lists = window.WardrobeLists;
    const packing = window.WardrobePacking;
    const store = window.WardrobePackingStore;
    const esc = escapeText;
    const queuedChecks = new Map();
    let snapshot = null;
    let renderSequence = 0;
    let readMessage = '';
    let pending = 0;
    let refreshPending = false;
    let mutations = Promise.resolve();

    function options(select, values, placeholder) {
      const previous = select.value;
      select.innerHTML = `<option value="">${esc(placeholder)}</option>` + values.map(({value, label}) => (
        `<option value="${esc(value)}">${esc(label)}</option>`
      )).join('');
      select.value = values.some(item => item.value === previous) ? previous : '';
      select.disabled = values.length === 0;
    }

    function sourceLabel(origin, title) {
      const type = origin.type === 'look' ? '穿搭' : '单品';
      const piece = origin.pieceIndex ? ` · 第 ${origin.pieceIndex} 件` : '';
      return `${type} ${title || origin.id}${piece}`;
    }

    function sourceMarkup(origin, key) {
      const item = resolveEntry(origin.type, origin.id);
      const label = esc(sourceLabel(origin, item?.title));
      if (!item) return `<li>${label}（当前目录暂无）</li>`;
      const id = esc(`packing-link-${key}:${origin.type}:${origin.id}:${origin.pieceIndex ?? ''}`);
      const outfit = origin.type === 'look' ? ` data-packing-look="${origin.id}"` : '';
      return `<li><a id="${id}"${outfit} href="${esc(item.href)}">${label}</a></li>`;
    }

    function rowMarkup(entry) {
      const key = esc(entry.key);
      const checked = queuedChecks.get(entry.key)?.checked ?? entry.checked;
      return `<li class="packing-entry" data-packing-row="${key}">
        <label class="packing-entry-check"><input type="checkbox" id="packing-check-${key}" data-packing-check="${key}"${checked ? ' checked' : ''}> <span>${esc(entry.title)}</span></label>
        <ul class="packing-entry-sources" aria-label="来源">${entry.sources.map(origin => sourceMarkup(origin, entry.key)).join('')}</ul>
      </li>`;
    }

    function updateMergeChoices() {
      const rows = snapshot?.entries || [];
      mergeForm.hidden = rows.length < 2;
      const choices = rows.map(entry => {
        const first = entry.sources[0];
        const origin = sourceLabel(first, resolveEntry(first.type, first.id)?.title);
        const more = entry.sources.length > 1 ? `等 ${entry.sources.length} 处` : '';
        return {value:entry.key, label:`${entry.title}（${origin}${more}）`};
      });
      options(target, choices, '选择保留的项目');
      options(from, choices.filter(item => item.value !== target.value), '选择要并入的项目');
    }

    function renderSnapshot() {
      const active = document.activeElement;
      const row = entries.contains(active) ? active.closest('[data-packing-row]') : null;
      const mergeTarget = target.value;
      current.hidden = !snapshot;
      name.textContent = snapshot?.title || '';
      entries.innerHTML = snapshot?.entries.map(rowMarkup).join('') || '<li class="packing-empty">没有可打包的项目。</li>';
      missing.hidden = !snapshot?.missing.length;
      missing.textContent = missing.hidden ? '' : `生成时无法读取的来源：${snapshot.missing.map(origin => sourceLabel(origin)).join('、')}。`;
      updateMergeChoices();
      if (page.hidden) return;
      if (row || (current.hidden && current.contains(active)) || (mergeForm.hidden && mergeForm.contains(active))) {
        const focus = (row && byId(active.id)) || byId(`packing-check-${mergeTarget}`) || (source.disabled ? page : source);
        if (focus === page) page.tabIndex = -1;
        focus.focus({preventScroll:true});
      }
    }

    async function render() {
      const sequence = ++renderSequence;
      const [localLists, currentSnapshot] = await Promise.allSettled([lists.load(), store.load()]);
      if (sequence !== renderSequence) return false;

      const listError = localLists.status === 'rejected';
      const snapshotError = currentSnapshot.status === 'rejected';
      const available = listError ? [] : localLists.value.map(list => ({value:list.id, label:list.name}));
      const placeholder = listError ? '无法读取搭配清单' : available.length ? '请选择搭配清单' : '暂无搭配清单';
      options(source, available, placeholder);
      const submit = sourceForm.querySelector('button[type="submit"], button:not([type])');
      if (submit) submit.disabled = source.disabled;
      snapshot = snapshotError ? null : currentSnapshot.value;
      renderSnapshot();

      const message = [listError && localLists.reason.message, snapshotError && currentSnapshot.reason.message].filter(Boolean).join(' ');
      if (message || status.textContent === readMessage) status.textContent = message;
      readMessage = message;
      return true;
    }

    function change(action) {
      pending++;
      mutations = mutations.then(async () => {
        let message;
        let failed = false;
        try { message = await action(); }
        catch (error) { failed = true; message = error.message; }
        if (!page.hidden) {
          refreshPending = false;
          if (await render() && !page.hidden && message && (failed || !readMessage)) status.textContent = message;
        }
      }).finally(() => {
        pending--;
        if (refreshPending && !pending) {
          refreshPending = false;
          refresh();
        }
      });
    }

    sourceForm.addEventListener('submit', event => {
      event.preventDefault();
      const selected = source.value;
      if (!selected) {
        status.textContent = '请选择搭配清单。';
        return;
      }
      change(async () => {
        const [available, existing] = await Promise.all([lists.load(), store.load()]);
        const list = available.find(candidate => candidate.id === selected);
        if (!list) throw new Error('这份搭配清单已不存在。');
        const built = packing.buildEntries(list.entries, catalog());
        if (!built.entries.length && !built.missing.length) throw new Error('所选清单没有可打包的项目。');
        if (existing && !window.confirm(`用「${list.name}」重新生成打包清单？现有勾选和合并将被替换。`)) return '';
        await store.replace({listId:list.id, title:list.name, ...built});
        return '已生成打包清单。';
      });
    });

    clear.addEventListener('click', () => {
      change(async () => { await store.clear(); return '已清空打包清单。'; });
    });

    entries.addEventListener('change', event => {
      const checkbox = event.target.closest('[data-packing-check]');
      if (!checkbox) return;
      const {packingCheck: key} = checkbox.dataset;
      const selection = {checked: checkbox.checked};
      queuedChecks.set(key, selection);
      change(async () => {
        try { await store.setChecked(key, selection.checked); }
        finally { if (queuedChecks.get(key) === selection) queuedChecks.delete(key); }
      });
    });

    target.addEventListener('change', updateMergeChoices);
    mergeForm.addEventListener('submit', event => {
      event.preventDefault();
      const keep = target.value, combine = from.value;
      if (!keep || !combine || keep === combine) {
        status.textContent = '请选择两项不同的打包内容。';
        return;
      }
      change(async () => { await store.merge(keep, combine); return '已合并项目。'; });
    });

    function refresh() {
      if (page.hidden) return;
      if (pending) refreshPending = true;
      else void render();
    }
    lists.subscribe(refresh);
    store.subscribe(refresh);

    return {render};
  }

  window.WardrobePackingPage = {create};
})();
