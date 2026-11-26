export function createAdminApp({ document, fetch, confirm, applySiteTheme = theme => globalThis.YixuSiteTheme?.apply?.(theme) }) {
  const $ = (selector) => document.querySelector(selector);
  let csrf = '';
  let pending = Promise.resolve();
  let busy = false;
  let passwordMinimum = 16;
  let savedSiteTheme = null;
  let resultOffset = 0;
  let resultVerdict = '';
  const resultIds = new Set();
  const resultFilter = $('#result-verdict-filter');
  const runtimeFields = { model: '#provider-model', api_base: '#provider-api-base', proxy_url: '#provider-proxy', size: '#provider-size', quality: '#provider-quality', provider_timeout_seconds: '#provider-timeout' };
  let supportedRuntime = new Set();
  const showSession = (authenticated, minimum) => {
    $('#login-panel').hidden = authenticated;
    $('#workspace').hidden = !authenticated;
    passwordMinimum = authenticated && Number.isInteger(minimum) && minimum >= 8 && minimum <= 16 ? minimum : 16;
    for (const selector of ['#new-password', '#confirm-password']) {
      $(selector).setAttribute('minlength', String(passwordMinimum));
    }
    $('#password-help').textContent = `至少 ${passwordMinimum} 个字符，建议使用密码管理器创建并保存独立密码。`;
  };
  function run(action) {
    if (busy) return pending;
    busy = true;
    $('#error').hidden = true;
    $('#notice').textContent = '正在处理，请稍候…';
    const controls = [...document.querySelectorAll('button:not([data-visitor-page]), #result-verdict-filter')];
    controls.forEach(button => { button.disabled = true; });
    $('#main').setAttribute('aria-busy', 'true');
    pending = (async () => {
      try { await action(); }
      catch (error) {
        if (error.sessionExpired) {
          csrf = '';
          clearPrivate();
          showSession(false);
          try { csrf = (await request('/bootstrap')).csrf_token; } catch { /* Reconnect remains available. */ }
        }
        $('#error').textContent = error.sessionExpired ? '管理员会话已失效，请重新登录。' : error.message || '网络连接失败，请重试。';
        $('#error').hidden = false;
        $('#error').focus();
        $('#notice').textContent = '操作未完成，可以重试。';
      } finally {
        busy = false;
        controls.forEach(button => { button.disabled = false; });
        $('#login-form button').disabled = !csrf;
        $('#site-theme-save').disabled = !savedSiteTheme;
        $('#main').setAttribute('aria-busy', 'false');
      }
    })();
    return pending;
  }
  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`/api/admin${path}`, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('无法连接管理服务，请检查网络后重新连接。'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('管理服务响应异常，请稍后重新连接。'); }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map(item => item.msg).filter(Boolean).join('；') : '';
      // A verified session with an incorrect current password is not revoked.
      // Match the backend's distinct validation code, never suppress an auth 401.
      const incorrectCurrent = path === '/password' && response.status === 403 && data.error?.code === 'current_password';
      throw Object.assign(new Error(incorrectCurrent ? '当前密码不正确，请重新输入；管理员会话仍有效。' : data.error?.message || detail || '请求未成功，请稍后重试。'), { sessionExpired: response.status === 401 && path !== '/login' && path !== '/bootstrap' });
    }
    return data;
  }
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const statusNames = { queued: '排队中', validating: '照片校验中', generating: '生成中', postprocessing: '结果处理中', succeeded: '已完成', failed: '失败', unknown: '状态待确认', needs_photo: '需要重新提供照片', canceled: '已取消', expired: '已过期' };
  const timeText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  };
  function clearPasswordInputs() {
    for (const selector of ['#current-password', '#new-password', '#confirm-password', '#login-password']) $(selector).value = '';
  }
  function clearPrivate() {
    clearPasswordInputs();
    savedSiteTheme = null;
    setFieldValue($('#site-theme-select'), '');
    $('#site-theme-fields').disabled = true;
    $('#site-theme-status').textContent = '尚未读取网站主题。';
    applySiteTheme('editorial');
    document.querySelectorAll('[data-metric]').forEach(element => { element.textContent = '—'; });
    $('#popular-looks').replaceChildren();
    $('#recent-jobs').replaceChildren();
    clearVisitorGeo();
    $('#results-grid').replaceChildren();
    $('#models-grid').replaceChildren();
    $('#cdn-jobs').replaceChildren();
    $('#content-status').textContent = '尚未读取资源状态。';
    $('#publication-status').textContent = '尚未核对网站发布状态。';
    $('#cdn-status').textContent = '尚未读取 CDN 配置。';
    $('#cdn-progress').textContent = '尚无同步进度。';
    $('#models-status').textContent = '尚未读取模特。';
    document.querySelectorAll('[data-cdn-metric]').forEach(element => { element.textContent = '—'; });
    $('#results-empty').hidden = true;
    $('#load-more-results').hidden = true;
    resultOffset = 0;
    resultVerdict = '';
    setFieldValue(resultFilter, resultVerdict);
    resultIds.clear();
    for (const selector of Object.values(runtimeFields)) setFieldValue($(selector), '');
    $('#provider-key').value = '';
    $('#provider-enabled').checked = false;
    $('#clear-provider-key').checked = false;
    $('#settings-fields').disabled = true;
    $('#provider-status').textContent = '尚未读取配置，不能确认生成可用。';
    $('#provider-summary').textContent = $('#provider-status').textContent;
    $('#key-state').textContent = '密钥状态尚未读取。';
    supportedRuntime.clear();
  }
  function setFieldValue(element, value) {
    if (element.tagName === 'SELECT') {
      [...element.options].forEach(option => { option.selected = false; });
      const selected = [...element.options].find(option => option.value === String(value));
      if (selected) selected.selected = true;
    } else element.value = value;
  }
  const siteThemeLabels = new Map([...$('#site-theme-select').options]
    .filter(option => option.value)
    .map(option => [option.value, option.textContent.split(' · ')[0]]));
  function renderSiteTheme(data, saved = false) {
    const theme = data?.theme;
    const label = siteThemeLabels.get(theme);
    if (!label) throw new Error('主题设置响应异常，请重新读取。');
    savedSiteTheme = theme;
    setFieldValue($('#site-theme-select'), theme);
    applySiteTheme(theme);
    $('#site-theme-fields').disabled = false;
    $('#site-theme-status').textContent = saved ? `已保存，全站使用 ${label}。` : `当前网站主题为 ${label}。`;
  }
  async function loadSiteTheme() {
    try {
      renderSiteTheme(await request('/site-theme'));
    } catch (error) {
      $('#site-theme-status').textContent = '网站主题读取失败，请重新读取。';
      throw error;
    }
  }
  $('#refresh-site-theme').addEventListener('click', () => run(async () => {
    await loadSiteTheme();
    $('#notice').textContent = '已读取网站主题。';
  }));
  $('#site-theme-form').addEventListener('submit', event => {
    event.preventDefault();
    const theme = $('#site-theme-select').value;
    if (!savedSiteTheme || !siteThemeLabels.has(theme)) return;
    run(async () => {
      $('#site-theme-fields').disabled = true;
      $('#site-theme-status').textContent = '正在保存网站主题…';
      try {
        renderSiteTheme(await request('/site-theme', { method: 'PUT', body: { theme } }), true);
        $('#notice').textContent = '网站主题已保存。';
      } catch (error) {
        setFieldValue($('#site-theme-select'), savedSiteTheme);
        $('#site-theme-status').textContent = '未能确认保存结果。当前显示上次读取的主题，请重新读取设置。';
        throw error;
      } finally {
        $('#site-theme-fields').disabled = !savedSiteTheme;
      }
    });
  });
  async function loadSettings() {
    const data = await request('/settings');
    supportedRuntime = new Set(Object.keys(runtimeFields).filter(key => Object.hasOwn(data, key)));
    for (const [key, selector] of Object.entries(runtimeFields)) setFieldValue($(selector), data[key] ?? '');
    document.querySelectorAll('[data-runtime-option]').forEach(element => { element.hidden = !supportedRuntime.has(element.dataset.runtimeOption); });
    $('#provider-enabled').checked = Boolean(data.enabled);
    $('#provider-key').value = '';
    $('#clear-provider-key').checked = false;
    $('#key-state').textContent = data.api_key_configured ? '服务器已有密钥（不可回读）。' : '服务器尚未配置项目密钥。';
    const missing = !data.api_key_configured || !data.model || !data.api_base || !data.proxy_url;
    $('#provider-status').textContent = missing ? '生成服务未配置完整，当前不可用。请检查模型、项目密钥、API 与代理地址。' : !data.enabled ? '生成服务已停用。配置已保存，但不接受新的生成请求。' : '运行配置完整；未验证外部连通或生成可用性。';
    $('#provider-summary').textContent = $('#provider-status').textContent;
    $('#settings-fields').disabled = false;
    $('#notice').textContent = '已读取服务运行设置。';
  }
  $('#refresh-settings').addEventListener('click', () => run(loadSettings));
  $('#settings-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const body = { enabled: $('#provider-enabled').checked };
      for (const key of supportedRuntime) body[key] = key === 'provider_timeout_seconds' ? Number($(runtimeFields[key]).value) : $(runtimeFields[key]).value.trim();
      const key = $('#provider-key').value.trim();
      $('#provider-key').value = '';
      if ($('#clear-provider-key').checked) {
        if (!confirm('确认清除现有项目 API 密钥？生成服务将无法使用该密钥。')) { $('#notice').textContent = '已取消清除密钥，尚未保存设置。'; return; }
        body.clear_api_key = true;
      } else if (key) body.api_key = key;
      await request('/settings', { method: 'PUT', body });
      await loadSettings();
      $('#notice').textContent = '运行设置已保存并重新读取；未发起任何生成请求。';
    });
  });
  function resultCard(item) {
    const card = node('article', undefined, 'result-card');
    card.dataset.resultId = item.id;
    const preview = node('div', undefined, 'result-preview');
    const imagePath = `/api/admin/results/${encodeURIComponent(item.id)}/image`;
    if (item.image_url === imagePath) {
      const link = node('a');
      link.href = imagePath;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `查看造型 ${item.look_id} 的 AI 生成大图（新窗口）`);
      const image = node('img');
      image.src = imagePath;
      image.alt = `AI 生成试穿 · 造型 ${item.look_id} · ${item.edition} / 视角 ${item.shot_index}`;
      image.setAttribute('loading', 'lazy');
      image.setAttribute('referrerpolicy', 'no-referrer');
      image.addEventListener('error', () => {
        image.removeAttribute('src');
        link.replaceWith(node('p', '图片无法加载，结果可能已移除或会话已失效。请刷新结果。', 'preview-error'));
      }, { once: true });
      link.append(image);
      preview.append(link);
    } else preview.append(node('p', '预览不可用：未收到受保护的生成图片地址。', 'preview-error'));
    const info = node('div', undefined, 'result-info');
    info.append(node('span', 'AI 生成', 'status-chip'), node('h3', `造型 ${item.look_id} · ${item.edition} / 视角 ${item.shot_index}`), node('p', timeText(item.created_at), 'muted'));
    const form = node('form', undefined, 'review-form');
    const fieldset = node('fieldset');
    fieldset.append(node('legend', '质量评价（可选，不影响生成）'));
    const verdictLabel = node('label', '评价');
    const verdict = node('select');
    verdict.name = 'verdict';
    for (const [value, label] of [['unreviewed', '未评价'], ['approved', '质量良好'], ['rejected', '需要改进']]) {
      const option = node('option', label);
      option.value = value;
      option.selected = value === (item.review?.verdict || 'unreviewed');
      verdict.append(option);
    }
    verdictLabel.append(verdict);
    const notesLabel = node('label', '质量备注');
    const notes = node('textarea');
    notes.name = 'notes';
    notes.rows = 3;
    notes.placeholder = '例如：衣物结构、人物一致性、画面细节';
    notes.value = item.review?.notes || '';
    notesLabel.append(notes);
    const save = node('button', '保存评价', 'outline');
    save.type = 'submit';
    fieldset.append(verdictLabel, notesLabel, save);
    form.append(fieldset);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const focused = document.activeElement === save;
      let reloaded = false;
      run(async () => {
        const review = { verdict: verdict.value, notes: notes.value };
        await request(`/results/${encodeURIComponent(item.id)}/review`, { method: 'POST', body: review });
        if (resultVerdict && review.verdict !== resultVerdict) {
          card.remove();
          resultIds.delete(item.id);
          resultOffset = 0;
          updateResultsFooter(false);
        }
        await loadResults();
        reloaded = true;
        $('#notice').textContent = '评价已保存，并已重新读取生成结果。';
      }).then(() => {
        if (reloaded && focused && document.activeElement === document.body) resultFilter.focus();
      });
    });
    const remove = node('button', '删除生成结果', 'danger outline');
    remove.type = 'button';
    remove.dataset.action = 'delete-result';
    remove.addEventListener('click', () => {
      if (!confirm(`确认删除造型 ${item.look_id} 的这张生成结果？此操作不可撤销。`)) return;
      run(async () => {
        await request(`/results/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        await loadResults();
        await loadOverview();
        $('#notice').textContent = '生成结果已删除，列表已重新读取。';
      });
    });
    info.append(form, remove);
    card.append(preview, info);
    return card;
  }
  function updateResultsFooter(hasMore) {
    const empty = $('#results-empty');
    empty.hidden = resultIds.size > 0;
    empty.textContent = resultVerdict ? '暂无符合所选评估状态的结果。' : '暂无生成结果。真实完成的试穿将在这里出现。';
    $('#load-more-results').hidden = !hasMore;
  }
  async function loadResults(reset = true, verdict = resultVerdict) {
    const offset = reset ? 0 : resultOffset;
    const params = new URLSearchParams({ offset, limit: 24 });
    if (verdict) params.set('verdict', verdict);
    const data = await request(`/results?${params}`);
    if (reset) {
      resultVerdict = verdict;
      setFieldValue(resultFilter, resultVerdict);
      $('#results-grid').replaceChildren();
      resultIds.clear();
    }
    for (const item of data.items) {
      if (resultIds.has(item.id)) continue;
      $('#results-grid').append(resultCard(item));
      resultIds.add(item.id);
    }
    resultOffset = offset + data.items.length;
    updateResultsFooter(data.has_more);
    $('#notice').textContent = '生成结果已更新。';
  }
  resultFilter.addEventListener('change', () => {
    const verdict = resultFilter.value;
    const focused = document.activeElement === resultFilter;
    let reloaded = false;
    run(async () => {
      try {
        await loadResults(true, verdict);
        reloaded = true;
      } finally {
        setFieldValue(resultFilter, resultVerdict);
      }
    }).then(() => {
      if (reloaded && focused && document.activeElement === document.body) resultFilter.focus();
    });
  });
  $('#refresh-results').addEventListener('click', () => run(() => loadResults()));
  $('#load-more-results').addEventListener('click', () => run(() => loadResults(false)));
  const countText = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat('zh-CN').format(value) : '—';
  const visitorPageSize = 10;
  const visitorLocationStatus = {
    private: '内网或保留地址，无法定位',
    unknown: '地域未知',
    unavailable: '数据库不可用，地域未知',
    legacy: '历史记录，无地域信息',
  };
  let recentVisitors = [];
  let visitorPage = 0;

  function visitorOptions(select, placeholder, labels) {
    const previous = select.value;
    const options = [['', placeholder], ...[...labels].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))];
    select.replaceChildren(...options.map(([value, label]) => {
      const option = node('option', label);
      option.value = value;
      return option;
    }));
    setFieldValue(select, labels.has(previous) ? previous : '');
  }
  function updateVisitorProvinces() {
    const select = $('#visitor-province');
    const chinaSelected = $('#visitor-country').value === 'CN';
    const labels = new Map(chinaSelected ? recentVisitors.filter(row => row.countryCode === 'CN').map(row => [row.provinceKey, row.province]) : []);
    visitorOptions(select, '全部省份', labels);
    select.disabled = !labels.size;
  }
  function renderVisitorTable() {
    const query = $('#visitor-search').value.trim().toLowerCase();
    const country = $('#visitor-country').value;
    const province = $('#visitor-province').value;
    const oldestFirst = $('#visitor-sort').value === 'oldest';
    const matching = recentVisitors.filter(row =>
      (!country || row.countryCode === country) &&
      (!province || row.provinceKey === province) &&
      (!query || row.searchText.includes(query))
    ).sort((a, b) => {
      if (a.lastSeen === null) return b.lastSeen === null ? 0 : 1;
      if (b.lastSeen === null) return -1;
      return oldestFirst ? a.lastSeen - b.lastSeen : b.lastSeen - a.lastSeen;
    });
    const pages = Math.ceil(matching.length / visitorPageSize);
    visitorPage = Math.min(visitorPage, Math.max(0, pages - 1));
    const start = visitorPage * visitorPageSize;
    const stamp = value => Number.isFinite(value) ? timeText(value * 1000) : '时间未知';
    const page = matching.slice(start, start + visitorPageSize);
    const rows = page.map(row => {
      const tr = node('tr');
      for (const text of [row.id, row.country, row.province || '—', countText(row.pageViews), stamp(row.lastSeen), stamp(row.firstSeen)]) tr.append(node('td', text));
      return tr;
    });
    if (!rows.length) {
      const cell = node('td', recentVisitors.length ? '没有符合筛选条件的访客。' : '暂无页面访问记录。', 'muted');
      cell.setAttribute('colspan', '6');
      const row = node('tr');
      row.append(cell);
      rows.push(row);
    }
    $('#recent-visitors').replaceChildren(...rows);
    $('#visitor-time-heading').setAttribute('aria-sort', oldestFirst ? 'ascending' : 'descending');
    $('#visitor-page-status').textContent = pages
      ? `匹配 ${matching.length} / ${recentVisitors.length} · 第 ${visitorPage + 1} / ${pages} 页`
      : `匹配 0 / ${recentVisitors.length}`;
    $('#visitor-pagination').hidden = pages <= 1;
    $('#visitor-prev').disabled = visitorPage === 0;
    $('#visitor-next').disabled = visitorPage + 1 >= pages;
  }
  function resetVisitorPage() {
    visitorPage = 0;
    renderVisitorTable();
  }
  $('#visitor-search').addEventListener('input', resetVisitorPage);
  $('#visitor-country').addEventListener('change', () => {
    updateVisitorProvinces();
    resetVisitorPage();
  });
  $('#visitor-province').addEventListener('change', resetVisitorPage);
  $('#visitor-sort').addEventListener('change', resetVisitorPage);
  for (const [selector, step] of [['#visitor-prev', -1], ['#visitor-next', 1]]) {
    $(selector).addEventListener('click', () => {
      visitorPage += step;
      renderVisitorTable();
    });
  }
  function clearVisitorGeo() {
    recentVisitors = [];
    visitorPage = 0;
    $('#visitor-total').textContent = '—';
    $('#visitor-page-views').textContent = '—';
    $('#visitor-geo-status').textContent = '尚未读取地域统计。';
    for (const id of ['visitor-countries', 'visitor-provinces', 'recent-visitors']) $(`#${id}`).replaceChildren();
    $('#visitor-search').value = '';
    setFieldValue($('#visitor-sort'), 'newest');
    visitorOptions($('#visitor-country'), '全部国家 / 地区', new Map());
    updateVisitorProvinces();
    $('#visitor-page-status').textContent = '';
    $('#visitor-pagination').hidden = true;
  }
  function renderVisitorGeo(geo) {
    if (!geo || typeof geo !== 'object') {
      clearVisitorGeo();
      $('#visitor-geo-status').textContent = '当前服务尚未提供地域统计，历史访问不会推定归属地。';
      return;
    }
    $('#visitor-total').textContent = countText(geo.total_visitors);
    $('#visitor-page-views').textContent = countText(geo.total_page_views);
    const databaseMessages = {
      ready: '离线 IP 数据库已就绪；未知地域与历史记录按实际结果保留。',
      unconfigured: '尚未配置离线 IP 数据库；新的公网访问暂无法确定地域，已有统计仍可查看。',
      unavailable: '离线 IP 数据库暂不可用；访问记录继续保存，无法定位的地域显示未知。',
    };
    $('#visitor-geo-status').textContent = databaseMessages[geo.database?.status] || '地域数据库状态未知，无法确认新访问的定位能力。';
    const distribution = (id, rows, name, empty) => {
      const list = $(`#${id}`);
      const entries = Array.isArray(rows) ? rows.slice(0, 30) : [];
      list.replaceChildren(...entries.map(row => {
        const item = node('li');
        item.append(node('span', name(row)), node('span', `${countText(row.visits)} 次访问 · ${countText(row.visitors)} 个访客`, 'geo-count'));
        return item;
      }));
      if (!entries.length) list.append(node('li', empty, 'geo-empty'));
      if (Array.isArray(rows) && rows.length > 30) list.append(node('li', '按访问数展示前 30 个地域。', 'geo-empty'));
    };
    distribution('visitor-countries', geo.countries, row => row.country_name || row.country_code || '未知国家 / 地区', '暂无国家 / 地区访问记录。');
    distribution('visitor-provinces', geo.china_provinces, row => row.region_name || row.region_code || '中国 · 省级未知', '暂无中国省级访问记录。');
    const visitors = Array.isArray(geo.recent_visitors) ? geo.recent_visitors.slice(0, 20) : [];
    recentVisitors = visitors.map(visitor => {
      const id = visitor.visitor_id || '标识未知';
      const countryCode = visitor.country_code || 'unknown';
      const country = visitor.country_name || visitor.country_code || visitorLocationStatus[visitor.status] || '地域未知';
      const province = countryCode === 'CN' ? visitor.region_name || visitor.region_code || '省级未知' : '';
      return {
        id, countryCode, country, province, provinceKey: countryCode === 'CN' ? visitor.region_code || province : '',
        pageViews: visitor.page_views, firstSeen: visitor.first_seen,
        lastSeen: Number.isFinite(visitor.last_seen) ? visitor.last_seen : null,
        searchText: [id, country, visitor.country_code, province, countryCode === 'CN' ? visitor.region_code : ''].join(' ').toLowerCase(),
      };
    });
    const countries = new Map(recentVisitors.map(row => [row.countryCode, row.countryCode === 'unknown' ? '地域未知' : row.country]));
    visitorOptions($('#visitor-country'), '全部国家 / 地区', countries);
    updateVisitorProvinces();
    renderVisitorTable();
  }
  async function loadOverview() {
    const data = await request('/overview');
    renderVisitorGeo(data.visitor_geo);
    document.querySelectorAll('[data-metric]').forEach(element => {
      const key = element.dataset.metric;
      const value = data[key];
      element.textContent = typeof value !== 'number' ? '—' : key === 'result_bytes' ? `${(value / 1048576).toFixed(2)} MiB` : new Intl.NumberFormat('zh-CN').format(value);
    });
    $('#popular-looks').replaceChildren(...data.popular_looks.map(item => node('li', `造型 ${item.look_id} · ${item.count} 次打开`)));
    if (!data.popular_looks.length) $('#popular-looks').append(node('li', '暂无造型访问记录', 'muted'));
    $('#recent-jobs').replaceChildren(...data.recent_jobs.map(job => {
      const item = node('li');
      item.append(node('strong', `造型 ${job.look_id} · ${job.edition} / 视角 ${job.shot_index}`), node('span', statusNames[job.status] || job.status, 'status-chip'), node('p', `${timeText(job.created_at)} · ${job.id}`, 'muted'));
      if (job.queue_position !== null && job.queue_position !== undefined) item.append(node('p', `前序任务：${job.queue_position}`));
      if (job.error_message) item.append(node('p', job.error_message, 'job-error'));
      return item;
    }));
    if (!data.recent_jobs.length) $('#recent-jobs').append(node('li', '暂无任务', 'muted'));
    $('#notice').textContent = '概览已更新。';
  }
  $('#refresh-overview').addEventListener('click', () => run(loadOverview));
  const cdnStatusNames = { queued: '待同步', uploading: '上传中', verified: '已验证', failed: '失败', unknown: '待人工核对', unconfigured: '未配置' };
  async function loadContent() {
    try {
      const data = await request('/content/overview');
      $('#content-status').textContent = data.content_ready ? `活动版本：${data.revision || '未提供'} · ${data.look_count} 套穿搭 · ${data.model_count} 位模特` : '公开内容尚未就绪；原有内容服务继续独立运行。';
      if (data.import_error) $('#content-status').append(node('span', ` · 内容接收异常：${data.import_error}`));
      const publication = data.publication;
      const featured = data.home?.featured_look_id;
      const featureText = featured ? `首页主推：${featured}${data.featured_title ? `「${data.featured_title}」` : ''}` : '尚无首页主推';
      $('#publication-status').textContent = publication?.status === 'verified'
        ? `${featureText} · 网站交付已验证：${timeText(publication.verified_at)}。已核对当时的 API、静态快照及主推图片；CDN 状态独立显示。`
        : `${featureText} · 网站交付尚未验证。服务端导入成功不代表首页与图片已对外可用，需通过交付命令验收。`;

      const cdn = data.cdn;
      $('#cdn-status').textContent = cdn.config.configured ? `已配置图床接口（${cdn.config.adapter}）；图片逐张校验后使用 CDN。` : 'CDN 未配置；未同步图片继续使用项目图片 URL。';
      document.querySelectorAll('[data-cdn-metric]').forEach(element => { element.textContent = String(cdn.counts[element.dataset.cdnMetric] ?? 0); });
      const size = value => `${(Number(value || 0) / 1048576).toFixed(2)} MiB`;
      $('#cdn-progress').textContent = cdn.total ? `已验证 ${cdn.counts.verified} / ${cdn.total} 张（${Math.round(cdn.counts.verified / cdn.total * 100)}%） · ${size(cdn.verified_bytes)} / ${size(cdn.bytes)}${cdn.last_success ? ` · 最近成功：${timeText(cdn.last_success * 1000)}` : ''}` : '暂无公开图片同步任务；不显示估计进度。';
      $('#cdn-jobs').replaceChildren(...cdn.jobs.map(job => {
        const item = node('li');
        item.append(node('strong', job.asset_id), node('span', cdnStatusNames[job.status] || job.status, 'status-chip'), node('p', `版本 ${job.revision} · 尝试 ${job.attempts} 次 · ${size(job.bytes)}`, 'muted'));
        if (job.error) item.append(node('p', job.error, 'job-error'));
        if (job.status === 'failed' && job.provider_id === cdn.config.provider_id) {
          const retry = node('button', '重试同步', 'outline');
          retry.type = 'button';
          retry.dataset.cdnRetry = String(job.id);
          retry.addEventListener('click', () => run(async () => {
            await request(`/content/cdn/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST' });
            await loadContent();
            $('#notice').textContent = '失败资源已重新排队；项目图片仍可使用。';
          }));
          item.append(retry);
        }
        if (job.status === 'unknown' && job.remote_id && job.provider_id === cdn.config.provider_id) {
          const verify = node('button', '仅核对远端文件', 'outline');
          verify.type = 'button';
          verify.dataset.cdnVerify = String(job.id);
          verify.addEventListener('click', () => run(async () => {
            const result = await request(`/content/cdn/jobs/${encodeURIComponent(job.id)}/verify`, { method: 'POST' });
            await loadContent();
            $('#notice').textContent = result.verified ? '远端文件已验证；没有重新上传。' : '远端文件仍未通过校验；没有重新上传，请继续人工核对。';
          }));
          item.append(verify);
        }
        return item;
      }));
      if (!cdn.jobs.length) $('#cdn-jobs').append(node('li', '暂无同步任务', 'muted'));
    } catch (error) {
      $('#content-status').textContent = '资源状态读取失败，请单独刷新；其他工作台模块可继续使用。';
      $('#publication-status').textContent = '网站发布状态未能核对，请重试。';
      throw error;
    }
  }
  async function loadModels() {
    try {
      const data = await request('/content/models');
      $('#models-grid').replaceChildren(...data.models.map(model => {
        const card = node('article', undefined, 'model-card');
        card.append(node('h3', `${model.name} · ${model.model_id}`));
        const reference = model.reference;
        const source = reference?.source_url || model.source_url;
        if (reference?.asset_id && source === `/api/admin/content/models/${encodeURIComponent(model.model_id)}/reference`) {
          const image = node('img');
          image.src = source;
          image.alt = `${model.name} 基础体多视角参考`;
          image.setAttribute('loading', 'lazy');
          image.setAttribute('referrerpolicy', 'no-referrer');
          image.addEventListener('error', () => { image.removeAttribute('src'); image.replaceWith(node('p', '基础体预览无法加载，请核对资源状态。', 'preview-error')); }, { once: true });
          card.append(image);
        } else card.append(node('p', '未提供可公开预览的基础体资源。', 'muted'));
        const viewNames = { front: '正面', 'three-quarter-front': '前侧', side: '侧面', 'three-quarter-back': '后侧', back: '背面' };
        card.append(node('p', `登记视角：${(model.views || []).map(view => viewNames[view] || view).join('、') || '未登记'}`));
        card.append(node('p', `关联生动穿搭：${Number.isInteger(model.expressive_count) ? model.expressive_count : '未提供'} · ${model.enabled === false ? '已停用' : '已启用'}`, 'muted'));
        return card;
      }));
      $('#models-status').textContent = data.models.length ? `已登记 ${data.models.length} 位系统模特；内容由项目清单维护。` : '当前没有可预览的系统模特。';
    } catch (error) {
      $('#models-status').textContent = '模特资料读取失败，请单独刷新；其他工作台模块可继续使用。';
      throw error;
    }
  }
  $('#refresh-content').addEventListener('click', () => run(loadContent));
  $('#refresh-models').addEventListener('click', () => run(loadModels));
  async function loadDashboard() {
    const sections = await Promise.allSettled([loadOverview(), loadResults(), loadSettings(), loadContent(), loadModels(), loadSiteTheme()]);
    const failures = sections.filter(section => section.status === 'rejected');
    if (failures.length) throw (failures.find(section => section.reason.sessionExpired) || failures[0]).reason;
    $('#notice').textContent = '工作台已更新。数据来自服务端；外部生成尚未在此验证。';
  }
  async function bootstrap() {
    csrf = '';
    clearPrivate();
    showSession(false);
    const data = await request('/bootstrap');
    csrf = data.csrf_token;
    showSession(data.authenticated, data.password_min_length);
    $('#notice').textContent = data.authenticated ? '已登录。' : '请使用管理员凭据登录。';
    if (data.authenticated) await loadDashboard();
  }
  $('#reconnect').addEventListener('click', () => run(bootstrap));
  $('#login-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const password = $('#login-password').value;
      $('#login-password').value = '';
      const data = await request('/login', { method: 'POST', body: { username: $('#login-username').value.trim(), password } });
      csrf = data.csrf_token;
      showSession(true, data.password_min_length);
      await loadDashboard();
    });
  });
  $('#password-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const current_password = $('#current-password').value;
      const new_password = $('#new-password').value;
      const confirmation = $('#confirm-password').value;
      clearPasswordInputs();
      if (new_password !== confirmation) throw new Error('两次新密码不一致，请重新输入。');
      if ([...new_password].length < passwordMinimum) throw new Error(`新密码至少需要 ${passwordMinimum} 个字符。`);
      await request('/password', { method: 'POST', body: { current_password, new_password } });
      clearPrivate();
      showSession(false);
      await bootstrap();
      $('#notice').textContent = '密码已修改，旧会话已失效，请使用新密码重新登录。';
      $('#login-username').focus();
    });
  });
  $('#logout').addEventListener('click', () => run(async () => {
    await request('/logout', { method: 'POST' });
    showSession(false);
    await bootstrap();
  }));
  return { start: () => run(bootstrap), idle: () => pending };
}

if (typeof document !== 'undefined') {
  const app = createAdminApp({ document, fetch: globalThis.fetch.bind(globalThis), confirm: globalThis.confirm.bind(globalThis) });
  app.start();
}
