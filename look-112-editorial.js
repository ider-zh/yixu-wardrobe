const pieces = [
  ['深樱红圆领短外套', '圆扣与开线口袋', '圆领贴近半高领，门襟敞开。古铜色圆扣和细开线口袋在哑光深樱红上若隐若现。', 'black-cherry-collarless-jacket'],
  ['奶油白半高领细针织衫', '半高领与织纹', '奶油白提亮脸侧，也分开深樱红和墨灰两种深色。细针织贴合颈线，衣身下缘收入裤腰。', 'cream-mock-neck-knit'],
  ['墨灰微锥九分裤', '裤线与裤脚', '顺直的前裤线拉出纵向线条，裤腿向下略收。九分长度露出脚踝，让鞋搭带和裤脚分明。', 'ink-gray-tapered-trousers'],
  ['黑色搭带平底鞋', '细搭带与鞋头', '单条细搭带横过脚背。圆中略尖的鞋头和低底，延续了九分裤利落的线条。', 'black-strap-flats']
];
const controls = [...document.querySelectorAll('[data-item]')];
const mainImages = [...document.querySelectorAll('.item img')];
const sample = document.querySelector('#sample');
const caption = document.querySelector('#sample-caption');
const toggle = document.querySelector('#toggle');
const productLink = document.querySelector('#product-link');
const preferredImages = new Map();
let selected = 0;
let viewWhole = false;

function showImage(image, source) {
  const preferred = preferredImages.get(source);
  image.onerror = preferred ? () => {
    preferredImages.delete(source);
    image.onerror = null;
    image.src = source;
  } : null;
  image.src = preferred || source;
}

function updateSample() {
  const [name, detail, , slug] = pieces[selected];
  const product = slug + '-112';
  caption.textContent = viewWhole ? '单品全貌' : detail;
  sample.alt = viewWhole ? name + '全貌' : detail;
  showImage(sample, viewWhole ? mainImages[selected].dataset.source : 'assets/products/look-112/' + product + '-detail-r1.webp');
  toggle.textContent = viewWhole ? '看局部细节' : '看单品全貌';
  productLink.href = 'index.html#/product/' + product + '?look=112';
  productLink.setAttribute('aria-label', '进入' + name + '单品页');
}
function select(index) {
  selected = index;
  viewWhole = false;
  controls.forEach(button => button.setAttribute('aria-pressed', Number(button.dataset.item) === index));
  document.querySelector('#count').textContent = '0' + (index + 1) + ' / 04';
  document.querySelector('#item-name').textContent = pieces[index][0];
  document.querySelector('#item-note').textContent = pieces[index][2];
  updateSample();
}
const inspector = document.querySelector('#pieces');
controls.forEach(button => button.addEventListener('click', () => {
  select(Number(button.dataset.item));
  const bounds = inspector.getBoundingClientRect();
  if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
    inspector.scrollIntoView({block: 'nearest'});
  }
}));
toggle.addEventListener('click', () => {
  viewWhole = !viewWhole;
  updateSample();
});
const portrait = document.querySelector('.portrait');
const pins = [...portrait.querySelectorAll('.pin')];
new ResizeObserver(() => {
  const {width, height} = portrait.getBoundingClientRect();
  const imageWidth = Math.min(width, height * 2 / 3);
  const imageHeight = imageWidth * 3 / 2;
  for (const pin of pins) {
    pin.style.setProperty('--x', ((width - imageWidth) / 2 + imageWidth * Number(pin.dataset.x)) + 'px');
    pin.style.setProperty('--y', ((height - imageHeight) / 2 + imageHeight * Number(pin.dataset.y)) + 'px');
  }
}).observe(portrait);

const albumImage = document.querySelector('#album-image');
const staticImages = [
  document.querySelector('#portrait'),
  ...mainImages,
  albumImage
];
staticImages.forEach(image => { image.dataset.source = image.getAttribute('src'); });

async function loadCdnImages() {
  if (!window.WARDROBE?.revision || !/^https?:$/.test(location.protocol)) return;
  const response = await fetch('/api/content/catalog', {
    credentials: 'omit',
    cache: 'no-cache',
    headers: {Accept: 'application/json'}
  });
  if (!response.ok) return;
  const catalog = await response.json();
  if (catalog.revision !== window.WARDROBE.revision) return;
  const look = catalog.looks.find(entry => entry.id === 112);
  const assets = [look?.editorial_asset, look?.versions.v2.asset];
  for (const product of catalog.products) {
    if (!product.appearances.some(appearance => appearance.look_id === 112)) continue;
    assets.push(product.asset, ...(product.gallery || []).map(image => image.asset));
  }
  for (const asset of assets) {
    if (!asset?.image_url || asset.image_url === asset.source_url) continue;
    const url = new URL(asset.image_url);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      preferredImages.set(asset.file, url.href);
    }
  }
  for (const image of staticImages) {
    const source = image.dataset.source;
    if (preferredImages.has(source)) showImage(image, source);
  }
  updateSample();
}

loadCdnImages().catch(() => {});

const shots = window.WARDROBE?.looks.find(look => look.id === 112)?.versions.v2.shots;

if (shots?.length === 9) {
  const album = document.querySelector('#original');
  const frame = albumImage.parentElement;
  const albumCaption = document.querySelector('#album-caption');
  const albumCount = document.querySelector('#album-count');
  const albumTitle = document.querySelector('#album-title');
  const albumNote = document.querySelector('#album-note');
  const play = document.querySelector('#album-play');
  const thumbnails = document.querySelector('#album-thumbnails');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let playing = !reducedMotion.matches;
  let visible = false;
  let timer;

  function updateThumbnailImage() {
    thumbnails.style.setProperty('--album-sheet', 'url(' + JSON.stringify(albumImage.currentSrc || albumImage.src) + ')');
  }
  albumImage.addEventListener('load', updateThumbnailImage);
  updateThumbnailImage();

  function showShot(index) {
    current = (index + shots.length) % shots.length;
    const shot = shots[current];
    frame.style.setProperty('--column', current % 3);
    frame.style.setProperty('--row', Math.floor(current / 3));
    albumImage.alt = shot.title + '。' + shot.framing;
    albumCount.textContent = String(current + 1).padStart(2, '0') + ' / 09';
    albumTitle.textContent = shot.title;
    albumNote.textContent = shot.framing;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', i === current));
  }

  function syncPlayback() {
    clearTimeout(timer);
    play.textContent = playing ? '暂停轮播' : '播放轮播';
    albumCaption.setAttribute('aria-live', playing ? 'off' : 'polite');
    if (playing && visible && !document.hidden) {
      timer = setTimeout(() => {
        showShot(current + 1);
        syncPlayback();
      }, 4000);
    }
  }

  function chooseShot(index) {
    playing = false;
    syncPlayback();
    showShot(index);
  }

  const buttons = shots.map((shot, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'album-thumb';
    button.style.setProperty('--position', (index % 3 * 50) + '% ' + (Math.floor(index / 3) * 50) + '%');
    button.setAttribute('aria-label', '第' + (index + 1) + '张：' + shot.title);
    button.addEventListener('click', () => chooseShot(index));
    thumbnails.append(button);
    return button;
  });

  play.addEventListener('click', () => {
    playing = !playing;
    syncPlayback();
  });
  document.querySelector('#album-previous').addEventListener('click', () => chooseShot(current - 1));
  document.querySelector('#album-next').addEventListener('click', () => chooseShot(current + 1));
  document.addEventListener('visibilitychange', syncPlayback);
  reducedMotion.addEventListener('change', event => {
    if (!event.matches) return;
    playing = false;
    syncPlayback();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.intersectionRatio >= 0.35;
    syncPlayback();
  }, {threshold: 0.35}).observe(frame);
  showShot(0);
  syncPlayback();
}
