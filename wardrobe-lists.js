(() => {
  'use strict';

  const storageKey = 'yixu:wardrobe-lists:v1';
  const token = /^[A-Za-z0-9_-]+$/;

  function isEntry(type, id) {
    return (type === 'look' && Number.isSafeInteger(id) && id > 0)
      || (type === 'product' && typeof id === 'string' && token.test(id));
  }

  function load() {
    let raw;
    try {
      raw = window.localStorage.getItem(storageKey);
    } catch {
      throw new Error('无法读取此浏览器中的搭配清单。');
    }
    if (raw === null) return [];

    try {
      const lists = JSON.parse(raw);
      if (!Array.isArray(lists)) throw new Error();
      const ids = new Set();
      return lists.map(list => {
        if (!list || typeof list.id !== 'string' || !token.test(list.id) || ids.has(list.id)
          || typeof list.name !== 'string' || !list.name.trim() || !Array.isArray(list.entries)) {
          throw new Error();
        }
        ids.add(list.id);
        const entryKeys = new Set();
        const entries = [];
        for (const entry of list.entries) {
          if (!entry || !isEntry(entry.type, entry.id)) throw new Error();
          const {type, id} = entry;
          const key = `${type}:${id}`;
          if (entryKeys.has(key)) continue;
          entryKeys.add(key);
          entries.push({type, id});
        }
        return {id:list.id, name:list.name, entries};
      });
    } catch {
      throw new Error('此浏览器中的搭配清单数据无法识别。');
    }
  }

  function writeLists(lists) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(lists));
    } catch {
      throw new Error('无法在此浏览器中保存搭配清单。');
    }
  }

  function listName(name) {
    const trimmed = typeof name === 'string' && name.trim();
    if (!trimmed) throw new Error('请输入搭配清单名称。');
    return trimmed;
  }

  function findList(lists, id) {
    const list = lists.find(item => item.id === id);
    if (!list) throw new Error('这份搭配清单已不存在。');
    return list;
  }

  function create(name) {
    const trimmedName = listName(name);
    const lists = load();
    const base = window.crypto?.randomUUID?.() || `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let id = base;
    for (let suffix = 1; lists.some(list => list.id === id); suffix++) id = `${base}-${suffix}`;
    lists.push({id, name:trimmedName, entries:[]});
    writeLists(lists);
    return id;
  }

  function rename(listId, name) {
    const lists = load();
    findList(lists, listId).name = listName(name);
    writeLists(lists);
  }

  function removeList(listId) {
    const lists = load();
    const list = findList(lists, listId);
    writeLists(lists.filter(item => item !== list));
  }

  function add(listId, type, id) {
    if (!isEntry(type, id)) throw new Error('这件内容无法加入搭配清单。');
    const lists = load();
    const {entries} = findList(lists, listId);
    if (entries.some(item => item.type === type && item.id === id)) return;
    entries.push({type, id});
    writeLists(lists);
  }

  function remove(listId, type, id) {
    if (!isEntry(type, id)) throw new Error('这件内容无法从搭配清单中移除。');
    const lists = load();
    const list = findList(lists, listId);
    const entries = list.entries.filter(item => item.type !== type || item.id !== id);
    if (entries.length === list.entries.length) return;
    list.entries = entries;
    writeLists(lists);
  }

  window.WardrobeLists = {storageKey, load, create, rename, removeList, add, remove};
})();
