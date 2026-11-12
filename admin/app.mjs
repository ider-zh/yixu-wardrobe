export function createAdminApp({ document, fetch, confirm }) {
  const $ = (selector) => document.querySelector(selector);
  let csrf = '';
  let pending = Promise.resolve();
  let busy = false;
  let resultOffset = 0;
  const resultIds = new Set();
  const runtimeFields = { model: '#provider-model', api_base: '#provider-api-base', proxy_url: '#provider-proxy', size: '#provider-size', quality: '#provider-quality', provider_timeout_seconds: '#provider-timeout' };
  let supportedRuntime = new Set();
  const showSession = (authenticated) => {
    $('#login-panel').hidden = authenticated;
    $('#workspace').hidden = !authenticated;
  };
  function run(action) {
    if (busy) return pending;
    busy = true;
    $('#error').hidden = true;
    $('#notice').textContent = '正在处理，请稍候…';
    const controls = [...document.querySelectorAll('button')];
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
    document.querySelectorAll('[data-metric]').forEach(element => { element.textContent = '—'; });
    $('#popular-looks').replaceChildren();
    $('#recent-jobs').replaceChildren();
    $('#results-grid').replaceChildren();
    $('#models-grid').replaceChildren();
    $('#cdn-jobs').replaceChildren();
    $('#content-status').textContent = '尚未读取资源状态。';
    $('#cdn-status').textContent = '尚未读取 CDN 配置。';
    $('#cdn-progress').textContent = '尚无同步进度。';
    $('#models-status').textContent = '尚未读取模特。';
    document.querySelectorAll('[data-cdn-metric]').forEach(element => { element.textContent = '—'; });
    $('#results-empty').hidden = true;
    $('#load-more-results').hidden = true;
    resultOffset = 0;
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
      run(async () => {
        await request(`/results/${encodeURIComponent(item.id)}/review`, { method: 'POST', body: { verdict: verdict.value, notes: notes.value } });
        await loadResults();
        $('#notice').textContent = '评价已保存，并已重新读取生成结果。';
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
  async function loadResults(reset = true) {
    const offset = reset ? 0 : resultOffset;
    const data = await request(`/results?offset=${offset}&limit=24`);
    if (reset) {
      $('#results-grid').replaceChildren();
      resultIds.clear();
    }
    for (const item of data.items) {
      if (resultIds.has(item.id)) continue;
      $('#results-grid').append(resultCard(item));
      resultIds.add(item.id);
    }
    resultOffset = offset + data.items.length;
    $('#results-empty').hidden = resultIds.size > 0;
    $('#load-more-results').hidden = !data.has_more;
    $('#notice').textContent = '生成结果已更新。';
  }
  $('#refresh-results').addEventListener('click', () => run(() => loadResults()));
  $('#load-more-results').addEventListener('click', () => run(() => loadResults(false)));
  async function loadOverview() {
    const data = await request('/overview');
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
    const sections = await Promise.allSettled([loadOverview(), loadResults(), loadSettings(), loadContent(), loadModels()]);
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
    showSession(data.authenticated);
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
      showSession(true);
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
      if (new_password.length < 16) throw new Error('新密码至少需要 16 个字符。');
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
