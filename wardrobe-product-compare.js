(() => {
  'use strict';

  function create({products, escapeText, imageAttributes}) {
    const dialog = document.getElementById('piece-compare-dialog');
    const close = document.getElementById('close-piece-compare');
    const title = document.getElementById('piece-compare-title');
    const choice = document.getElementById('piece-compare-choice');
    const content = document.getElementById('piece-compare-content');
    const status = document.getElementById('piece-compare-status');
    const esc = escapeText;
    let firstId = '';
    let secondId = '';
    let opener = null;

    function card(product) {
      const name = esc(product.name);
      const material = esc(product.design_material.replace(/，视觉设计描述$/, ''));
      const notes = product.notes.map(note => `<li>${esc(note)}</li>`).join('');
      return `<article class="piece-compare-card">
        <div class="piece-compare-photo"><img ${imageAttributes(product.asset)} alt="${name}" decoding="async"></div>
        <h3>${name}</h3>
        <dl class="piece-compare-facts">
          <div><dt>色调</dt><dd>${esc(product.color_name)}</dd></div>
          <div><dt>视觉肌理</dt><dd>${material}</dd></div>
        </dl>
        ${notes ? `<h4>设计要点</h4><ul class="piece-compare-notes">${notes}</ul>` : ''}
        <a id="piece-compare-link-${esc(product.product_id)}" data-piece-compare-detail href="#/product/${esc(product.product_id)}" aria-label="查看 ${name} 的单品详情">查看单品详情 ↗</a>
      </article>`;
    }

    function render() {
      const items = products();
      const first = items.find(product => product.product_id === firstId);
      const alternatives = first ? items.filter(product => product.product_id !== firstId && product.category === first.category) : [];
      const second = alternatives.find(product => product.product_id === secondId);
      const unavailableSecond = !!secondId && !second;
      if (!second) secondId = '';

      title.textContent = first ? `${first.category}对比` : '同类单品对比';
      choice.innerHTML = '<option value="">不选择第二件</option>' + alternatives.map(product => (
        `<option value="${esc(product.product_id)}">${esc(product.name)}</option>`
      )).join('');
      choice.value = secondId;
      choice.disabled = !alternatives.length;
      content.innerHTML = first ? card(first) + (second ? card(second) : '') : '';

      if (!first) status.textContent = '第一件单品当前不可对比。';
      else if (unavailableSecond) status.textContent = '第二件单品当前不可对比，请重新选择同类单品。';
      else if (!alternatives.length) status.textContent = '当前没有其他同类单品。';
      else status.textContent = second ? `正在与 ${second.name} 对比。` : '';
    }

    choice.addEventListener('change', () => {
      secondId = choice.value;
      render();
    });
    close.addEventListener('click', () => dialog.close());
    content.addEventListener('click', event => {
      const link = event.target.closest('[data-piece-compare-detail]');
      if (link && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      const target = opener?.isConnected ? opener : opener?.id ? document.getElementById(opener.id) : null;
      if (target && !target.closest('[hidden]')) target.focus({preventScroll:true});
      firstId = '';
      secondId = '';
      opener = null;
    });

    function open(id, trigger = document.activeElement) {
      if (!dialog.open) opener = trigger;
      firstId = id;
      secondId = '';
      render();
      if (!dialog.open) dialog.showModal();
      (choice.disabled ? close : choice).focus();
    }

    function refresh() {
      if (!dialog.open) return;
      const active = document.activeElement;
      const activeLink = content.contains(active) ? active.id : '';
      render();
      if (activeLink) (document.getElementById(activeLink) || (choice.disabled ? close : choice)).focus({preventScroll:true});
      else if (choice.disabled && active === choice) close.focus();
    }

    return {open, refresh};
  }

  window.WardrobeProductCompare = {create};
})();
