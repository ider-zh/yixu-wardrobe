(() => {
  'use strict';

  const databaseName = 'yixu:wardrobe-favorites';
  const storeName = 'favorites';
  const lookId = id => Number.isSafeInteger(id) && id > 0;
  const productId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

  function storageError(writing) {
    return new Error(writing ? '无法在此浏览器中保存收藏。' : '无法读取此浏览器中的收藏。');
  }

  function databaseError(error, writing) {
    const failure=storageError(writing);
    if (['SecurityError','NotSupportedError','InvalidStateError'].includes(error?.name)) {
      failure.code='indexeddb-unavailable';
    }
    return failure;
  }

  function invalid() {
    return new Error('现有收藏数据无法识别。');
  }

  function openDatabase(writing) {
    return new Promise((resolve, reject) => {
      let request;
      try {
        if (!window.indexedDB) throw new DOMException('', 'NotSupportedError');
        request = window.indexedDB.open(databaseName, 1);
      }
      catch (error) { reject(databaseError(error, writing)); return; }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onblocked = () => { blocked = true; reject(storageError(writing)); };
      request.onerror = () => reject(databaseError(request.error, writing));
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  function transact(database, key, mode, writing, action) {
    return new Promise((resolve, reject) => {
      let transaction, store, request;
      try {
        transaction = database.transaction(storeName, mode);
        store = transaction.objectStore(storeName);
        request = store.get(key);
      } catch { reject(storageError(writing)); return; }
      let result, failure;
      transaction.onabort = () => reject(failure || storageError(writing));
      transaction.oncomplete = () => resolve(result);
      request.onsuccess = () => {
        try { result = action(request.result, store); }
        catch (error) { failure = error; transaction.abort(); }
      };
    });
  }

  function readLegacy(key, valid) {
    let raw;
    try { raw = window.localStorage.getItem(key); }
    catch { throw storageError(false); }
    if (raw === null) return [];
    let entries;
    try { entries = JSON.parse(raw); }
    catch { throw invalid(); }
    if (!Array.isArray(entries)) throw invalid();
    return [...new Set(entries.filter(valid))];
  }

  function create({lookKey, productKey}) {
    const domains = new Map([
      ['look', {key:lookKey, valid:lookId}],
      ['product', {key:productKey, valid:productId}],
    ]);
    const listeners = new Set();
    let channel = null;
    try { channel = new window.BroadcastChannel(databaseName); } catch {}

    function notify(kind) {
      for (const listener of listeners) queueMicrotask(() => listener(kind));
    }

    channel?.addEventListener('message', ({data}) => {
      for (const [kind, {key}] of domains) {
        if (key === data) notify(kind);
      }
    });

    function domain(kind) {
      const selected = domains.get(kind);
      if (!selected || typeof selected.key !== 'string' || !selected.key) throw invalid();
      return selected;
    }

    async function access(kind, change) {
      const {key, valid} = domain(kind);
      const database = await openDatabase(!!change);
      try {
        // Migrate and modify within the same transaction across tabs and backup imports.
        const result = await transact(database, key, 'readwrite', !!change, (saved, store) => {
          const migrated = saved === undefined;
          const entries = migrated ? readLegacy(key, valid) : saved;
          if (!Array.isArray(entries) || !Array.from(entries).every(valid)) throw invalid();
          const next = change ? change(entries) : entries;
          const changed = next !== entries;
          if (migrated || changed) store.put(next, key);
          return {entries:next, changed, migrated};
        });
        if (result.changed || (result.migrated && result.entries.length)) {
          // Re-read committed data so mirroring a slow earlier write cannot use its old result.
          try {
            await transact(database, key, 'readonly', false, committed => {
              window.localStorage.setItem(key, JSON.stringify(committed));
            });
          } catch {}
          if (result.changed) {
            notify(kind);
            try { channel?.postMessage(key); } catch {}
          }
        }
        return result;
      } finally {
        database.close();
      }
    }

    async function load(kind) {
      return (await access(kind)).entries;
    }

    async function set(kind, id, enabled) {
      if (!domain(kind).valid(id) || typeof enabled !== 'boolean') throw invalid();
      return (await access(kind, entries => {
        if (entries.includes(id) === enabled) return entries;
        return enabled ? [...entries, id] : entries.filter(entry => entry !== id);
      })).changed;
    }

    async function merge(kind, ids) {
      const {valid} = domain(kind);
      if (!Array.isArray(ids)) throw invalid();
      const incoming = [...new Set(ids)];
      if (!incoming.every(valid)) throw invalid();
      if (!incoming.length) return false;
      return (await access(kind, entries => {
        const next = [...new Set([...entries, ...incoming])];
        return next.length === entries.length ? entries : next;
      })).changed;
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('收藏的监听器必须是函数。');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    return {load, set, merge, subscribe};
  }

  window.WardrobeFavorites = {create};
})();
