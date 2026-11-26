(() => {
  'use strict';

  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekRoute = date => '#/week?' + new URLSearchParams({date});

  function create({escapeText, looks, resolveEntry}) {
    const byId = id => document.getElementById(id);
    const page = byId('week-page');
    const previous = byId('week-previous');
    const next = byId('week-next');
    const today = byId('week-today');
    const range = byId('week-range');
    const days = byId('week-days');
    const form = byId('week-form');
    const dateChoice = byId('week-date');
    const lookChoice = byId('week-look');
    const status = byId('week-status');
    const plan = window.WardrobeWeekPlan;
    const esc = escapeText;
    const pending = new Set();
    let anchor = '';
    let dates = [];
    let renderNumber = 0;
    let readFailed = false;

    function weekLink(link, date, offset) {
      try {
        link.href = weekRoute(plan.shiftDate(date, offset));
        link.removeAttribute('aria-disabled');
      } catch {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
      }
    }

    function updateChoices(sameAnchor) {
      const currentDate = sameAnchor && dates.includes(dateChoice.value) ? dateChoice.value : anchor;
      const currentLook = sameAnchor ? lookChoice.value : '';
      const outfits = looks();
      dateChoice.innerHTML = dates.map((date, index) => `<option value="${date}">${weekdays[index]} ${date}</option>`).join('');
      dateChoice.value = currentDate;
      lookChoice.innerHTML = '<option value="">请选择穿搭</option>' + outfits.map(({id, title}) => (
        `<option value="${id}">${esc(title)}</option>`
      )).join('');
      lookChoice.value = outfits.some(look => String(look.id) === currentLook) ? currentLook : '';
    }

    function dayMarkup(date, index, record, todayKey) {
      const item = record && resolveEntry(record.lookId);
      const labelId = `week-day-label-${date}`;
      const outfit = item
        ? `<a id="week-look-${date}" data-week-look="${record.lookId}" href="${esc(item.href)}">${esc(item.title)}</a>`
        : record ? `<span>穿搭 ${record.lookId}（当前目录暂无）</span>` : '<span>尚未安排</span>';
      return `<li id="week-day-${date}" class="week-day" data-week-day="${date}" tabindex="-1" aria-labelledby="${labelId}">
        <span id="${labelId}" class="week-day-date">${weekdays[index]} <time datetime="${date}"${date === todayKey ? ' aria-current="date"' : ''}>${date}</time></span>
        <span class="week-day-outfit">${outfit}</span>
        ${record ? `<button type="button" id="week-remove-${date}" data-week-remove="${date}" aria-label="移除 ${date} 的安排">移除</button>` : ''}
      </li>`;
    }

    function renderDays(records, todayKey) {
      const active = days.contains(document.activeElement) ? document.activeElement : null;
      const activeDay = active?.closest('[data-week-day]');
      const byDate = new Map(records.map(record => [record.date, record]));
      days.innerHTML = dates.map((date, index) => dayMarkup(date, index, byDate.get(date), todayKey)).join('');
      if (active?.id && !page.hidden) {
        (byId(active.id) || byId(activeDay?.id) || dateChoice).focus({preventScroll:true});
      }
    }

    async function render(date) {
      const number = ++renderNumber;
      const sameAnchor = anchor === date;
      const todayKey = plan.todayKey();
      today.href = '#/week';
      try {
        const nextDates = plan.weekDates(date);
        if (nextDates[0] !== dates[0]) days.innerHTML = '';
        dates = nextDates;
      } catch (error) {
        anchor = '';
        dates = [];
        range.textContent = '';
        days.innerHTML = '';
        weekLink(previous, date, -7);
        weekLink(next, date, 7);
        updateChoices(false);
        status.textContent = error.message;
        return false;
      }
      anchor = date;
      if (!sameAnchor) status.textContent = '';
      range.textContent = `${dates[0]} 至 ${dates[6]}`;
      weekLink(previous, anchor, -7);
      weekLink(next, anchor, 7);
      updateChoices(sameAnchor);

      try {
        const records = await plan.load();
        if (number !== renderNumber) return false;
        renderDays(records, todayKey);
        if (readFailed) status.textContent = '';
        readFailed = false;
        return true;
      } catch (error) {
        if (number === renderNumber) {
          readFailed = true;
          status.textContent = error.message;
        }
        return false;
      }
    }

    async function change(date, action, confirmation) {
      if (!dates.includes(date) || pending.has(date)) return;
      pending.add(date);
      try {
        await action();
        if (dates.includes(date) && !page.hidden && await render(anchor) && !page.hidden) {
          status.textContent = confirmation;
        }
      } catch (error) {
        if (dates.includes(date) && !page.hidden) status.textContent = error.message;
      } finally {
        pending.delete(date);
      }
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      const date = dateChoice.value;
      const id = Number(lookChoice.value);
      if (!looks().some(look => look.id === id)) {
        status.textContent = '请选择当前目录中的穿搭。';
        lookChoice.focus();
        return;
      }
      void change(date, () => plan.assign(date, id), `已保存 ${date} 的安排。`);
    });

    days.addEventListener('click', event => {
      const button = event.target.closest('[data-week-remove]');
      if (!button) return;
      const date = button.dataset.weekRemove;
      void change(date, () => plan.remove(date), `已移除 ${date} 的安排。`);
    });

    plan.subscribe(() => {
      if (anchor && !page.hidden) void render(anchor);
    });

    return {render};
  }

  window.WardrobeWeekPage = {create};
})();
