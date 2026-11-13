/* Shared product rendering and gallery behavior; themes arrange trusted sections only. */
(() => {
'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function create({root,dialog,media,renderCard,renderWorn}){
 const imageAttributes=media.attributes;
 const $=id=>document.getElementById(id);
 let current=null,selectedProduct=null,selectedAsset=null,zoomIndex=null;
function productImages(product){
 let detail=0;
 return [{title:'完整形态',label:'主视觉',caption:product.description,role:'hero',asset:product.asset},...(product.gallery||[]).map(image=>({...image,role:image.role||'detail',label:image.design_study?'推演视角':image.role==='view'?image.title:'细节 '+String(++detail).padStart(2,'0')}))].map((image,index)=>({...image,index}));
}
function productImageAlt(product,image){
 return product.name+' · '+image.title+(image.design_study?' · 设计推演':'');
}
function productImageButton(product,image,index,className){
 return `<button class="${className}" data-product-zoom="${esc(product.product_id)}" data-product-frame-index="${index}" aria-label="放大查看 ${esc(productImageAlt(product,image))}"><img ${imageAttributes(image.asset)} alt="${esc(productImageAlt(product,image))}" width="${image.asset.width}" height="${image.asset.height}" ${index?'loading="lazy"':'fetchpriority="high"'} decoding="async"><span class="product-design-badge" ${image.design_study?'':'hidden'}>设计推演</span><span class="product-image-hint" aria-hidden="true">↗</span></button>`;
}
function render(view){
 current=view;
 const {product,number,liked,appearances,related,themeOverride}=view;
 const id=product?.product_id;
 if(!product){selectedProduct=null;selectedAsset=null;delete root.dataset.productTheme;delete root.dataset.productPreset;root.innerHTML='<p class="eyebrow">THE OBJECT EDIT</p><h1>这件单品暂未发布。</h1><a class="outline-button" href="#/products">浏览全部单品 ↗</a>';return;}
 const theme=window.YixuProductThemes.resolve(product.presentation,themeOverride);
 root.dataset.productTheme=theme.name;root.dataset.productPreset=theme.preset;
 const images=productImages(product),views=images.filter(image=>image.role==='view'),details=images.filter(image=>image.role==='detail');
 const worn=appearances.map(renderWorn).join('');
 const thumbnails=images.length>1?`<div class="product-thumbnails ${images.length>4?'product-thumbnails-many':''}" role="group" aria-label="选择单品图片">${images.map((image,i)=>`<button data-product-select="${id}" data-product-index="${i}" aria-pressed="${i===0}" aria-label="${esc(image.title)}${image.design_study?' · 设计推演':''}"><img ${imageAttributes(image.asset)} alt="" loading="lazy"><span>${esc(image.label)}</span></button>`).join('')}</div>`:'';
 const stories=details.map((image,i)=>`<article class="product-detail-story">${productImageButton(product,image,image.index,'product-detail-image')}<div class="product-detail-copy"><p class="eyebrow">DETAIL ${String(i+1).padStart(2,'0')}${image.design_study?' · 设计推演':''}</p><h3>${esc(image.title)}</h3><p>${esc(image.caption)}</p><button class="product-text-link" data-product-zoom="${id}" data-product-frame-index="${image.index}">放大这一处细节 ↗</button></div></article>`).join('');
 const angleSection=views.length?`<section class="product-view-section" aria-labelledby="product-views-title"><div class="section-heading"><div><p class="eyebrow">EVERY ANGLE, ONE DESIGN</p><h2 id="product-views-title">${esc(product.copy?.views_title||'换个角度，认识它。')}</h2></div><span class="product-section-number">${views.length} 个全貌视角</span></div><p class="product-view-hint">左右滑动，查看各个角度 →</p><div class="product-view-grid" tabindex="0" aria-label="单品全貌视角">${views.map(image=>`<article class="product-view-card" data-design-study="${!!image.design_study}">${productImageButton(product,image,image.index,'product-view-image')}<h3>${esc(image.title)}</h3><p>${esc(image.caption)}</p></article>`).join('')}</div></section>`:'';
 const parts={many:images.length>4,edition:`
  <div class="product-edition-line"><nav class="product-breadcrumb" aria-label="单品路径"><a href="#/products">全部单品</a><span aria-hidden="true">/</span><span>${esc(product.category)}</span></nav><span>衣序单品特辑 · ${number}</span></div>
  `,visual:`<div class="product-visual"><figure class="product-hero-figure">${productImageButton(product,images[0],0,'product-main-image')}<figcaption><span class="product-hero-caption">01 / ${String(images.length).padStart(2,'0')} · 完整形态</span><span>点击图片，近一点看 ↗</span></figcaption></figure>${thumbnails}</div>
  `,summary:`<article class="product-copy"><p class="eyebrow">THE SIGNATURE EDIT <span>— ${number}</span></p><p class="product-category">${esc(product.category)} / ${esc(product.color_name)}</p>${product.copy?.hero_title&&product.copy.hero_title!==product.name?`<p class="product-display-name">${esc(product.name)}</p>`:''}<h1>${esc(product.copy?.hero_title||product.name)}</h1><p class="product-subtitle">${esc(product.subtitle)}</p><p class="product-description">${esc(product.description)}</p><dl class="product-facts"><div><dt>色调</dt><dd><span class="product-color"><i style="background:${product.color_hex}"></i>${esc(product.color_name)}</span></dd></div><div><dt>视觉肌理</dt><dd>${esc(product.design_material.replace(/，视觉设计描述$/,''))}</dd></div></dl><div class="product-actions"><button class="solid-button" data-product-favorite="${id}" aria-pressed="${liked}" aria-label="${liked?'取消收藏':'收藏单品'} ${esc(product.name)}">${liked?'♥ 已收藏':'♡ 收藏单品'}</button><button class="product-text-link" data-product-worn>看模特怎么穿 <span aria-hidden="true">↓</span></button></div><p class="product-hero-footnote">AI 设计单品 · 穿搭灵感档案</p></article>
  `,chapters:`<nav class="product-chapters" aria-label="单品特辑章节"><button data-product-section="product-hero"><span>01</span>完整形态</button>${views.length?'<button data-product-section="product-view-section"><span>02</span>多角度</button>':''}<button data-product-section="product-observation"><span>${views.length?'03':'02'}</span>设计细节</button><button data-product-worn><span>${views.length?'04':'03'}</span>穿在身上</button><span class="product-chapter-end">THE OBJECT, IN FOCUS</span></nav>
  `,views:angleSection,details:`<section class="product-observation" aria-labelledby="product-observation-title"><div class="product-story-intro"><p class="eyebrow">A CLOSER LOOK</p><h2 id="product-observation-title">${esc(product.copy?.details_title||'值得靠近的，不止第一眼。')}</h2><p>${esc(product.subtitle)}</p></div>${stories?`<div class="product-detail-stories ${details.length>2?'product-detail-stories-grid':''}">${stories}</div>`:''}<ol class="product-design-notes">${product.notes.map((note,i)=>`<li><span>${String(i+1).padStart(2,'0')}</span><p>${esc(note)}</p></li>`).join('')}</ol></section>
  `,worn:`<section id="product-worn-section" class="product-worn-section"><div class="section-heading"><div><p class="eyebrow">FROM OBJECT TO OUTFIT</p><h2>${esc(product.copy?.worn_title||'穿上它，故事才开始。')}</h2></div><span class="product-section-number">${views.length?'04':'03'} / ON THE MODEL</span></div><div class="product-worn-grid">${worn}</div></section>
  `,related:related.length?`<section class="product-related"><div class="section-heading"><div><p class="eyebrow">BETTER TOGETHER</p><h2>${esc(product.copy?.related_title||'让这一件，成为一套。')}</h2></div><a href="#/products">探索更多单品 ↗</a></div><div class="product-grid">${related.map(renderCard).join('')}</div></section>`:'',disclosure:`<p class="product-disclosure">AI 设计展示，供穿搭灵感参考。独立产品图与近景依据写真演绎，细节属于设计补充；请结合原写真查看穿着效果。</p>`};
 root.innerHTML=theme.render(parts);
 const index=selectedProduct===id?images.findIndex(image=>image.asset.asset_id===selectedAsset):0;
 selectedProduct=id;select(Math.max(0,index));
}
function select(index){
 const product=current?.product,image=product&&productImages(product)[index];
 const main=root.querySelector('.product-main-image');if(!image||!main)return;
 selectedAsset=image.asset.asset_id;
 media.set(main.querySelector('img'),image.asset);main.querySelector('img').alt=productImageAlt(product,image);
 main.dataset.productFrameIndex=String(index);main.setAttribute('aria-label','放大查看 '+productImageAlt(product,image));
 main.querySelector('.product-design-badge').hidden=!image.design_study;
 root.querySelector('.product-hero-caption').textContent=`${String(index+1).padStart(2,'0')} / ${String(productImages(product).length).padStart(2,'0')} · ${image.title}${image.design_study?' · 设计推演':''}`;
 root.querySelectorAll('[data-product-select]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.productIndex)===index)));
}
function showImage(index){
 const product=current?.product,images=product&&productImages(product),image=images?.[index];if(!image)return;
 zoomIndex=index;media.set($('product-zoom-image'),image.asset);$('product-zoom-image').alt=productImageAlt(product,image);
 $('product-image-caption').textContent=image.title+(image.design_study?' · 设计推演':'');$('product-image-position').textContent=`${index+1} / ${images.length}`;
 $('product-image-note').textContent=image.caption;
 $('product-image-prev').disabled=index===0;$('product-image-next').disabled=index===images.length-1;
 if(!dialog.open)dialog.showModal();
}
root.addEventListener('click',event=>{
 const selected=event.target.closest('[data-product-select]');
 if(selected){select(Number(selected.dataset.productIndex));return;}
 const zoom=event.target.closest('[data-product-zoom]');
 if(zoom){showImage(Number(zoom.dataset.productFrameIndex)||0);return;}
 if(event.target.closest('[data-product-worn]')){root.querySelector('#product-worn-section')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 const chapter=event.target.closest('[data-product-section]');
 if(chapter)root.querySelector('.'+chapter.dataset.productSection)?.scrollIntoView({behavior:'smooth',block:'start'});
});
$('close-product-image').addEventListener('click',()=>dialog.close());
$('product-image-prev').addEventListener('click',()=>{if(zoomIndex!==null)showImage(zoomIndex-1);});
$('product-image-next').addEventListener('click',()=>{if(zoomIndex!==null)showImage(zoomIndex+1);});
// A native close event can arrive after the user has already reopened the gallery.
dialog.addEventListener('close',()=>{if(!dialog.open)zoomIndex=null;});
dialog.addEventListener('keydown',event=>{if(zoomIndex===null||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();showImage(zoomIndex+(event.key==='ArrowLeft'?-1:1));});
return Object.freeze({render});
}
window.YixuProductPage=Object.freeze({create});
})();
