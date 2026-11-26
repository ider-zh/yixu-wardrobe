(() => {
  'use strict';

  const databaseName = 'yixu:wardrobe-week-plan';
  const storeName = 'days';
  let updates = null;
  try { updates = new window.BroadcastChannel(databaseName); } catch {}

  function dateError() {
    return new RangeError('请输入有效日期。');
  }

  function dateKey(year, month, day) {
    if (!Number.isInteger(year) || year < 1 || year > 9999) throw dateError();
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function parseDate(key) {
    const parts = typeof key === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!parts || key.length !== 10) throw dateError();
    const [year, month, day] = parts.slice(1).map(Number);
    if (year < 1) throw dateError();
    const date = new Date(0);
    // setUTCFullYear treats 0001–0099 as written and avoids local time transitions.
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw dateError();
    return date;
  }

  function todayKey(date = new Date()) {
    try {
      return dateKey(Date.prototype.getFullYear.call(date), Date.prototype.getMonth.call(date) + 1, Date.prototype.getDate.call(date));
    } catch {
      throw dateError();
    }
  }

  function shiftDate(key, days) {
    if (!Number.isSafeInteger(days)) throw new RangeError('请输入整数天数。');
    const date = parseDate(key);
    date.setUTCDate(date.getUTCDate() + days);
    return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function weekDates(key) {
    const offset = (parseDate(key).getUTCDay() + 6) % 7;
    return Array.from({length: 7}, (_, day) => shiftDate(key, day - offset));
  }

  function storageError(writing) {
    return new Error(writing ? '无法在此浏览器中保存一周穿搭计划。' : '无法读取此浏览器中的一周穿搭计划。');
  }

  function openDatabase(writing) {
    return new Promise((resolve, reject) => {
      let request;
      try { request = window.indexedDB.open(databaseName, 1); }
      catch { reject(storageError(writing)); return; }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, {keyPath: 'date'});
      request.onblocked = () => { blocked = true; reject(storageError(writing)); };
      request.onerror = () => reject(storageError(writing));
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  async function transact(writing, action, onResult = value => value) {
    const database = await openDatabase(writing);
    try {
      return await new Promise((resolve, reject) => {
        let transaction, request, store;
        try {
          transaction = database.transaction(storeName, writing ? 'readwrite' : 'readonly');
          store = transaction.objectStore(storeName);
          request = action(store);
        } catch {
          reject(storageError(writing));
          return;
        }
        let result, failure;
        request.onsuccess = () => {
          try { result = onResult(request.result, store); }
          catch (error) { failure = error; transaction.abort(); }
        };
        transaction.onabort = () => reject(failure || storageError(writing));
        transaction.oncomplete = () => {
          if (writing) {
            try { updates?.postMessage(null); } catch {}
          }
          resolve(result);
        };
      });
    } finally {
      database.close();
    }
  }

  function validLookId(id) {
    return Number.isSafeInteger(id) && id > 0;
  }

  async function load() {
    const records = await transact(false, store => store.getAll());
    try {
      return records.map(({date, lookId}) => {
        parseDate(date);
        if (!validLookId(lookId)) throw new Error();
        return {date, lookId};
      });
    } catch {
      throw new Error('此浏览器中的一周穿搭计划数据无法识别。');
    }
  }

  async function assign(date, lookId) {
    parseDate(date);
    if (!validLookId(lookId)) throw new RangeError('请输入有效穿搭编号。');
    await transact(true, store => store.put({date, lookId}));
  }

  async function remove(date) {
    parseDate(date);
    await transact(true, store => store.delete(date));
  }

  async function mergeBackup(records) {
    for (const {date, lookId} of records) {
      parseDate(date);
      if (!validLookId(lookId)) throw new RangeError('请输入有效穿搭编号。');
    }
    return transact(true, store => store.getAllKeys(), (keys, store) => {
      const occupied = new Set(keys);
      let additions = 0;
      for (const {date, lookId} of records) {
        if (occupied.has(date)) continue;
        store.add({date, lookId});
        occupied.add(date);
        additions++;
      }
      return additions;
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('请选择有效的更新监听函数。');
    const notify = () => listener();
    updates?.addEventListener('message', notify);
    return () => updates?.removeEventListener('message', notify);
  }

  window.WardrobeWeekPlan = {todayKey, shiftDate, weekDates, load, assign, remove, subscribe, mergeBackup};
})();
