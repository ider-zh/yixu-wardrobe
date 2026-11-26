(() => {
  'use strict';

  const validLookId = id => Number.isSafeInteger(id) && id > 0;
  const validToken = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
  const validProductId = id => validToken(id) && id.length <= 128;
  const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);

  function requireFields(value, fields, label) {
    if (!isRecord(value) || Object.keys(value).length !== fields.length
      || !fields.every(field => Object.hasOwn(value, field))) {
      throw new Error(`${label}字段不完整或包含额外字段。`);
    }
  }

  function uniqueArray(values, label, verify, keyOf = value => value) {
    if (!Array.isArray(values)) throw new Error(`${label}格式不正确。`);
    const result = [];
    const seen = new Set();
    for (const value of values) {
      const verified = verify(value);
      const key = keyOf(verified);
      if (seen.has(key)) throw new Error(`${label}包含重复条目。`);
      seen.add(key);
      result.push(verified);
    }
    return result;
  }

  function identifier(id, verify, label) {
    if (!verify(id)) throw new Error(`${label}包含无效编号。`);
    return id;
  }

  function favorites(value) {
    requireFields(value, ['looks', 'products'], '收藏');
    return {
      looks: uniqueArray(value.looks, '收藏穿搭', id => identifier(id, validLookId, '收藏穿搭')),
      products: uniqueArray(value.products, '收藏单品', id => identifier(id, validProductId, '收藏单品')),
    };
  }

  function listEntry(value) {
    requireFields(value, ['type', 'id'], '搭配清单条目');
    const {type, id} = value;
    if ((type === 'look' && validLookId(id)) || (type === 'product' && validProductId(id))) return {type, id};
    throw new Error('搭配清单条目的类型或编号无效。');
  }

  function lists(values) {
    return uniqueArray(values, '搭配清单', value => {
      requireFields(value, ['id', 'name', 'entries'], '搭配清单');
      const id = identifier(value.id, validToken, '搭配清单');
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      if (!name) throw new Error('搭配清单名称不能为空。');
      const entries = uniqueArray(value.entries, '搭配清单条目', listEntry, entry => `${entry.type}:${entry.id}`);
      return {id, name, entries};
    }, list => list.id);
  }

  function week(values) {
    return uniqueArray(values, '一周计划日期', value => {
      requireFields(value, ['date', 'lookId'], '一周计划');
      const {date, lookId} = value;
      try { window.WardrobeWeekPlan.shiftDate(date, 0); }
      catch { throw new Error('一周计划包含无效的公历日期。'); }
      return {date, lookId:identifier(lookId, validLookId, '一周计划')};
    }, plan => plan.date);
  }

  function packing(value) {
    if (value === null) return null;
    try { return window.WardrobePackingStore.validateSnapshot(value); }
    catch { throw new Error('备份中的打包清单格式不正确。'); }
  }

  function validate(data) {
    requireFields(data, ['schemaVersion', 'favorites', 'lists', 'week', 'packing'], '备份');
    if (data.schemaVersion !== 1) throw new Error('此衣橱备份版本无法读取。');
    return {
      schemaVersion: 1,
      favorites: favorites(data.favorites),
      lists: lists(data.lists),
      week: week(data.week),
      packing: packing(data.packing),
    };
  }

  function summary(data) {
    const backup = validate(data);
    return {
      favoriteLooks: backup.favorites.looks.length,
      favoriteProducts: backup.favorites.products.length,
      lists: backup.lists.length,
      listEntries: backup.lists.reduce((count, list) => count + list.entries.length, 0),
      weekDays: backup.week.length,
      hasPacking: backup.packing !== null,
      packingEntries: backup.packing?.entries.length ?? 0,
    };
  }

  window.WardrobeBackupSchema = {validate, summary};
})();
