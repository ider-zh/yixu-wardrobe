(() => {
  'use strict';

  const databaseName = 'yixu:wardrobe-packing';
  const storeName = 'packing';
  const activeKey = 'active';
  const legacyEpoch = 'legacy';
  const token = /^[A-Za-z0-9_-]+$/;
  const listeners = new Set();
  let epochSequence = 0;
  let channel = null;
  try { channel = new window.BroadcastChannel(databaseName); } catch {}

  function notify() {
    for (const listener of listeners) queueMicrotask(listener);
  }

  channel?.addEventListener('message', notify);

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('打包清单的监听器必须是函数。');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const isId = value => typeof value === 'string' && token.test(value);
  const isIndex = value => Number.isSafeInteger(value) && value > 0;
  const isTitle = value => typeof value === 'string' && value.trim().length > 0;

  function hasFields(value, fields) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  }

  function validKey(key) {
    if (typeof key !== 'string') return false;
    const product = /^product:([A-Za-z0-9_-]+)$/.exec(key);
    const look = /^look:([1-9]\d*):([1-9]\d*)$/.exec(key);
    return !!product || (!!look && isIndex(Number(look[1])) && isIndex(Number(look[2])));
  }

  function invalid() {
    return new Error('无法识别打包清单数据。');
  }

  function validateSources(values, packingRow) {
    if (!Array.isArray(values) || (packingRow && !values.length)) throw invalid();
    const seen = new Set();
    const sources = [];
    for (const value of values) {
      const type = value?.type;
      const id = value?.id;
      const isLook = type === 'look' && isIndex(id);
      const isProduct = type === 'product' && isId(id);
      if (!isLook && !isProduct) throw invalid();
      const hasPiece = packingRow && isLook;
      const fields = hasPiece ? ['type', 'id', 'pieceIndex'] : ['type', 'id'];
      const pieceIndex = value.pieceIndex;
      const key = `${type}:${id}:${pieceIndex ?? ''}`;
      if (!hasFields(value, fields) || (hasPiece && !isIndex(pieceIndex)) || seen.has(key)) throw invalid();
      seen.add(key);
      sources.push(hasPiece ? {type, id, pieceIndex} : {type, id});
    }
    return sources;
  }

  function validateSnapshot(value) {
    if (!hasFields(value, ['listId', 'title', 'entries', 'missing']) || !isId(value.listId)
      || !isTitle(value.title) || !Array.isArray(value.entries)) throw invalid();

    const entries = [];
    const keys = new Set();
    for (const entry of value.entries) {
      if (!hasFields(entry, ['key', 'title', 'sources', 'checked']) || !validKey(entry.key)
        || !isTitle(entry.title) || typeof entry.checked !== 'boolean' || keys.has(entry.key)) throw invalid();
      keys.add(entry.key);
      entries.push({key:entry.key, title:entry.title, sources:validateSources(entry.sources, true), checked:entry.checked});
    }
    return {listId:value.listId, title:value.title, entries, missing:validateSources(value.missing, false)};
  }

  function storageError(mode) {
    return new Error(mode === 'readonly' ? '无法读取此浏览器中的打包清单。' : '无法在此浏览器中更新打包清单。');
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

  function readRecord(value) {
    if (value === undefined) return {epoch:null, snapshot:null};
    if (hasFields(value, ['epoch', 'snapshot'])) {
      if (!isId(value.epoch)) throw invalid();
      return {epoch:value.epoch, snapshot:validateSnapshot(value.snapshot)};
    }
    return {epoch:legacyEpoch, snapshot:validateSnapshot(value)};
  }

  function loadVersioned() {
    return transact('readonly', store => store.get(activeKey), readRecord);
  }

  async function load() {
    return (await loadVersioned()).snapshot;
  }

  function writeCurrent(expectedEpoch, action) {
    return transact('readwrite', store => store.get(activeKey), (value, store) => {
      const current = readRecord(value);
      if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) {
        throw new Error('打包清单已更换，请按当前清单重新操作。');
      }
      action(current, store);
    });
  }

  async function replace(snapshot, expectedEpoch) {
    const verified = validateSnapshot(snapshot);
    const identity = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const record = {epoch:`epoch-${identity}-${++epochSequence}`, snapshot:verified};
    if (expectedEpoch === undefined) return transact('readwrite', store => store.put(record, activeKey));
    return writeCurrent(expectedEpoch, (_, store) => { store.put(record, activeKey); });
  }

  function update(expectedEpoch, change) {
    return writeCurrent(expectedEpoch, ({epoch, snapshot}, store) => {
      if (!snapshot) throw new Error('还没有打包清单。');
      store.put({epoch, snapshot:change(snapshot)}, activeKey);
    });
  }

  function findEntry(entries, key) {
    const entry = entries.find(row => row.key === key);
    if (!entry) throw new Error('这项打包内容已不存在。');
    return entry;
  }

  async function setChecked(key, checked, expectedEpoch) {
    if (!validKey(key) || typeof checked !== 'boolean') throw invalid();
    return update(expectedEpoch, snapshot => {
      findEntry(snapshot.entries, key).checked = checked;
      return snapshot;
    });
  }

  async function merge(targetKey, sourceKey, expectedEpoch) {
    if (!validKey(targetKey) || !validKey(sourceKey) || targetKey === sourceKey) throw invalid();
    return update(expectedEpoch, snapshot => {
      const entries = window.WardrobePacking.mergeEntries(snapshot.entries, targetKey, sourceKey);
      if (entries === snapshot.entries) throw new Error('这项打包内容已不存在。');
      return {...snapshot, entries};
    });
  }

  function clear(expectedEpoch) {
    if (expectedEpoch === undefined) return transact('readwrite', store => store.delete(activeKey));
    return writeCurrent(expectedEpoch, (_, store) => { store.delete(activeKey); });
  }

  window.WardrobePackingStore = {load, loadVersioned, replace, setChecked, merge, clear, subscribe, validateSnapshot};
})();
