(() => {
  'use strict';

  const validLookId = id => Number.isSafeInteger(id) && id > 0;
  const validProductId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
  const asArray = value => Array.isArray(value) ? value : [];
  const titleOf = value => typeof value === 'string' ? value.trim() : '';
  const lookKey = (id, pieceIndex) => `look:${id}:${pieceIndex}`;
  const productKey = id => `product:${id}`;

  function sameSource(a, b) {
    return a.type === b.type && a.id === b.id && a.pieceIndex === b.pieceIndex;
  }

  function appendSource(sources, source) {
    if (!sources.some(existing => sameSource(existing, source))) sources.push(source);
  }

  function buildEntries(listEntries, catalog) {
    const looks = new Map();
    for (const look of asArray(catalog?.looks)) {
      if (validLookId(look?.id)) looks.set(look.id, look);
    }

    const products = new Map();
    const knownProducts = new Set();
    const linkedPieces = new Map();
    for (const product of asArray(catalog?.products)) {
      if (!validProductId(product?.product_id)) continue;
      const id = product.product_id;
      knownProducts.add(id);
      const title = titleOf(product.name);
      if (product.model_only || !title) continue;

      for (const appearance of asArray(product.appearances)) {
        const look = looks.get(appearance?.look_id);
        const pieceIndex = appearance?.piece_index;
        if (!look || look.model_only || !validLookId(pieceIndex) || pieceIndex > asArray(look.pieces).length) continue;

        products.set(id, title);
        const key = lookKey(look.id, pieceIndex);
        if (!linkedPieces.has(key)) linkedPieces.set(key, id);
        // A conflicting catalog reference cannot establish that these are the same garment.
        else if (linkedPieces.get(key) !== id) linkedPieces.set(key, null);
      }
    }

    const rows = new Map();
    const unavailable = new Map();
    function add(key, title, source) {
      if (!rows.has(key)) rows.set(key, {key, title, sources:[], checked:false});
      appendSource(rows.get(key).sources, source);
    }

    for (const entry of asArray(listEntries)) {
      if (!entry) continue;
      const {type, id} = entry;
      if (type === 'look' && validLookId(id)) {
        const look = looks.get(id);
        if (!look) unavailable.set(`look:${id}`, {type, id});
        if (!look || look.model_only) continue;
        asArray(look.pieces).forEach((piece, index) => {
          const pieceIndex = index + 1;
          const key = lookKey(id, pieceIndex);
          const linkedId = linkedPieces.get(key);
          const title = linkedId ? products.get(linkedId) : titleOf(piece?.name);
          if (title) add(linkedId ? productKey(linkedId) : key, title, {type, id, pieceIndex});
        });
      } else if (type === 'product' && validProductId(id)) {
        const title = products.get(id);
        if (title) add(productKey(id), title, {type, id});
        else if (!knownProducts.has(id)) unavailable.set(productKey(id), {type, id});
      }
    }
    return {entries: [...rows.values()], missing: [...unavailable.values()]};
  }

  function mergeEntries(entries, targetKey, sourceKey) {
    if (targetKey === sourceKey) return entries;
    const target = entries.find(entry => entry.key === targetKey);
    const source = entries.find(entry => entry.key === sourceKey);
    if (!target || !source) return entries;

    const sources = [];
    for (const origin of [...target.sources, ...source.sources]) appendSource(sources, origin);
    const merged = {...target, sources, checked:target.checked === true && source.checked === true};
    return entries.filter(entry => entry !== source).map(entry => entry === target ? merged : entry);
  }

  window.WardrobePacking = {buildEntries, mergeEntries};
})();
