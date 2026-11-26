(() => {
  'use strict';

  const databaseName = 'yixu:wardrobe-recent';
  const storeName = 'history';
  const historyKey = 'recent';
  const limit = 20;
  const listeners = new Set();
  let channel = null;
  try { channel = new window.BroadcastChannel(databaseName); } catch {}

  function notify() {
    for (const listener of listeners) queueMicrotask(listener);
  }

  channel?.addEventListener('message', notify);

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('最近浏览的监听器必须是函数。');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function validEntry(type, id) {
    return (type === 'look' && Number.isSafeInteger(id) && id > 0)
      || (type === 'product' && typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id));
  }

  function readEntries(entries) {
    if (entries === undefined) return [];
    const invalid = () => new Error('此浏览器中的最近浏览记录无法识别。');
    if (!Array.isArray(entries) || entries.length > limit) throw invalid();
    const seen = new Set();
    const verified = [];
    for (const entry of entries) {
      if (!entry || !validEntry(entry.type, entry.id)) throw invalid();
      const {type, id} = entry;
      const key = `${type}:${id}`;
      if (seen.has(key)) throw invalid();
      seen.add(key);
      verified.push({type, id});
    }
    return verified;
  }

  function storageError(mode) {
    return new Error(mode === 'readonly' ? '无法读取此浏览器中的最近浏览记录。' : '无法在此浏览器中更新最近浏览记录。');
  }

  function openDatabase(mode) {
    return new Promise((resolve, reject) => {
      let request;
      try { request = window.indexedDB.open(databaseName, 1); }
      catch { reject(storageError(mode)); return; }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onblocked = () => {
        blocked = true;
        reject(storageError(mode));
      };
      request.onerror = () => reject(storageError(mode));
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  async function transact(mode, requestFor, onResult = () => {}) {
    const database = await openDatabase(mode);
    try {
      return await new Promise((resolve, reject) => {
        let transaction, store, request;
        try {
          transaction = database.transaction(storeName, mode);
          store = transaction.objectStore(storeName);
          request = requestFor(store);
        } catch {
          reject(storageError(mode));
          return;
        }
        let result, failure;
        transaction.onabort = () => reject(failure || storageError(mode));
        transaction.oncomplete = () => {
          if (mode === 'readwrite') {
            notify();
            try { channel?.postMessage(null); } catch {}
          }
          resolve(result);
        };
        request.onsuccess = () => {
          try { result = onResult(request.result, store); }
          catch (error) { failure = error; transaction.abort(); }
        };
      });
    } finally {
      database.close();
    }
  }

  function load() {
    return transact('readonly', store => store.get(historyKey), readEntries);
  }

  async function remember(type, id) {
    if (!validEntry(type, id)) throw new Error('无法记录这项浏览内容。');
    return transact('readwrite', store => store.get(historyKey), (value, store) => {
      const remaining = readEntries(value).filter(entry => entry.type !== type || entry.id !== id);
      store.put([{type, id}, ...remaining].slice(0, limit), historyKey);
    });
  }

  function clear() {
    return transact('readwrite', store => store.delete(historyKey));
  }

  window.WardrobeRecent = {load, remember, clear, subscribe};
})();
