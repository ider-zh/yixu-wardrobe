/* Built-in layout adapters. Content supplies plain text and a theme name only. */
(() => {
'use strict';
const themes = Object.freeze({
 editorial: {
  preset:'warm-paper',
  render:part=>`${part.edition}<div class="product-hero ${part.many?'product-hero-many':''}">${part.visual}${part.summary}</div>${part.chapters}${part.views}${part.details}${part.worn}${part.related}${part.disclosure}`
 },
 studio: {
  preset:'neutral-white',
  render:part=>`${part.edition}<div class="product-studio-layout"><div class="product-studio-main"><div class="product-hero">${part.visual}</div>${part.chapters}${part.views}${part.details}</div><aside class="product-studio-aside" aria-label="单品信息">${part.summary}</aside></div>${part.worn}${part.related}${part.disclosure}`
 }
});
window.YixuProductThemes=Object.freeze({
 resolve(presentation={},override){
  const validOverride=Object.hasOwn(themes,override)?override:undefined;
  const requested=window.YixuSiteTheme?.resolve(presentation.theme,validOverride)??(validOverride||presentation.theme);
  const name=Object.hasOwn(themes,requested)?requested:'editorial';
  const adapter=themes[name];
  const explicit=Object.hasOwn(themes,override)||!!window.YixuSiteTheme?.preference();
  const preset=!explicit&&['warm-paper','neutral-white'].includes(presentation.preset)?presentation.preset:adapter.preset;
  return {name,preset,render:adapter.render};
 }
});
})();
