(() => {
  'use strict';

  const families = [
    {id: 'neutral', label: '黑白灰'},
    {id: 'beige', label: '米杏'},
    {id: 'brown', label: '棕驼'},
    {id: 'green', label: '绿'},
    {id: 'blue', label: '蓝青'},
    {id: 'red-pink', label: '红粉'},
    {id: 'yellow-orange', label: '黄橙'},
    {id: 'purple', label: '紫'},
  ];
  const familyIds = new Set(families.map(({id}) => id));

  function hueDegrees(red, green, blue, maximum, chroma) {
    if (maximum === red) {
      const hue = 60 * (green - blue) / chroma;
      return hue < 0 ? hue + 360 : hue;
    }
    if (maximum === green) return 120 + 60 * (blue - red) / chroma;
    return 240 + 60 * (red - green) / chroma;
  }

  function colorFamily(color) {
    if (typeof color !== 'string' || color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(color)) return null;
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    const lightness = (maximum + minimum) / 2;

    // Approximate families from the catalog's RGB swatches. Earlier ranges take priority.
    if (chroma < 10 || lightness < 24) return 'neutral';
    const hue = hueDegrees(red, green, blue, maximum, chroma);
    if (hue >= 20 && hue < 72 && lightness >= 180 && chroma < 74) return 'beige';
    if (hue >= 22 && hue < 62 && chroma >= 72 && lightness >= 111) return 'yellow-orange';
    if (hue >= 50 && hue < 170) return 'green';
    if (hue >= 170 && hue < 255) return 'blue';
    if (hue >= 255 && hue < 338) return 'purple';
    if (hue >= 338 || (hue < 14 && (chroma >= 65 || lightness >= 125))) return 'red-pink';
    return 'brown';
  }

  function matchPalette(palette, selections) {
    if (!Array.isArray(palette) || !Array.isArray(selections)) return null;
    const ids = [...new Set(selections)];
    if (!ids.length || ids.length > 2 || ids.some(id => !familyIds.has(id))) return null;
    const matches = ids.map(id => ({id, colors: []}));
    for (const color of palette) {
      const id = colorFamily(color);
      matches.find(match => match.id === id)?.colors.push(color);
    }
    return matches.every(match => match.colors.length) ? matches : null;
  }

  window.WardrobeColorMatch = {families, colorFamily, matchPalette};
})();
