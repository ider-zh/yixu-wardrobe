/* Built-in product layouts follow the active site theme. */
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
 resolve(){
  const name=window.YixuSiteTheme?.resolve()==='studio'?'studio':'editorial';
  const adapter=themes[name];
  return {name,preset:adapter.preset,render:adapter.render};
 }
});
})();
