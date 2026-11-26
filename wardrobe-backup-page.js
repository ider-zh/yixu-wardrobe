(() => {
  'use strict';

  function create({capture, restore, escapeText}) {
    const byId = id => document.getElementById(id);
    const schema = window.WardrobeBackupSchema;
    const page = byId('backup-page');
    const exportButton = byId('backup-export');
    const input = byId('backup-file');
    const preview = byId('backup-preview');
    const counts = byId('backup-preview-counts');
    const applyButton = byId('backup-apply');
    const status = byId('backup-status');
    const results = byId('backup-results');
    if (!schema || !page || !exportButton || !input || !preview || !counts || !applyButton || !status || !results) return;

    let selection = 0;
    let reading = false;
    let writing = false;
    let verified = null;

    function syncControls() {
      input.disabled = writing;
      exportButton.disabled = reading || writing;
      applyButton.disabled = !verified || reading || writing;
    }

    function returnFocus(previous, target) {
      if (!page.hidden && previous && [previous, document.body].includes(document.activeElement)) {
        target.focus();
      }
    }

    function download(data) {
      const body = new Blob([JSON.stringify(data, null, 2) + '\n'], {type:'application/json'});
      const url = window.URL.createObjectURL(body);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'yixu-wardrobe-backup.json';
      link.hidden = true;
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      }
    }

    exportButton.addEventListener('click', async () => {
      if (reading || writing) return;
      const focus = document.activeElement === exportButton ? exportButton : null;
      writing = true;
      status.textContent = '正在准备备份文件…';
      syncControls();
      try {
        download(schema.validate(await capture()));
        status.textContent = '备份文件已生成。';
      } catch (error) {
        status.textContent = error?.message || '无法导出备份文件。';
      } finally {
        writing = false;
        syncControls();
        returnFocus(focus, exportButton);
      }
    });

    async function readFile(file) {
      let text;
      try { text = await file.text(); }
      catch { throw new Error('无法读取备份文件。'); }
      try { return JSON.parse(text); }
      catch { throw new Error('备份文件不是有效的 JSON。'); }
    }

    function showCounts(totals) {
      const sections = [
        ['收藏穿搭', `${totals.favoriteLooks} 套`],
        ['收藏单品', `${totals.favoriteProducts} 件`],
        ['搭配清单', `${totals.lists} 份，${totals.listEntries} 项`],
        ['一周穿搭计划', `${totals.weekDays} 天`],
        ['打包清单', totals.hasPacking ? `${totals.packingEntries} 项` : '无'],
      ];
      counts.innerHTML = sections.map(([label, count]) => `<div><dt>${label}</dt><dd>${count}</dd></div>`).join('');
    }

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file || writing) return;
      const current = ++selection;
      reading = true;
      verified = null;
      preview.hidden = true;
      results.replaceChildren();
      status.textContent = '正在检查备份文件…';
      syncControls();
      try {
        const data = await readFile(file);
        if (current !== selection) return;
        const normalized = schema.validate(data);
        showCounts(schema.summary(normalized));
        verified = normalized;
        preview.hidden = false;
        status.textContent = `已检查「${file.name}」。确认后即可导入。`;
      } catch (error) {
        if (current === selection) status.textContent = error?.message || '无法检查备份文件。';
      } finally {
        if (current === selection) {
          input.value = '';
          reading = false;
          syncControls();
        }
      }
    });

    applyButton.addEventListener('click', async () => {
      if (!verified || reading || writing) return;
      const focus = document.activeElement === applyButton ? applyButton : null;
      const staged = verified;
      verified = null;
      writing = true;
      results.replaceChildren();
      status.textContent = '正在导入备份…';
      syncControls();
      try {
        const receipt = await restore(staged);
        const failures = receipt.filter(domain => domain.error).length;
        results.innerHTML = receipt.map(({label, changed, error}) => {
          const message = error ? `恢复失败。${error}` : changed ? '已恢复' : '无变更';
          return `<li><strong>${escapeText(label)}</strong> <span>${escapeText(message)}</span></li>`;
        }).join('');
        status.textContent = failures ? `导入结束。${failures} 项恢复失败。` : '导入完成。';
      } catch (error) {
        status.textContent = error?.message || '未能完成备份导入。';
      } finally {
        writing = false;
        syncControls();
        returnFocus(focus, input);
      }
    });

    syncControls();
  }

  window.WardrobeBackupPage = {create};
})();
