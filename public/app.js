/* htmldrop — 把 HTML 檔案或靜態網站資料夾變成一個可以分享的連結
 *
 * 設計原則：能在瀏覽器做的事就在瀏覽器做（雜湊、gzip 壓縮），
 * Worker 只負責驗證密碼並把已經壓好的位元組寫進 R2，
 * 讀取則完全走 R2 公開網址，不經過任何 Worker。
 */
(() => {
  'use strict';

  const LS_KEY     = 'htmldrop:key';
  const LS_TTL     = 'htmldrop:ttl';
  const LS_HISTORY = 'htmldrop:history';

  const MAX_SINGLE_RAW_BYTES = 10 * 1024 * 1024; // 單檔上限 10 MB
  const MAX_FOLDER_RAW_BYTES = 50 * 1024 * 1024; // 資料夾總大小上限 50 MB
  const HISTORY_MAX   = 20;

  const TTL_TEXT = {
    w: '7 天後自動刪除',
    m: '30 天後自動刪除',
    p: '永久保存',
  };
  const TTL_SHORT = { w: '7 天', m: '30 天', p: '永久' };

  const $ = (id) => document.getElementById(id);

  const el = {
    gate:            $('gate'),
    gateForm:        $('gateForm'),
    keyInput:        $('keyInput'),
    gateError:       $('gateError'),
    signOutBtn:      $('signOutBtn'),

    stage:           $('stage'),
    dropView:        $('dropView'),
    dropzone:        $('dropzone'),
    pickFileBtn:     $('pickFileBtn'),
    pickFolderBtn:   $('pickFolderBtn'),
    fileInput:       $('fileInput'),
    folderInput:     $('folderInput'),
    segs:            Array.from(document.querySelectorAll('.seg')),

    busyView:        $('busyView'),
    busyText:        $('busyText'),

    resultView:      $('resultView'),
    resultUrl:       $('resultUrl'),
    resultMeta:      $('resultMeta'),
    copyBtn:         $('copyBtn'),
    openBtn:         $('openBtn'),
    againBtn:        $('againBtn'),
    uploadError:     $('uploadError'),

    history:         $('history'),
    historyList:     $('historyList'),
    clearHistoryBtn: $('clearHistoryBtn'),

    toast:           $('toast'),
  };

  let uploadKey = localStorage.getItem(LS_KEY) || '';
  let ttl = localStorage.getItem(LS_TTL) || 'm';
  if (!TTL_TEXT[ttl]) ttl = 'm';

  /* ── 工具 ─────────────────────────────────────────────── */

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  let toastTimer;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  /** 內容雜湊 → 10 碼 base36 短代號 */
  async function contentId(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const head = new Uint8Array(digest).subarray(0, 8);
    let n = 0n;
    for (const b of head) n = (n << 8n) | BigInt(b);
    return n.toString(36).padStart(13, '0').slice(3);
  }

  /** 瀏覽器端 gzip */
  async function gzipBytes(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  function titleOf(html, fallback) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const t = m && m[1].replace(/\s+/g, ' ').trim();
    return (t || fallback || '未命名的 HTML').slice(0, 80);
  }

  /* ── 畫面切換 ─────────────────────────────────────────── */

  function showGate(message) {
    el.gate.hidden = false;
    el.stage.hidden = true;
    el.signOutBtn.hidden = true;
    el.gateError.hidden = !message;
    if (message) el.gateError.textContent = message;
    el.keyInput.focus();
  }

  function showStage() {
    el.gate.hidden = true;
    el.stage.hidden = false;
    el.signOutBtn.hidden = false;
    renderHistory();
  }

  function showView(name) {
    el.dropView.hidden   = name !== 'drop';
    el.busyView.hidden   = name !== 'busy';
    el.resultView.hidden = name !== 'result';
    if (name !== 'result') el.uploadError.hidden = true;
  }

  function showError(message) {
    el.uploadError.textContent = message;
    el.uploadError.hidden = false;
    showView('drop');
  }

  /* ── 最近分享 ─────────────────────────────────────────── */

  function readHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  function pushHistory(entry) {
    const items = readHistory().filter((i) => i.url !== entry.url);
    items.unshift(entry);
    localStorage.setItem(LS_HISTORY, JSON.stringify(items.slice(0, HISTORY_MAX)));
    renderHistory();
  }

  function renderHistory() {
    const items = readHistory();
    el.history.hidden = items.length === 0;
    el.historyList.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'history-item';

      const main = document.createElement('div');
      main.className = 'history-main';

      const link = document.createElement('a');
      link.className = 'history-name';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      if (item.fileCount && item.fileCount > 1) {
        const badge = document.createElement('span');
        badge.className = 'history-badge';
        badge.textContent = `📁 ${item.fileCount} 檔`;
        link.append(badge);
      }
      link.append(document.createTextNode(item.title));

      const sub = document.createElement('span');
      sub.className = 'history-sub';
      const when = new Date(item.at);
      sub.textContent = `${when.toLocaleDateString('zh-TW')}　·　${TTL_SHORT[item.ttl] || ''}`;

      main.append(link, sub);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'history-copy';
      copy.textContent = '複製';
      copy.setAttribute('aria-label', `複製「${item.title}」的連結`);
      copy.addEventListener('click', async () => {
        toast(await copyText(item.url) ? '已複製連結' : '複製失敗，請手動選取');
      });

      li.append(main, copy);
      return li;
    }));
  }

  /* ── 資料夾處理工具 ───────────────────────────────────────── */

  /** 遞迴讀取 DataTransferItem (FileSystemEntry) */
  async function getFilesFromEntry(entry, parentPath = '') {
    const items = [];
    if (!entry || entry.name.startsWith('.') || entry.name === '__MACOSX') return items;

    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      items.push({ path: parentPath ? `${parentPath}/${file.name}` : file.name, file });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const entries = await new Promise((resolve) => {
        const result = [];
        const readBatch = () => {
          dirReader.readEntries((batch) => {
            if (!batch || !batch.length) {
              resolve(result);
            } else {
              result.push(...batch);
              readBatch();
            }
          }, () => resolve(result));
        };
        readBatch();
      });

      for (const child of entries) {
        const subParent = parentPath === '' ? '' : (parentPath ? `${parentPath}/${entry.name}` : entry.name);
        const subItems = await getFilesFromEntry(child, subParent);
        items.push(...subItems);
      }
    }
    return items;
  }

  /** 校正資料夾檔案清單：剝離多餘的最外層包裝目錄、尋找入口 HTML */
  function normalizeFolderItems(rawItems) {
    let items = rawItems.filter((i) => {
      const name = i.path.split('/').pop() || '';
      return !name.startsWith('.') && name !== '__MACOSX' && name !== 'Thumbs.db';
    });

    if (!items.length) return { items: [], entryPath: null };

    // 檢查是否有公共最外層前綴（例如 dist/index.html -> index.html）
    const splitPaths = items.map((i) => i.path.split('/'));
    let prefixLen = 0;
    while (true) {
      if (splitPaths[0].length <= prefixLen + 1) break;
      const seg = splitPaths[0][prefixLen];
      if (splitPaths.every((p) => p.length > prefixLen + 1 && p[prefixLen] === seg)) {
        prefixLen++;
      } else {
        break;
      }
    }

    if (prefixLen > 0) {
      items = items.map((i) => ({
        path: i.path.split('/').slice(prefixLen).join('/'),
        file: i.file,
      }));
    }

    // 尋找入口 HTML (優先級: 根目錄 index.html > 子目錄 index.html > 第一個 .html)
    let entryItem = items.find((i) => i.path.toLowerCase() === 'index.html' || i.path.toLowerCase() === 'index.htm');

    if (!entryItem) {
      entryItem = items.find((i) => i.path.toLowerCase().endsWith('/index.html') || i.path.toLowerCase().endsWith('/index.htm'));
    }

    if (!entryItem) {
      entryItem = items.find((i) => /\.(html?|htm)$/i.test(i.path));
    }

    return {
      items,
      entryPath: entryItem ? entryItem.path : null,
      entryItem,
    };
  }

  /** 為整個資料夾計算 SHA-256 ID */
  async function computeFolderId(items) {
    items.sort((a, b) => a.path.localeCompare(b.path));

    const hashes = [];
    for (const item of items) {
      const pathBytes = new TextEncoder().encode(item.path);
      const buf = await item.file.arrayBuffer();
      const fileHash = await crypto.subtle.digest('SHA-256', buf);

      const comb = new Uint8Array(pathBytes.byteLength + fileHash.byteLength);
      comb.set(pathBytes, 0);
      comb.set(new Uint8Array(fileHash), pathBytes.byteLength);

      const combHash = await crypto.subtle.digest('SHA-256', comb);
      hashes.push(new Uint8Array(combHash));
    }

    let totalLen = 0;
    for (const h of hashes) totalLen += h.byteLength;
    const finalComb = new Uint8Array(totalLen);
    let offset = 0;
    for (const h of hashes) {
      finalComb.set(h, offset);
      offset += h.byteLength;
    }

    return contentId(finalComb);
  }

  /* ── 上傳處理 ───────────────────────────────────────────── */

  let uploading = false;

  async function upload(html, fallbackName) {
    if (uploading) return;

    const raw = new TextEncoder().encode(html);
    if (raw.byteLength === 0) return showError('這個檔案是空的。');
    if (raw.byteLength > MAX_SINGLE_RAW_BYTES) {
      return showError(`檔案 ${formatBytes(raw.byteLength)}，超過 ${formatBytes(MAX_SINGLE_RAW_BYTES)} 上限。`);
    }

    uploading = true;
    el.busyText.textContent = '壓縮中…';
    showView('busy');

    try {
      const id = await contentId(raw);
      const gz = await gzipBytes(raw);
      const body = gz || raw;
      const encoding = gz ? 'gzip' : 'identity';

      el.busyText.textContent = '上傳中…';

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-hd-key': uploadKey,
          'x-hd-id': id,
          'x-hd-ttl': ttl,
          'x-hd-enc': encoding,
          'x-hd-type': 'file',
        },
        body,
      });

      if (res.status === 401) {
        uploadKey = '';
        localStorage.removeItem(LS_KEY);
        showView('drop');
        showGate('密碼不正確，請重新輸入。');
        return;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return showError(detail.slice(0, 160) || `上傳失敗（HTTP ${res.status}）。`);
      }

      const data = await res.json();
      const title = titleOf(html, fallbackName);

      el.resultUrl.value = data.url;
      el.openBtn.href = data.url;
      el.resultMeta.textContent =
        `${TTL_TEXT[ttl]}　·　${formatBytes(raw.byteLength)}` +
        (gz ? ` → 實際佔用 ${formatBytes(body.byteLength)}` : '');
      showView('result');

      pushHistory({ url: data.url, title, ttl, at: Date.now(), fileCount: 1 });

      if (await copyText(data.url)) toast('連結已複製');
    } catch (err) {
      showError('上傳失敗：' + (err && err.message ? err.message : '網路錯誤'));
    } finally {
      uploading = false;
    }
  }

  async function uploadFolder(rawItems, folderNameFallback = '靜態網站') {
    if (uploading) return;

    el.busyText.textContent = '解析資料夾中…';
    showView('busy');

    const { items, entryPath, entryItem } = normalizeFolderItems(rawItems);

    if (!items.length) return showError('資料夾是空的或只包含隱藏檔。');
    if (!entryPath) return showError('資料夾內找不到任何 HTML 檔案（請包含 index.html）。');

    let totalRawBytes = 0;
    for (const item of items) totalRawBytes += item.file.size;
    if (totalRawBytes > MAX_FOLDER_RAW_BYTES) {
      return showError(`資料夾大小 ${formatBytes(totalRawBytes)}，超過 ${formatBytes(MAX_FOLDER_RAW_BYTES)} 上限。`);
    }

    uploading = true;

    try {
      el.busyText.textContent = `打包中 (${items.length} 個檔案)…`;

      // 讀取入口 HTML 的 title
      let folderTitle = folderNameFallback;
      if (entryItem) {
        const text = await entryItem.file.text().catch(() => '');
        if (text) folderTitle = titleOf(text, folderNameFallback);
      }

      // 產生二進位封包與 Manifest
      const manifest = [];
      const fileBuffers = [];

      for (const item of items) {
        const buf = await item.file.arrayBuffer();
        fileBuffers.push(new Uint8Array(buf));
        manifest.push({
          path: item.path,
          type: item.file.type || 'application/octet-stream',
          size: buf.byteLength,
        });
      }

      const manifestStr = JSON.stringify(manifest);
      const manifestBytes = new TextEncoder().encode(manifestStr);

      let payloadSize = 4 + manifestBytes.byteLength;
      for (const buf of fileBuffers) payloadSize += buf.byteLength;

      const rawPayload = new Uint8Array(payloadSize);
      const dataView = new DataView(rawPayload.buffer);
      dataView.setUint32(0, manifestBytes.byteLength, false);

      rawPayload.set(manifestBytes, 4);

      let offset = 4 + manifestBytes.byteLength;
      for (const buf of fileBuffers) {
        rawPayload.set(buf, offset);
        offset += buf.byteLength;
      }

      el.busyText.textContent = '計算雜湊與壓縮中…';
      const id = await computeFolderId(items);
      const gzPayload = await gzipBytes(rawPayload);
      const body = gzPayload || rawPayload;
      const encoding = gzPayload ? 'gzip' : 'identity';

      el.busyText.textContent = `上傳中 (${items.length} 個檔案)…`;

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-hd-key': uploadKey,
          'x-hd-id': id,
          'x-hd-ttl': ttl,
          'x-hd-enc': encoding,
          'x-hd-type': 'folder',
          'x-hd-entry': entryPath,
        },
        body,
      });

      if (res.status === 401) {
        uploadKey = '';
        localStorage.removeItem(LS_KEY);
        showView('drop');
        showGate('密碼不正確，請重新輸入。');
        return;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return showError(detail.slice(0, 160) || `上傳失敗（HTTP ${res.status}）。`);
      }

      const data = await res.json();

      el.resultUrl.value = data.url;
      el.openBtn.href = data.url;
      el.resultMeta.textContent =
        `${TTL_TEXT[ttl]}　·　${items.length} 個檔案 (${formatBytes(totalRawBytes)})` +
        (gzPayload ? ` → 實際傳送 ${formatBytes(body.byteLength)}` : '');
      showView('result');

      pushHistory({
        url: data.url,
        title: folderTitle,
        ttl,
        at: Date.now(),
        fileCount: items.length,
      });

      if (await copyText(data.url)) toast('連結已複製');
    } catch (err) {
      showError('資料夾上傳失敗：' + (err && err.message ? err.message : '網路錯誤'));
    } finally {
      uploading = false;
    }
  }

  async function uploadFile(file) {
    if (file.size > MAX_SINGLE_RAW_BYTES) {
      return showError(`檔案 ${formatBytes(file.size)}，超過 ${formatBytes(MAX_SINGLE_RAW_BYTES)} 上限。`);
    }
    upload(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  }

  function pickHtmlFile(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return null;
    return files.find((f) => /\.(html?|htm)$/i.test(f.name) || f.type === 'text/html') || files[0];
  }

  /* ── 事件監聽 ───────────────────────────────────────────── */

  el.gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = el.keyInput.value.trim();
    if (!value) return;
    uploadKey = value;
    localStorage.setItem(LS_KEY, value);
    el.keyInput.value = '';
    showStage();
    showView('drop');
  });

  el.signOutBtn.addEventListener('click', () => {
    uploadKey = '';
    localStorage.removeItem(LS_KEY);
    showGate();
  });

  el.pickFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.fileInput.click();
  });

  el.pickFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.folderInput.click();
  });

  el.dropzone.addEventListener('click', (e) => {
    if (e.target.closest('.dropzone-actions')) return;
    el.fileInput.click();
  });

  el.fileInput.addEventListener('change', () => {
    const file = pickHtmlFile(el.fileInput.files);
    if (file) uploadFile(file);
    el.fileInput.value = '';
  });

  el.folderInput.addEventListener('change', async () => {
    const files = Array.from(el.folderInput.files || []);
    if (files.length > 0) {
      const rawItems = files.map((f) => ({
        path: f.webkitRelativePath || f.name,
        file: f,
      }));
      const folderName = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : '資料夾';
      await uploadFolder(rawItems, folderName);
    }
    el.folderInput.value = '';
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    el.dropzone.classList.add('is-over');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.classList.remove('is-over'); }
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('is-over');
    if (el.stage.hidden) return;

    const items = Array.from(e.dataTransfer.items || []);
    const entries = items
      .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
      .filter(Boolean);

    const hasDirectory = entries.some((entry) => entry.isDirectory);

    if (hasDirectory) {
      const allFiles = [];
      for (const entry of entries) {
        const subFiles = await getFilesFromEntry(entry, '');
        allFiles.push(...subFiles);
      }
      const folderName = entries.find((e) => e.isDirectory)?.name || '拖曳資料夾';
      await uploadFolder(allFiles, folderName);
    } else {
      const file = pickHtmlFile(e.dataTransfer.files);
      if (file) uploadFile(file);
    }
  });

  document.addEventListener('paste', (e) => {
    if (el.stage.hidden) return;
    const target = e.target;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

    const file = pickHtmlFile(e.clipboardData && e.clipboardData.files);
    if (file) { e.preventDefault(); uploadFile(file); return; }

    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text.trim()) return;
    if (!text.includes('<') || text.trim().length < 20) {
      toast('貼上的內容看起來不是 HTML');
      return;
    }
    e.preventDefault();
    upload(text, '貼上的 HTML');
  });

  el.segs.forEach((seg) => {
    seg.addEventListener('click', () => {
      ttl = seg.dataset.ttl;
      localStorage.setItem(LS_TTL, ttl);
      el.segs.forEach((s) => s.setAttribute('aria-checked', String(s === seg)));
    });
  });

  el.copyBtn.addEventListener('click', async () => {
    el.resultUrl.select();
    toast(await copyText(el.resultUrl.value) ? '已複製連結' : '複製失敗，請手動選取');
  });

  el.againBtn.addEventListener('click', () => {
    showView('drop');
    el.dropzone.focus();
  });

  el.clearHistoryBtn.addEventListener('click', () => {
    localStorage.removeItem(LS_HISTORY);
    renderHistory();
  });

  /* ── 起始狀態 ─────────────────────────────────────────── */

  el.segs.forEach((s) => s.setAttribute('aria-checked', String(s.dataset.ttl === ttl)));
  showView('drop');
  if (uploadKey) showStage(); else showGate();
})();
