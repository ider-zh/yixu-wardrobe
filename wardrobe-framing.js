(() => {
  'use strict';

  const footPart = '(?:鞋履?|靴|(?<![裤裙])脚|足)(?![履盒柜架袋迹边])';
  const footwear = new RegExp(footPart);
  const unobstructed = /(?:未被[^，。；]{0,10}|未|不被[^，。；]{0,10}|不|无)(?:遮挡|遮住|裁切|裁剪|截断|出框)/g;
  const obstruction = /遮挡|遮住|挡住|挡在|裁切|裁剪|截断|切掉|未(?:全部|完整)?(?:入镜|露出)|未完整|不(?:完全|完整)?(?:入镜|可见|见|全)|看不见|看不清|没(?:有)?(?:入镜|露出|完整)|画面外|出框|仅(?:见|露出)一只|只(?:见|露出)一只/;
  const visibleSuffix = new RegExp(`${footPart}(?:子|尖|头|部|轮廓)?(?:(?:、|与|和|及|以及)[^，。；]{1,20}?)?(?:均|都)?(?:完整|可见|可辨|清楚|入镜|在(?:画面|镜头|格子)(?:之)?内|保留完整|未被[^，。；]{0,10}裁切|未裁切|无遮挡)`);
  const visiblePrefix = new RegExp(`(?:含|能看清|能看到|可见|展示|头至)[^，。；]{0,20}?${footPart}`);
  const completeList = new RegExp(`完整(?:的)?(?:(?:头部|头顶|衣装|衣摆|裙摆|裤脚|外套后摆)(?:、|与|和|及|以及)){0,3}(?:双|两只|两|前后|左右)?(?:短|长|运动|徒步|乐福|皮|高跟|低跟|平底)*${footPart}`);

  function fullBodyRank(framing) {
    if (typeof framing !== 'string' || !framing.includes('全身') || /中全身|中全景|半身/.test(framing)) return null;

    const clauses = framing.split(/[,，;；.。]/);
    if (clauses.some(clause => footwear.test(clause) && obstruction.test(clause.replace(unobstructed, '')))) return null;
    if (!clauses.some(clause => visibleSuffix.test(clause) || visiblePrefix.test(clause) || completeList.test(clause))) return null;

    if (/坐|俯|背侧|背面|背身|背向|背后|后侧|后方/.test(framing)) return 2;
    if (/正面|正前|迎面/.test(framing)) return 0;
    if (/侧身|侧面|侧向|侧前|侧方|斜侧|斜前|斜向|侧全身/.test(framing)) return 1;
    return 2;
  }

  function fullBodyShot(shots) {
    if (!Array.isArray(shots)) return null;
    let bestIndex = null;
    let bestRank = Infinity;
    for (let index = 0; index < Math.min(shots.length, 9); index++) {
      const rank = fullBodyRank(shots[index]?.framing);
      if (rank === null || rank >= bestRank) continue;
      bestIndex = index + 1;
      bestRank = rank;
      if (bestRank === 0) break;
    }
    return bestIndex;
  }

  window.WardrobeFraming = {fullBodyShot};
})();
