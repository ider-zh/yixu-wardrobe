(() => {
  'use strict';

  const storageKey = 'yixu:wardrobe-lists:v1';
  const databaseName = 'yixu:wardrobe-lists';
  const storeName = 'lists';
  let updates = null;
  try { updates = new window.BroadcastChannel(storageKey); } catch {}
  const token = /^[A-Za-z0-9_-]+$/;

  function isEntry(type, id) {
    return (type === 'look' && Number.isSafeInteger(id) && id > 0)
      || (type === 'product' && typeof id === 'string' && token.test(id));
  }

  function parseLists(lists) {
    try {
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

  function readLegacy() {
    let raw;
    try {
      raw = window.localStorage.getItem(storageKey);
    } catch {
      throw new Error('无法读取此浏览器中的旧搭配清单。');
    }
    if (raw === null) return {raw, lists:[]};

    let lists;
    try { lists = JSON.parse(raw); }
    catch { throw new Error('此浏览器中的搭配清单数据无法识别。'); }
    return {raw, lists:parseLists(lists)};
  }

  function clearLegacy(legacy) {
    if (legacy?.raw == null) return;
    try {
      if (window.localStorage.getItem(storageKey) === legacy.raw) window.localStorage.removeItem(storageKey);
    } catch {}
  }

  function storageError(writing) {
    return new Error(writing ? '无法在此浏览器中保存搭配清单。' : '无法读取此浏览器中的搭配清单。');
  }

  function openDatabase(writing) {
    return new Promise((resolve, reject) => {
      let request;
      try { request = window.indexedDB.open(databaseName, 1); }
      catch { reject(storageError(writing)); return; }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onblocked = () => {
        blocked = true;
        reject(storageError(writing));
      };
      request.onerror = () => reject(storageError(writing));
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  async function transact(operation, writing) {
    const database = await openDatabase(writing);
    try {
      return await new Promise((resolve, reject) => {
        let transaction, store, request;
        try {
          // Read and update the same record in one exclusive transaction across tabs.
          transaction = database.transaction(storeName, 'readwrite');
          store = transaction.objectStore(storeName);
          request = store.get(storageKey);
        } catch {
          reject(storageError(writing));
          return;
        }

        let result;
        let legacy;
        let validationError;
        transaction.onabort = () => reject(validationError || storageError(writing));
        transaction.oncomplete = () => {
          clearLegacy(legacy);
          if (writing) {
            try { updates?.postMessage(null); } catch {}
          }
          resolve(result);
        };
        request.onsuccess = () => {
          let lists;
          try {
            if (request.result === undefined) legacy = readLegacy();
            lists = legacy ? legacy.lists : parseLists(request.result);
            result = operation(lists);
          } catch (error) {
            validationError = error;
            transaction.abort();
            return;
          }
          if (legacy || writing) {
            try { store.put(lists, storageKey); }
            catch { transaction.abort(); }
          }
        };
      });
    } finally {
      database.close();
    }
  }

  function load() {
    return transact(lists => lists, false);
  }

  function update(action) {
    return transact(action, true);
  }

  function subscribe(listener) {
    updates?.addEventListener('message', listener);
    return () => updates?.removeEventListener('message', listener);
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

  async function create(name) {
    const trimmedName = listName(name);
    return update(lists => {
      const base = window.crypto?.randomUUID?.() || `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let id = base;
      for (let suffix = 1; lists.some(list => list.id === id); suffix++) id = `${base}-${suffix}`;
      lists.push({id, name:trimmedName, entries:[]});
      return id;
    });
  }

  async function rename(listId, name) {
    const trimmedName = listName(name);
    return update(lists => {
      findList(lists, listId).name = trimmedName;
    });
  }

  async function removeList(listId) {
    return update(lists => {
      const list = findList(lists, listId);
      lists.splice(lists.indexOf(list), 1);
    });
  }

  async function add(listId, type, id) {
    if (!isEntry(type, id)) throw new Error('这件内容无法加入搭配清单。');
    return update(lists => {
      const {entries} = findList(lists, listId);
      if (entries.some(item => item.type === type && item.id === id)) return;
      entries.push({type, id});
    });
  }

  async function remove(listId, type, id) {
    if (!isEntry(type, id)) throw new Error('这件内容无法从搭配清单中移除。');
    return update(lists => {
      const list = findList(lists, listId);
      const entries = list.entries.filter(item => item.type !== type || item.id !== id);
      if (entries.length === list.entries.length) return;
      list.entries = entries;
    });
  }

  window.WardrobeLists = {storageKey, load, create, rename, removeList, add, remove, subscribe};
})();
