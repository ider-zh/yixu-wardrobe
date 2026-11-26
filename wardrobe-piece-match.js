(() => {
  'use strict';

  const categories = [
    {id: 'blazer', title: '西装外套'},
    {id: 'straight-leg-pants', title: '直筒裤'},
    {id: 'loafers', title: '乐福鞋'},
    {id: 'trench-coat', title: '风衣'},
  ];

  const matches = new Map([
    ['blazer', name => /西装(?:外套)?$/.test(name)],
    ['straight-leg-pants', name => /直筒.*裤$/.test(name) && !name.includes('裙裤')],
    ['loafers', name => name.endsWith('乐福鞋')],
    ['trench-coat', name => name.endsWith('风衣') && !name.includes('防风衣')],
  ]);

  function matchingPieceName(piece, category) {
    const match = matches.get(category);
    if (!match || typeof piece?.name !== 'string') return '';
    const name = piece.name.split(/[,，、;；。:：（(【\[]/, 1)[0].trim();
    return match(name) ? name : '';
  }

  function matchingPieces(look, category) {
    if (look?.model_only || !Array.isArray(look?.pieces)) return [];
    return look.pieces.map(piece => matchingPieceName(piece, category)).filter(Boolean);
  }

  window.WardrobePieceMatch = {categories, matchingPieceName, matchingPieces};
})();
