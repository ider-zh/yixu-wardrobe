/* Apply the site's layout without replacing the current view or its workflow. */
(() => {
  'use strict';

  const root = document.documentElement;
  const admin = root.dataset.siteContext === 'admin';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const themes = new Set([
    'editorial', 'studio', 'contact-sheet', 'salon-album', 'wardrobe-index',
    'linen-room', 'indigo-studio', 'porcelain-case', 'night-runway',
    'city-billboard', 'garden-walk', 'sunset-notes',
  ]);
  const listeners = new Set();
  let theme;
  let adminLayout;
  let adminPanels;
  let adminNav;

  function arrangePublic(studio) {
    const hero = document.querySelector('.latest-hero');
    const copy = hero?.querySelector('.hero-copy');
    if (!copy) return;
    if (studio) hero.append(copy);
    else hero.prepend(copy);
  }

  function arrangeAdmin(studio) {
    const workspace = document.getElementById('workspace');
    if (!workspace) return;
    if (!adminPanels) {
      adminNav = workspace.querySelector('.section-nav');
      adminPanels = [...workspace.children].filter(node => node.matches('section.panel'));
    }
    if (!adminNav) return;
    if (studio) {
      if (!adminLayout) {
        adminLayout = document.createElement('div');
        adminLayout.className = 'site-admin-layout';
        const content = document.createElement('div');
        content.className = 'site-admin-content';
        adminLayout.append(content);
      }
      // Keep all private nodes within their original authenticated workspace.
      workspace.append(adminLayout);
      adminLayout.prepend(adminNav);
      adminLayout.querySelector('.site-admin-content').append(...adminPanels);
    } else if (adminLayout?.parentNode) {
      workspace.append(adminNav, ...adminPanels);
      adminLayout.remove();
    }
  }

  function apply(nextTheme) {
    if (!themes.has(nextTheme)) return false;
    if (nextTheme === theme) return true;
    const studio = nextTheme === 'studio';
    const layoutChanged = studio !== (theme === 'studio');
    theme = nextTheme;
    root.dataset.siteTheme = theme;
    if (themeColor) {
      const paper = window.getComputedStyle(root).getPropertyValue('--paper').trim();
      if (paper) themeColor.content = paper;
    }
    if (layoutChanged) {
      const active = document.activeElement;
      if (admin) arrangeAdmin(studio);
      else arrangePublic(studio);
      if (active?.isConnected && document.activeElement !== active) {
        active.focus?.({preventScroll: true});
      }
    }
    for (const listener of listeners) listener({theme});
    return true;
  }

  apply('editorial');
  window.YixuSiteTheme = Object.freeze({
    ...(admin ? {apply} : {}),
    resolve: () => theme,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  if (admin || !['http:', 'https:'].includes(window.location?.protocol) ||
      typeof window.fetch !== 'function') return;

  let revision = 0;
  async function refresh() {
    const request = ++revision;
    try {
      const response = await window.fetch('/api/site-theme', {
        credentials: 'omit',
        cache: 'no-store',
        headers: {Accept: 'application/json'},
      });
      if (!response.ok) return;
      const setting = await response.json();
      if (request === revision) apply(setting?.theme);
    } catch {
      // Keep the current layout when the site setting is unavailable.
    }
  }

  refresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) refresh();
  });
})();
