(() => {
  'use strict';

  function create({lookKey, productKey}) {
    const lists = window.WardrobeLists;
    const week = window.WardrobeWeekPlan;
    const packing = window.WardrobePackingStore;
    const schema = window.WardrobeBackupSchema;

    function readFavorites(key, valid) {
      const raw = window.localStorage.getItem(key);
      const entries = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(entries) || !entries.every(valid)) throw new Error('现有收藏数据无法识别。');
      return [...new Set(entries)];
    }

    const lookId = id => Number.isSafeInteger(id) && id > 0;
    const productId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);

    function mergeFavorites(key, valid, incoming) {
      if (!incoming.length) return false;
      const before = readFavorites(key, valid);
      const merged = [...new Set([...before, ...incoming])];
      if (merged.length === before.length) return false;
      const newValue = JSON.stringify(merged);
      window.localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', {key, newValue}));
      return true;
    }

    async function capture() {
      const favorites = {looks:readFavorites(lookKey, lookId), products:readFavorites(productKey, productId)};
      const [savedLists, weekDays, packingList] = await Promise.all([lists.load(), week.load(), packing.load()]);
      return schema.validate({schemaVersion:1, favorites, lists:savedLists, week:weekDays, packing:packingList});
    }

    async function restore(input) {
      const data = schema.validate(input);
      const domains = [
        ['穿搭收藏', () => mergeFavorites(lookKey, lookId, data.favorites.looks)],
        ['单品收藏', () => mergeFavorites(productKey, productId, data.favorites.products)],
        ['搭配清单', () => data.lists.length && lists.mergeBackup(data.lists)],
        ['一周计划', () => data.week.length && week.mergeBackup(data.week)],
        ['打包清单', async () => {
          if (!data.packing || await packing.load()) return false;
          await packing.replace(data.packing, null);
          return true;
        }],
      ];
      return Promise.all(domains.map(async ([label, merge]) => {
        try { return {label, changed:Boolean(await merge())}; }
        catch (error) { return {label, changed:false, error:error?.message || '保存失败。'}; }
      }));
    }

    return {capture, restore};
  }

  window.WardrobeBackup = {create};
})();
