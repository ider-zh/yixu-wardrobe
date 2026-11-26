(() => {
  'use strict';

  function create({favorites}) {
    const lists = window.WardrobeLists;
    const week = window.WardrobeWeekPlan;
    const packing = window.WardrobePackingStore;
    const schema = window.WardrobeBackupSchema;

    async function capture() {
      const [looks, products, savedLists, weekDays, packingList] = await Promise.all([
        favorites.load('look'), favorites.load('product'), lists.load(), week.load(), packing.load(),
      ]);
      return schema.validate({schemaVersion:1, favorites:{looks, products}, lists:savedLists, week:weekDays, packing:packingList});
    }

    async function restore(input) {
      const data = schema.validate(input);
      const domains = [
        ['穿搭收藏', () => favorites.merge('look', data.favorites.looks)],
        ['单品收藏', () => favorites.merge('product', data.favorites.products)],
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
