(() => {
  'use strict';

  const databaseName = 'yixu-tryon';
  const photos = 'photos';
  const jobs = 'jobs';
  const jobFields = [
    'status', 'look_id', 'edition', 'shot_index', 'pose_mode', 'created_at', 'original_expires_at',
    'queue_position', 'error_code', 'error_message', 'look_title',
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
      const request = window.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(photos, {keyPath: 'id'});
        db.createObjectStore(jobs, {keyPath: 'id'});
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

  async function transact(storeName, mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let result;
      transaction.onabort = () => reject(transaction.error || new Error('Local try-on storage was interrupted.'));
      transaction.oncomplete = () => {
        if (mode === 'readwrite' && result) {
          try { channel?.postMessage(storeName); } catch { /* The write is already committed. */ }
        }
        resolve(mode === 'readwrite' ? Boolean(result) : result);
      };
      try {
        run(transaction.objectStore(storeName), value => { result = value; });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
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

  async function putPhoto({id, blob, createdAt}) {
    if (!validId(id) || !(blob instanceof Blob) || !blob.size || !Number.isFinite(createdAt)) {
      throw new TypeError('Invalid local try-on photo.');
    }
    return transact(photos, 'readwrite', (store, changed) => {
      // Keep the original bytes and MIME type without storing the local filename.
      store.put({id, blob: blob.slice(0, blob.size, blob.type), createdAt});
      changed(true);
    });
  }

  async function putJobs(records) {
    const snapshots = new Map();
    for (const record of records) {
      const {id, updatedAt} = record;
      if (!validId(id) || !Number.isFinite(updatedAt)) throw new TypeError('Invalid local try-on record.');
      const previous = snapshots.get(id);
      if (previous && previous.updatedAt > updatedAt) continue;
      const snapshot = {id, updatedAt};
      for (const key of jobFields) {
        const value = record[key];
        if (typeof value === 'string' || Number.isFinite(value) || value === null) snapshot[key] = value;
      }
      snapshots.set(id, snapshot);
    }
    if (!snapshots.size) return false;
    return transact(jobs, 'readwrite', (store, changed) => {
      for (const snapshot of snapshots.values()) {
        update(store, snapshot.id, current => {
          if (current?.deleted || current?.updatedAt > snapshot.updatedAt) return;
          return current?.cachedImage ? {...snapshot, cachedImage: current.cachedImage} : snapshot;
        }, changed);
      }
    });
  }

  async function saveImage(id, blob) {
    if (!validId(id) || !(blob instanceof Blob) || !blob.size) throw new TypeError('Invalid local try-on result.');
    return transact(jobs, 'readwrite', (store, changed) => {
      update(store, id, current => {
        if (current && !current.deleted && !current.cachedImage) return {...current, cachedImage: blob};
      }, changed);
    });
  }

  window.WardrobeTryOnStorage = {
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
        if (event.data === photos || event.data === jobs) callback(event.data);
      };
      channel?.addEventListener('message', handleMessage);
      return () => channel?.removeEventListener('message', handleMessage);
    },
  };
})();
