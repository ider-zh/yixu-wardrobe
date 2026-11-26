(() => {
  'use strict';

  const databaseName = 'yixu-tryon';
  const photos = 'photos';
  const jobs = 'jobs';
  const settings = 'settings';
  const preferencesKey = 'local';
  const firstGeneration = 1;
  const referenceFields = ['reference_asset_id', 'reference_source_url', 'reference_shot_index'];
  const jobFields = [
    'status', 'look_id', 'edition', 'shot_index', 'pose_mode', 'created_at', 'original_expires_at',
    'queue_position', 'error_code', 'error_message', 'look_title', ...referenceFields,
  ];
  let connection;
  let channel;

  try {
    channel = new window.BroadcastChannel(databaseName);
  } catch {
    // A browser can support IndexedDB without cross-tab notifications.
  }

  function openDatabase() {
    if (connection) return connection;

    let blocked = false;
    const opening = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(databaseName, 2);
      request.onupgradeneeded = event => {
        const db = request.result;
        if (event.oldVersion < 1) {
          db.createObjectStore(photos, {keyPath: 'id'});
          db.createObjectStore(jobs, {keyPath: 'id'});
        }
        if (event.oldVersion < 2) {
          db.createObjectStore(settings).put({
            autoCacheResults: true,
            photoGeneration: firstGeneration,
            resultGeneration: firstGeneration,
          }, preferencesKey);
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Local try-on storage is blocked by another tab.'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        const forgetConnection = () => {
          if (connection === opening) connection = null;
        };
        db.onclose = forgetConnection;
        db.onversionchange = () => {
          db.close();
          forgetConnection();
        };
        resolve(db);
      };
    });
    connection = opening;
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    return opening;
  }

  async function transactionOn(storeNames, mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      let result;
      const changedStores = new Set();
      transaction.onabort = () => reject(transaction.error || new Error('Local try-on storage was interrupted.'));
      transaction.oncomplete = () => {
        for (const store of changedStores) {
          try { channel?.postMessage(store); } catch { /* The write is already committed. */ }
        }
        resolve(result);
      };
      try {
        run(transaction, (value, ...stores) => {
          result = value;
          stores.forEach(store => changedStores.add(store));
        });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  function transact(storeName, mode, run) {
    return transactionOn(storeName, mode, (transaction, finish) => {
      if (mode === 'readwrite') finish(false);
      run(transaction.objectStore(storeName), value => {
        if (mode === 'readwrite' && value) finish(true, storeName);
        else if (mode === 'readonly') finish(value);
      });
    });
  }

  function localSettings(transaction, read) {
    const store = transaction.objectStore(settings);
    const request = store.get(preferencesKey);
    request.onsuccess = () => {
      const {autoCacheResults, photoGeneration, resultGeneration} = request.result || {};
      const validGeneration = generation => Number.isSafeInteger(generation) && generation >= firstGeneration;
      if (typeof autoCacheResults !== 'boolean' || !validGeneration(photoGeneration) || !validGeneration(resultGeneration)) {
        transaction.abort();
        return;
      }
      try { read({autoCacheResults, photoGeneration, resultGeneration}, store); }
      catch { transaction.abort(); }
    };
  }

  function getLocalSettings() {
    return transactionOn(settings, 'readonly', (transaction, finish) => {
      localSettings(transaction, preferences => finish(preferences));
    });
  }

  function nextGeneration(generation) {
    const next = generation + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError('Local try-on storage generation exhausted.');
    return next;
  }

  function generationMatches(permission, current) {
    // An unscoped legacy caller only belongs to the initial generation.
    return (permission === undefined ? firstGeneration : permission) === current;
  }

  function list(storeName) {
    return transact(storeName, 'readonly', (store, result) => {
      const request = store.getAll();
      request.onsuccess = () => result(request.result);
    });
  }

  function update(store, id, select, changed) {
    // Read and write in the same transaction so other tabs cannot revive a deletion.
    const request = store.get(id);
    request.onsuccess = () => {
      const next = select(request.result);
      if (next) {
        store.put(next);
        changed(true);
      }
    };
  }

  function validId(id) {
    return typeof id === 'string' && id.length > 0;
  }

  async function putPhoto({id, blob, createdAt}, permission) {
    if (!validId(id) || !(blob instanceof Blob) || !blob.size || !Number.isFinite(createdAt)) {
      throw new TypeError('Invalid local try-on photo.');
    }
    return transactionOn([photos, settings], 'readwrite', (transaction, finish) => {
      localSettings(transaction, preferences => {
        if (!generationMatches(permission, preferences.photoGeneration)) { finish(false); return; }
        // Keep the original bytes and MIME type without storing the local filename.
        transaction.objectStore(photos).put({id, blob: blob.slice(0, blob.size, blob.type), createdAt});
        finish(true, photos);
      });
    });
  }

  function frozenReference(record) {
    const id = record?.reference_asset_id;
    const source = record?.reference_source_url;
    const shot = record?.reference_shot_index;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
      || source !== `/api/content/assets/${id}` || !Number.isInteger(shot) || shot < 1 || shot > 9
      || shot !== record.shot_index) return null;
    return {reference_asset_id:id, reference_source_url:source, reference_shot_index:shot};
  }

  async function putJobs(records) {
    const snapshots = new Map();
    for (const record of records) {
      const {id, updatedAt} = record;
      if (!validId(id) || !Number.isFinite(updatedAt)) throw new TypeError('Invalid local try-on record.');
      const previous = snapshots.get(id);
      if (previous && previous.updatedAt > updatedAt) continue;
      const snapshot = {id, updatedAt};
      const reference = frozenReference(previous) || frozenReference(record);
      for (const key of jobFields) {
        const value = referenceFields.includes(key) ? reference?.[key] : record[key];
        if (typeof value === 'string' || Number.isFinite(value) || value === null) snapshot[key] = value;
      }
      if (reference) snapshot.shot_index = reference.reference_shot_index;
      snapshots.set(id, snapshot);
    }
    if (!snapshots.size) return false;
    return transact(jobs, 'readwrite', (store, changed) => {
      for (const snapshot of snapshots.values()) {
        update(store, snapshot.id, current => {
          if (current?.deleted || current?.updatedAt > snapshot.updatedAt) return;
          const reference = frozenReference(current);
          const next = reference ? {...snapshot, ...reference, shot_index:reference.reference_shot_index} : snapshot;
          return current?.cachedImage ? {...next, cachedImage: current.cachedImage} : next;
        }, changed);
      }
    });
  }

  async function saveImage(id, blob, permission) {
    if (!validId(id) || !(blob instanceof Blob) || !blob.size) throw new TypeError('Invalid local try-on result.');
    return transactionOn([jobs, settings], 'readwrite', (transaction, finish) => {
      finish(false);
      localSettings(transaction, preferences => {
        if (!preferences.autoCacheResults || !generationMatches(permission, preferences.resultGeneration)) return;
        update(transaction.objectStore(jobs), id, current => {
          if (current && !current.deleted && !current.cachedImage) return {...current, cachedImage: blob};
        }, () => finish(true, jobs));
      });
    });
  }

  function clearPhotos() {
    return transactionOn([photos, settings], 'readwrite', (transaction, finish) => {
      localSettings(transaction, (preferences, preferencesStore) => {
        preferencesStore.put({...preferences, photoGeneration:nextGeneration(preferences.photoGeneration)}, preferencesKey);
        const store = transaction.objectStore(photos);
        const request = store.count();
        request.onsuccess = () => finish(request.result, photos, settings);
        store.clear();
      });
    });
  }

  function clearResultImages() {
    return transactionOn([jobs, settings], 'readwrite', (transaction, finish) => {
      localSettings(transaction, (preferences, preferencesStore) => {
        preferencesStore.put({
          ...preferences,
          autoCacheResults:false,
          resultGeneration:nextGeneration(preferences.resultGeneration),
        }, preferencesKey);
        let count = 0;
        const request = transaction.objectStore(jobs).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { finish(count, jobs, settings); return; }
          const record = cursor.value;
          if (Object.hasOwn(record, 'cachedImage')) {
            if (record.cachedImage instanceof Blob && record.cachedImage.size) count++;
            delete record.cachedImage;
            cursor.update(record);
          }
          cursor.continue();
        };
      });
    });
  }

  async function setAutoCacheResults(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid local try-on cache preference.');
    return transactionOn(settings, 'readwrite', (transaction, finish) => {
      localSettings(transaction, (preferences, store) => {
        if (preferences.autoCacheResults === enabled) { finish(false); return; }
        store.put({
          ...preferences,
          autoCacheResults:enabled,
          resultGeneration:nextGeneration(preferences.resultGeneration),
        }, preferencesKey);
        finish(true, settings);
      });
    });
  }

  window.WardrobeTryOnStorage = {
    getLocalSettings,
    photoWritePermission: () => getLocalSettings().then(value => value.photoGeneration),
    resultCachePermission: () => getLocalSettings().then(value => value.autoCacheResults ? value.resultGeneration : null),
    clearPhotos,
    clearResultImages,
    setAutoCacheResults,
    listPhotos: () => list(photos),
    putPhoto,
    deletePhoto(id) {
      return transact(photos, 'readwrite', (store, changed) => {
        const request = store.getKey(id);
        request.onsuccess = () => {
          if (request.result !== undefined) {
            store.delete(id);
            changed(true);
          }
        };
      });
    },
    listJobs: () => list(jobs),
    putJobs,
    saveImage,
    deleteJob(id, pending) {
      return transact(jobs, 'readwrite', (store, changed) => {
        update(store, id, current => {
          if (current?.deleted && (!current.pending || pending)) return;
          return {id, deleted: true, pending: Boolean(pending)};
        }, changed);
      });
    },
    confirmDeletion(id) {
      return transact(jobs, 'readwrite', (store, changed) => {
        update(store, id, current => {
          if (current?.deleted && current.pending) return {...current, pending: false};
        }, changed);
      });
    },
    onChange(callback) {
      const handleMessage = event => {
        if (event.data === photos || event.data === jobs || event.data === settings) callback(event.data);
      };
      channel?.addEventListener('message', handleMessage);
      return () => channel?.removeEventListener('message', handleMessage);
    },
  };
})();
