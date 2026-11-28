(() => {
  'use strict';

  function create({
    dialog, frame, image, stage, previous, next, play, caption, selectView,
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  }) {
    const documentRoot = dialog.ownerDocument;
    let playing = !reducedMotion.matches;
    let visible = false;
    let timer;
    let outgoing;
    let swipeStart;

    function sync({reset = false} = {}) {
      clearTimeout(timer);
      if (reset || !dialog.open) outgoing?.remove();
      if (reset) playing = !reducedMotion.matches;

      const label = playing ? '暂停轮播' : '播放轮播';
      play.toggleAttribute('data-paused', !playing);
      play.setAttribute('aria-label', label);
      play.title = label;
      caption?.setAttribute('aria-live', playing ? 'off' : 'polite');

      if (!playing || !visible || !dialog.open || documentRoot.hidden || frame.dataset.imageState !== 'ready') return;
      timer = setTimeout(() => {
        if (dialog.open && visible && !documentRoot.hidden) selectView(1, false);
        sync();
      }, 4000);
    }

    function pause() {
      playing = false;
      sync();
    }

    function transition() {
      outgoing?.remove();
      if (reducedMotion.matches || frame.dataset.imageState !== 'ready'
        || image.hidden || !image.complete || !image.naturalWidth || !image.animate) return;

      const layer = documentRoot.createElement('img');
      layer.className = 'lookbook-outgoing';
      layer.alt = '';
      layer.setAttribute('aria-hidden', 'true');
      layer.src = image.currentSrc || image.src;
      Object.assign(layer.style, {
        position: 'absolute',
        left: image.offsetLeft + 'px',
        top: image.offsetTop + 'px',
        width: image.offsetWidth + 'px',
        height: image.offsetHeight + 'px',
        maxWidth: 'none',
        objectFit: window.getComputedStyle(image).objectFit
      });
      frame.append(layer);
      outgoing = layer;
      const fade = layer.animate([{opacity: 1}, {opacity: 0}], {
        duration: 420,
        easing: 'ease-in-out',
        fill: 'forwards'
      });
      fade.onfinish = () => layer.remove();
    }

    function move(direction) {
      pause();
      selectView(direction, true);
    }

    play.addEventListener('click', () => {
      playing = !playing;
      sync();
    });
    image.addEventListener('wardrobe:photo-ready', () => sync());
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    stage.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    });
    frame.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      swipeStart = {x: event.clientX, y: event.clientY};
    });
    frame.addEventListener('pointerup', event => {
      if (!event.isPrimary || !swipeStart) return;
      const x = event.clientX - swipeStart.x;
      const y = event.clientY - swipeStart.y;
      swipeStart = undefined;
      if (Math.abs(x) >= 40 && Math.abs(x) > Math.abs(y) * 1.5) move(x < 0 ? 1 : -1);
    });
    frame.addEventListener('pointercancel', () => { swipeStart = undefined; });
    documentRoot.addEventListener('visibilitychange', () => sync());
    reducedMotion.addEventListener('change', event => {
      if (!event.matches) return;
      outgoing?.remove();
      pause();
    });
    new IntersectionObserver(([entry]) => {
      visible = entry.intersectionRatio >= 0.35;
      sync();
    }, {threshold: 0.35}).observe(stage);

    sync();
    return {sync, transition, pause};
  }

  window.WardrobeLookbookAlbum = {create};
})();
