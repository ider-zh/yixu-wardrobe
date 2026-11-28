(() => {
  'use strict';

  const { gsap, Lenis } = window;
  const motionAllowed = '(prefers-reduced-motion: no-preference)';
  const finePointer = '(hover: hover) and (pointer: fine)';
  const dialogs = [...document.querySelectorAll('dialog')];
  const hero = document.querySelector('.hero-copy');
  const lookbook = document.getElementById('detail-dialog');
  const grids = document.querySelectorAll(
    '#home-product-gallery, #recent-gallery, #gallery, #product-gallery, #model-looks-gallery'
  );
  const revealed = new WeakSet();

  if (gsap && 'IntersectionObserver' in window) {
    const media = gsap.matchMedia();
    media.add(motionAllowed, () => {
      const active = new Map();

      // React Bits Animated Content's rise and stagger pattern, applied to the
      // wardrobe's existing DOM as each visible group enters the viewport.
      function reveal(elements, { distance = 12, duration = 0.45, opacity = 0.72 } = {}) {
        elements.forEach((element, index) => {
          if (element.contains(document.activeElement)) return;
          active.get(element)?.revert();
          const tween = gsap.fromTo(element, { y: distance, opacity }, {
            y: 0,
            opacity: 1,
            duration,
            delay: Math.min(index * 0.045, 0.135),
            ease: 'power2.out',
            clearProps: 'opacity,transform',
            onComplete: () => active.delete(element),
          });
          active.set(element, tween);
        });
      }

      const visibility = new IntersectionObserver(entries => {
        const cards = [];
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting || !target.isConnected) continue;
          visibility.unobserve(target);
          revealed.add(target);
          if (target === hero) {
            reveal([...hero.querySelectorAll('#hero-kicker, #hero-publication, #hero-title, #hero-meta, #hero-description')], {
              distance: 8, duration: 0.55, opacity: 0.8,
            });
          } else {
            cards.push(target);
          }
        }
        reveal(cards);
      }, { rootMargin: '0px 0px -16px 0px', threshold: 0.08 });

      function watch(element) {
        if (element && !revealed.has(element)) visibility.observe(element);
      }

      watch(hero);
      const gridUpdates = new MutationObserver(records => {
        for (const { addedNodes, removedNodes } of records) {
          for (const node of removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            visibility.unobserve(node);
            active.get(node)?.revert();
            active.delete(node);
          }
          for (const node of addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) watch(node);
          }
        }
      });
      for (const grid of grids) {
        [...grid.children].forEach(watch);
        gridUpdates.observe(grid, { childList: true });
      }

      const bookUpdates = new MutationObserver(() => {
        const intro = lookbook.querySelector('.lookbook-intro');
        active.get(intro)?.revert();
        active.delete(intro);
        if (lookbook.open && lookbook.scrollTop < 32) {
          reveal([intro], { distance: 8, duration: 0.35, opacity: 0.85 });
        }
      });
      bookUpdates.observe(lookbook, { attributes: true, attributeFilter: ['open'] });

      function settleFocus({ target }) {
        for (const [element, tween] of active) {
          if (element.contains(target)) {
            tween.revert();
            active.delete(element);
          }
        }
      }
      document.addEventListener('focusin', settleFocus);

      function revealPhoto({ target }) {
        const tween = gsap.fromTo(target, { opacity: 0.55 }, {
          opacity: 1,
          duration: 0.22,
          ease: 'power2.out',
          overwrite: 'auto',
          clearProps: 'opacity',
          onComplete: () => active.delete(target),
        });
        active.set(target, tween);
      }
      document.addEventListener('wardrobe:photo-ready', revealPhoto);

      return () => {
        visibility.disconnect();
        gridUpdates.disconnect();
        bookUpdates.disconnect();
        document.removeEventListener('focusin', settleFocus);
        document.removeEventListener('wardrobe:photo-ready', revealPhoto);
        for (const tween of active.values()) tween.revert();
        active.clear();
      };
    });
  }

  if (Lenis) {
    const desktopMotion = window.matchMedia(`${finePointer} and ${motionAllowed}`);
    let scroll;
    const resetScroll = () => scroll?.reset();
    const dialogUpdates = new MutationObserver(() => {
      if (document.querySelector('dialog[open]')) resetScroll();
    });

    function updateScroll() {
      if (!desktopMotion.matches) {
        scroll?.destroy();
        scroll = null;
        dialogUpdates.disconnect();
        return;
      }
      scroll = new Lenis({
        autoRaf: true,
        syncTouch: false,
        lerp: 0.17,
        virtualScroll: ({ event, deltaX, deltaY }) =>
          Math.abs(deltaY) >= Math.abs(deltaX) && !event.shiftKey && !document.querySelector('dialog[open]'),
      });
      for (const dialog of dialogs) {
        dialogUpdates.observe(dialog, { attributes: true, attributeFilter: ['open'] });
      }
    }

    window.addEventListener('hashchange', resetScroll);
    window.addEventListener('keydown', ({ key }) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) resetScroll();
    });
    document.addEventListener('focusin', resetScroll);
    desktopMotion.addEventListener('change', updateScroll);
    updateScroll();
  }
})();
