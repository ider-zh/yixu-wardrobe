(() => {
  'use strict';

  function create({escapeText, resolveEntry}) {
    const byId = id => document.getElementById(id);
    const store = window.WardrobeLists;
    const page = byId('wardrobe-list-page');
    const createForm = byId('wardrobe-list-create');
    const panels = byId('wardrobe-list-panels');
    const status = byId('wardrobe-list-status');
    const picker = byId('wardrobe-list-picker');
    const pickerForm = byId('wardrobe-list-picker-create');
    const choices = byId('wardrobe-list-picker-choices');
    const pickerStatus = byId('wardrobe-list-picker-status');
    const closePicker = byId('close-wardrobe-list-picker');
    const nameInput = form => form?.querySelector?.('[name="name"]');
    if (!store || !page || !panels?.contains || !status || !picker?.showModal || !choices?.contains
      || !pickerStatus || !closePicker || !nameInput(createForm) || !nameInput(pickerForm)) {
      return {render() {}, choose() {}};
    }

    let selected = null;
    let opener = null;
    let lists = [];
    let readFailed = false;
    let renderGeneration = 0;
    const pending = new WeakMap();

    function entryMarkup(listId, entry) {
      const entryId = escapeText(entry.id);
      const controlId = `${listId}:${entry.type}:${entryId}`;
      const item = resolveEntry(entry.type, entry.id);
      const type = entry.type === 'look' ? '穿搭' : '单品';
      const title = escapeText(item?.title || `${type} ${entry.id}（当前目录暂无）`);
      const content = item ? `<a id="wardrobe-list-link-${controlId}" href="${escapeText(item.href)}">${title}</a>` : `<span>${title}</span>`;
      return `<li class="wardrobe-list-entry">
        <span class="wardrobe-list-entry-type">${type}</span>
        ${content}
        <button type="button" id="wardrobe-list-remove-${controlId}" data-list-remove="${listId}"
          data-entry-type="${entry.type}" data-entry-id="${entryId}" aria-label="移除 ${title}">移除</button>
      </li>`;
    }

    function listMarkup(list, openDetails) {
      const id = escapeText(list.id);
      const name = escapeText(list.name);
      const editId = `wardrobe-list-edit-${id}`;
      const open = openDetails.has(editId) ? ' open' : '';
      const entries = list.entries.length
        ? `<ul class="wardrobe-list-entries">${list.entries.map(entry => entryMarkup(id, entry)).join('')}</ul>`
        : '<p class="wardrobe-list-empty">这份清单还没有穿搭或单品。</p>';
      return `<section class="wardrobe-list-group" aria-labelledby="wardrobe-list-name-${id}">
        <div class="wardrobe-list-heading">
          <h2 id="wardrobe-list-name-${id}">${name}</h2>
          <button type="button" id="wardrobe-list-delete-${id}" data-list-delete="${id}" aria-label="删除清单 ${name}">删除清单</button>
        </div>
        ${entries}
        <details class="wardrobe-list-rename" id="${editId}"${open}>
          <summary id="wardrobe-list-rename-${id}" aria-label="改名 ${name}">改名</summary>
          <form data-list-rename="${id}">
            <label for="wardrobe-list-name-input-${id}">新名称</label>
            <input id="wardrobe-list-name-input-${id}" name="name" type="text" value="${name}" required>
            <button id="wardrobe-list-save-${id}" type="submit">保存名称</button>
          </form>
        </details>
      </section>`;
    }

    function renderChoices() {
      if (!selected) return;
      const item = resolveEntry(selected.type, selected.id);
      if (!item) {
        if (picker.open) picker.close();
        return;
      }
      const activeId = choices.contains(document.activeElement) ? document.activeElement.id : '';
      const options = lists.map(list => {
        const id = escapeText(list.id);
        const added = list.entries.some(entry => entry.type === selected.type && entry.id === selected.id);
        const disabled = added ? ' aria-disabled="true"' : '';
        return `<button type="button" class="wardrobe-list-picker-option" id="wardrobe-list-choice-${id}" data-list-choice="${id}"${disabled}>
          <span>${escapeText(list.name)}</span><span>${added ? '已加入' : '加入'}</span>
        </button>`;
      }).join('');
      choices.innerHTML = `<p class="wardrobe-list-picker-item">${escapeText(item.title)}</p>${options || '<p class="wardrobe-list-empty">先新建一份清单。</p>'}`;
      if (activeId) (byId(activeId) || nameInput(pickerForm)).focus();
    }

    async function refresh(beforeUpdate) {
      const generation = ++renderGeneration;
      let nextLists;
      try {
        nextLists = await store.load();
      } catch (error) {
        if (generation !== renderGeneration) return false;
        readFailed = true;
        lists = [];
        panels.replaceChildren();
        choices.replaceChildren();
        showError(status, error);
        showError(pickerStatus, error);
        return false;
      }
      if (generation !== renderGeneration) return false;
      const keepFocus = beforeUpdate?.();
      lists = nextLists;
      if (readFailed) {
        status.textContent = '';
        pickerStatus.textContent = '';
        readFailed = false;
      }
      const active = panels.contains(document.activeElement) ? document.activeElement : null;
      const openDetails = new Set([...panels.querySelectorAll('details[open]')].map(detail => detail.id));
      panels.innerHTML = lists.map(list => listMarkup(list, openDetails)).join('')
        || '<p class="wardrobe-list-empty">还没有清单。可以为一次出门计划新建一份。</p>';
      if (active?.id && !page.hidden) {
        const next = byId(active.id) || nameInput(createForm);
        if (active.matches('input') && next.id === active.id) next.value = active.value;
        next.focus({preventScroll:true});
      }
      renderChoices();
      return !!keepFocus;
    }

    function render() {
      return refresh();
    }

    function showError(region, error) {
      region.textContent = error?.message || '无法保存搭配清单。';
    }

    async function mutate(scope, key, region, action, complete) {
      let actions = pending.get(scope);
      if (!actions) {
        actions = new Set();
        pending.set(scope, actions);
      }
      if (actions.has(key)) return;
      actions.add(key);
      const active = document.activeElement;
      const hash = window.location.hash;
      const inScope = () => window.location.hash === hash
        && (scope === page ? !page.hidden && !picker.open : picker.open && selected === scope);
      try {
        const result = await action();
        const keepFocus = await refresh(() => document.activeElement === active || (active?.id && document.activeElement?.id === active.id));
        if (!readFailed && inScope()) complete(result, keepFocus);
      } catch (error) {
        if (inScope()) showError(region, error);
      } finally {
        actions.delete(key);
      }
    }

    function createList(form, region, afterCreate) {
      form.addEventListener('submit', event => {
        event.preventDefault();
        const input = nameInput(form);
        const submitted = input.value;
        const scope = form === pickerForm ? selected : page;
        if (!scope) return;
        mutate(scope, form.id, region, () => store.create(submitted), (id, keepFocus) => {
          if (input.value === submitted) {
            input.value = '';
            if (keepFocus) afterCreate(id);
          }
          region.textContent = '已新建清单。';
        });
      });
    }

    createList(createForm, status, () => nameInput(createForm).focus());
    createList(pickerForm, pickerStatus, id => byId(`wardrobe-list-choice-${id}`)?.focus());

    panels.addEventListener('submit', event => {
      const form = event.target.closest('[data-list-rename]');
      if (!form) return;
      event.preventDefault();
      const id = form.dataset.listRename;
      const submitted = nameInput(form).value;
      mutate(page, `rename:${id}`, status, () => store.rename(id, submitted), (_, keepFocus) => {
        const details = byId(`wardrobe-list-edit-${id}`);
        const input = byId(`wardrobe-list-name-input-${id}`);
        if (keepFocus && details && (input.value === submitted || input.value === submitted.trim())) {
          const list = lists.find(item => item.id === id);
          if (list) input.value = list.name;
          details.open = false;
          details.querySelector('summary').focus({preventScroll:true});
        }
        status.textContent = '已保存清单名称。';
      });
    });

    panels.addEventListener('click', event => {
      const removeEntry = event.target.closest('[data-list-remove]');
      const removeList = event.target.closest('[data-list-delete]');
      if (removeEntry) {
        const {listRemove, entryType, entryId} = removeEntry.dataset;
        const row = removeEntry.closest('li');
        const neighbor = row.nextElementSibling || row.previousElementSibling;
        const nextId = neighbor?.querySelector('[data-list-remove]')?.id;
        mutate(page, removeEntry.id, status, () => store.remove(listRemove, entryType, entryType === 'look' ? Number(entryId) : entryId), (_, keepFocus) => {
          if (keepFocus) (byId(nextId) || byId(`wardrobe-list-rename-${listRemove}`))?.focus({preventScroll:true});
          status.textContent = '已从清单移除。';
        });
      } else if (removeList) {
        const id = removeList.dataset.listDelete;
        const position = lists.findIndex(list => list.id === id);
        const list = lists[position];
        if (!list || pending.get(page)?.has(removeList.id) || !window.confirm(`删除清单「${list.name}」？`)) return;
        mutate(page, removeList.id, status, () => store.removeList(id), (_, keepFocus) => {
          const next = lists[position] || lists[position - 1];
          if (keepFocus) (byId(`wardrobe-list-delete-${next?.id}`) || nameInput(createForm)).focus({preventScroll:true});
          status.textContent = '已删除清单。';
        });
      }
    });

    choices.addEventListener('click', event => {
      const option = event.target.closest('[data-list-choice]');
      if (!selected || !option || option.getAttribute('aria-disabled') === 'true') return;
      const scope = selected;
      mutate(scope, option.id, pickerStatus, () => store.add(option.dataset.listChoice, scope.type, scope.id), (_, keepFocus) => {
        if (keepFocus) byId(option.id)?.focus();
        pickerStatus.textContent = '已加入清单。';
      });
    });

    closePicker.addEventListener('click', () => picker.close());
    picker.addEventListener('close', () => {
      if (picker.open) return;
      selected = null;
      const target = opener?.isConnected ? opener : opener?.id ? byId(opener.id) : null;
      if (target && !target.closest('[hidden]')) target.focus({preventScroll:true});
      opener = null;
    });
    store.subscribe(render);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (!page.hidden || picker.open)) render();
    });

    function choose(type, id, trigger=document.activeElement) {
      if (!resolveEntry(type, id)) return;
      if (!picker.open) opener = trigger;
      const choice = {type, id};
      selected = choice;
      pickerStatus.textContent = '';
      choices.replaceChildren();
      const input = nameInput(pickerForm);
      input.value = '';
      if (!picker.open) picker.showModal();
      input.focus();
      render().then(() => {
        if (picker.open && selected === choice && document.activeElement === input && !input.value && !readFailed) {
          choices.querySelector('[data-list-choice]:not([aria-disabled])')?.focus();
        }
      });
    }

    return {render, choose};
  }

  window.WardrobeListPage = {create};
})();
