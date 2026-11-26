(() => {
  'use strict';

  const shanghaiOffset = 8 * 60 * 60 * 1000;

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const midnight = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === value;
  }

  function publicationTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !validDate(value.slice(0, 10))) return NaN;
    return Date.parse(value);
  }

  function publicLooks(looks) {
    const published = new Map();
    const seen = new Set();
    for (const look of looks) {
      if (!Number.isSafeInteger(look?.id) || look.id < 1) continue;
      if (seen.has(look.id)) {
        published.delete(look.id);
        continue;
      }
      seen.add(look.id);
      if (!look.model_only && typeof look.title === 'string' && look.title.trim()) published.set(look.id, look);
    }
    return published;
  }

  function build(catalog) {
    const looks = publicLooks(Array.isArray(catalog?.looks) ? catalog.looks : []);
    const candidates = [];
    for (const batch of Array.isArray(catalog?.batches) ? catalog.batches : []) {
      const id = batch?.batch_id;
      const date = batch?.publish_date;
      const publishedAt = batch?.published_at;
      const time = publicationTime(publishedAt);
      if (typeof id !== 'string' || !validDate(date) || !id.startsWith(`${date}-`)
        || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9_-]+$/.test(id)
        || !Number.isFinite(time) || new Date(time + shanghaiOffset).toISOString().slice(0, 10) !== date
        || !Array.isArray(batch.look_ids)) continue;
      candidates.push({id, date, publishedAt, time, batch});
    }
    candidates.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    const batches = [];
    const batchIds = new Set();
    const assigned = new Set();
    for (const {id, date, publishedAt, batch} of candidates) {
      if (batchIds.has(id)) continue;
      const lookIds = [...new Set(batch.look_ids)].filter(lookId => {
        const look = looks.get(lookId);
        return look && !assigned.has(lookId) && (look.batch_id == null || look.batch_id === id);
      }).sort((a, b) => a - b);
      if (!lookIds.length) continue;

      const coverId = lookIds.includes(batch.cover_look_id) ? batch.cover_look_id : lookIds[0];
      batches.push({id, date, publishedAt, title: looks.get(coverId).title, lookIds});
      batchIds.add(id);
      lookIds.forEach(lookId => assigned.add(lookId));
    }

    const undatedLookIds = [...looks.values()]
      .filter(look => !assigned.has(look.id) && !validDate(look.publish_date) && !Number.isFinite(publicationTime(look.published_at)))
      .map(look => look.id).sort((a, b) => a - b);
    return {batches, undatedLookIds};
  }

  window.WardrobePublication = {build};
})();
