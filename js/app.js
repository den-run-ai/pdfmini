/* pdfmini UI. The PDF work happens in js/engine.js (window.PDFMini). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const engine = window.PDFMini;
  const compressInput = $('compress-input');
  const combineInput = $('combine-input');
  const touchOnly = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  const STORE_KEY = 'pdfmini.settings.v2';

  // ------------------------------------------------------------ helpers

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function outputName(name, suffix) {
    const base = (name || 'document').replace(/\.pdf$/i, '') || 'document';
    return `${base}-${suffix}.pdf`;
  }

  /** Quick filter for picked/dropped files; the engine checks the real header. */
  function looksLikePdf(file) {
    return /\.pdf$/i.test(file.name) || file.type === 'application/pdf' || file.type === '';
  }

  function errorMessage(err) {
    if (!err) return 'Something went wrong.';
    if (err.name === 'PDFMiniError') return err.message;
    if (err.name === 'NotReadableError') return 'The file could not be read. It may have been moved or deleted.';
    if (/memory|allocation|Array buffer/i.test(err.message || '')) return 'This file is too large for this device. Try a smaller file or a desktop browser.';
    return 'Something went wrong while processing this PDF. Please try another file.';
  }

  const canShareFiles = (() => {
    try {
      return typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })] });
    } catch (e) {
      return false;
    }
  })();

  async function shareFile(bytes, name) {
    const file = new File([bytes], name, { type: 'application/pdf' });
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      // Dismissing the share sheet is not an error worth showing.
    }
  }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }

  function saveSettings(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  /** Progress UI that repaints at most once per frame. */
  function progressView(prefix) {
    const box = $(`${prefix}-progress`);
    const status = $(`${prefix}-status`);
    const bar = $(`${prefix}-bar`);
    let pending = null;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!pending) return;
      const pct = Math.round(Math.max(0, Math.min(1, pending.fraction)) * 100);
      bar.firstElementChild.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      if (pending.message) status.textContent = pending.message;
      pending = null;
    };
    return {
      show() { box.hidden = false; bar.firstElementChild.style.width = '0%'; status.textContent = 'Starting…'; },
      hide() { box.hidden = true; },
      update(fraction, message) {
        pending = { fraction, message };
        if (!frame) frame = requestAnimationFrame(paint);
      },
    };
  }

  function setState(name, value) {
    document.body.dataset[name] = value;
  }

  // ------------------------------------------------------------- tabs

  const tabs = [$('tab-compress'), $('tab-combine')];
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
      }
    });
  });
  const activePanel = () => (tabs[0].getAttribute('aria-selected') === 'true' ? 'compress' : 'combine');

  // -------------------------------------------------- compress: settings

  const levelInputs = Array.from(document.querySelectorAll('input[name="level"]'));
  const opt = {
    mode: $('opt-mode'), dpi: $('opt-dpi'), quality: $('opt-quality'), gray: $('opt-gray'), meta: $('opt-meta'),
  };
  const stored = loadSettings();

  const currentLevel = () => (levelInputs.find((r) => r.checked) || levelInputs[1]).value;
  const levelDefaults = () => engine.LEVELS[currentLevel()];

  function refreshAdvanced() {
    $('opt-dpi-out').textContent = `${opt.dpi.value} dpi`;
    $('opt-quality-out').textContent = `${opt.quality.value}%`;
    const d = levelDefaults();
    const custom = Number(opt.dpi.value) !== d.dpi || Number(opt.quality.value) !== d.quality ||
      opt.mode.value !== 'images' || opt.gray.checked || opt.meta.checked;
    $('custom-badge').hidden = !custom;
    $('mode-hint').textContent = opt.mode.value === 'rasterize'
      ? 'Smallest result for scans and image-heavy files. Text becomes part of the image and is no longer selectable.'
      : 'Text stays sharp and searchable. Best for most documents.';
  }

  function applyLevelDefaults() {
    const d = levelDefaults();
    opt.dpi.value = d.dpi;
    opt.quality.value = d.quality;
    refreshAdvanced();
  }

  function persist() {
    // Only remember resolution/quality the user changed, so new defaults still apply.
    const d = levelDefaults();
    const dpi = Number(opt.dpi.value), quality = Number(opt.quality.value);
    saveSettings({
      level: currentLevel(), mode: opt.mode.value, gray: opt.gray.checked, meta: opt.meta.checked,
      dpi: dpi !== d.dpi ? dpi : undefined, quality: quality !== d.quality ? quality : undefined,
    });
  }

  levelInputs.forEach((r) => {
    if (stored.level && r.value === stored.level) r.checked = true;
    r.addEventListener('change', () => { applyLevelDefaults(); persist(); settingsChanged(); });
  });
  applyLevelDefaults();
  if (stored.dpi) opt.dpi.value = stored.dpi;
  if (stored.quality) opt.quality.value = stored.quality;
  if (stored.mode === 'rasterize') opt.mode.value = 'rasterize';
  opt.gray.checked = !!stored.gray;
  opt.meta.checked = !!stored.meta;
  refreshAdvanced();
  for (const el of Object.values(opt)) {
    el.addEventListener('input', () => { refreshAdvanced(); persist(); settingsChanged(); });
    el.addEventListener('change', () => { refreshAdvanced(); persist(); settingsChanged(); });
  }
  $('opt-reset').addEventListener('click', () => {
    opt.mode.value = 'images';
    opt.gray.checked = false;
    opt.meta.checked = false;
    applyLevelDefaults();
    persist();
    settingsChanged();
  });

  /** A result made with other settings is stale: hide it so Download never means the old file. */
  function settingsChanged() {
    if (!compress.controller && compress.file && !$('compress-result').hidden) {
      resetCompressOutput();
      setState('compress', 'ready');
    }
  }

  // ---------------------------------------------------- compress: flow

  const compress = {
    file: null,
    url: null,
    bytes: null,
    controller: null,
    progress: progressView('compress'),
  };

  function resetCompressOutput() {
    $('compress-result').hidden = true;
    $('compress-error').hidden = true;
    if (compress.url) URL.revokeObjectURL(compress.url);
    compress.url = null;
    compress.bytes = null;
  }

  function setCompressFile(file) {
    if (compress.controller) return;
    resetCompressOutput();
    if (!looksLikePdf(file)) {
      showCompressError(`${file.name} is not a PDF file.`);
      return;
    }
    compress.file = file;
    $('compress-name').textContent = file.name;
    const large = file.size > 150 * 1024 * 1024 && touchOnly;
    $('compress-meta').textContent = formatBytes(file.size) + (large ? ' · large file, may be slow on this device' : '');
    $('compress-drop').hidden = true;
    compressInput.tabIndex = -1; // "Change" is the visible control now
    $('compress-file').hidden = false;
    $('compress-btn').disabled = false;
    setState('compress', 'ready');
  }

  function showCompressError(message) {
    const box = $('compress-error');
    box.textContent = message;
    box.hidden = false;
    setState('compress', 'error');
  }

  compressInput.addEventListener('change', () => {
    if (compressInput.files[0]) setCompressFile(compressInput.files[0]);
    compressInput.value = ''; // allow picking the same file again
  });
  $('compress-change').addEventListener('click', () => compressInput.click());

  async function runCompress() {
    if (!compress.file || compress.controller) return;
    resetCompressOutput();
    const file = compress.file;
    const controller = new AbortController();
    compress.controller = controller;
    const btn = $('compress-btn');
    btn.disabled = true;
    $('compress-change').disabled = true;
    compress.progress.show();
    setState('compress', 'working');
    const options = {
      level: currentLevel(),
      mode: opt.mode.value,
      dpi: Number(opt.dpi.value),
      quality: Number(opt.quality.value),
      grayscale: opt.gray.checked,
      stripMetadata: opt.meta.checked,
      signal: controller.signal,
      onProgress: (f, msg) => compress.progress.update(f, msg),
    };
    try {
      const input = await file.arrayBuffer();
      const result = await engine.compress(input, options);
      showCompressResult(file, result);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setState('compress', 'ready');
      } else {
        if (!err || err.name !== 'PDFMiniError') console.error(err);
        let message = errorMessage(err);
        if (err && err.code === 'encrypted' && options.mode === 'images') {
          message += ' If it opens without a password, try Advanced settings → “Convert pages to images”.';
        }
        showCompressError(message);
      }
    } finally {
      compress.controller = null;
      compress.progress.hide();
      btn.disabled = false;
      $('compress-change').disabled = false;
    }
  }

  function cleanupSummary(stats) {
    const parts = [];
    if (stats.inlined) parts.push(`${stats.inlined.toLocaleString()} small graphics merged into their pages`);
    if (stats.xfaRemoved) parts.push('duplicate Adobe XFA form data removed');
    if (stats.duplicates) parts.push(`${stats.duplicates.toLocaleString()} duplicate objects merged`);
    return parts.join(', ');
  }

  function showCompressResult(file, result) {
    const { stats } = result;
    const b = stats.breakdown;
    const box = $('compress-result');
    const download = $('compress-download');
    const share = $('compress-share');
    if (result.improved) {
      const saved = 1 - stats.outputSize / stats.inputSize;
      $('compress-headline').textContent = `${Math.max(1, Math.round(saved * 100))}% smaller`;
      $('compress-sizes').textContent = `${formatBytes(stats.inputSize)} → ${formatBytes(stats.outputSize)}`;
      compress.bytes = result.bytes;
      compress.url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
      download.href = compress.url;
      download.download = outputName(file.name, 'compressed');
      download.hidden = false;
      share.hidden = !canShareFiles;
      box.classList.remove('neutral');
    } else {
      $('compress-headline').textContent = 'Already well optimized';
      if (b && b.images < stats.inputSize * 0.3) {
        // Stronger image settings can't help, and page images would be bigger than text.
        $('compress-sizes').textContent = 'This PDF is mostly text and drawings, which are already stored compactly.';
      } else {
        const tips = [];
        if (currentLevel() !== 'strong') tips.push('choose Strong');
        if (opt.mode.value === 'images') tips.push('try “Convert pages to images” in Advanced settings');
        $('compress-sizes').textContent = 'This PDF could not be made smaller with these settings' +
          (tips.length ? `. To go further, ${tips.join(', or ')}.` : '.');
      }
      download.hidden = true;
      share.hidden = true;
      box.classList.add('neutral');
    }
    const note = $('compress-note');
    note.hidden = !(result.improved && stats.signed);
    note.textContent = 'This PDF was digitally signed. The compressed copy keeps the content but not the signature.';
    const pct = (n) => `${Math.round((100 * n) / stats.inputSize)}%`;
    const rows = [
      ['Method', result.mode === 'rasterize' ? 'Pages converted to images' : 'Text kept, images compressed'],
      ['Pages', stats.pages],
      ['Original', b ? `images ${pct(b.images)}, fonts ${pct(b.fonts)}, text and drawings ${pct(b.drawings)}, other ${pct(b.other)}` : null],
      ['Images', stats.images ? `${stats.recompressed} of ${stats.images} re-encoded` : null],
      ['Cleanup', result.improved ? cleanupSummary(stats) : null],
      ['Settings', `${stats.settings.dpi} dpi, quality ${stats.settings.quality}${stats.settings.gray ? ', grayscale' : ''}`],
      ['Time', `${(stats.ms / 1000).toFixed(1)} s`],
    ];
    const dl = $('compress-dl');
    dl.textContent = '';
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    box.hidden = false;
    box.focus({ preventScroll: true });
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setState('compress', result.improved ? 'done' : 'unchanged');
  }

  $('compress-btn').addEventListener('click', runCompress);
  $('compress-cancel').addEventListener('click', () => compress.controller && compress.controller.abort());
  $('compress-share').addEventListener('click', () => {
    if (compress.bytes) shareFile(compress.bytes, outputName(compress.file.name, 'compressed'));
  });

  // ----------------------------------------------------- combine: list

  const combine = {
    items: [],
    nextId: 1,
    url: null,
    bytes: null,
    controller: null,
    progress: progressView('combine'),
    dragId: null,
  };
  const list = $('combine-list');

  function resetCombineOutput() {
    $('combine-result').hidden = true;
    $('combine-error').hidden = true;
    if (combine.url) URL.revokeObjectURL(combine.url);
    combine.url = null;
    combine.bytes = null;
  }

  function showCombineError(message) {
    const box = $('combine-error');
    box.textContent = message;
    box.hidden = false;
    setState('combine', 'error');
  }

  function addCombineFiles(files) {
    if (combine.controller) return;
    resetCombineOutput();
    const rejected = [];
    for (const file of files) {
      if (!looksLikePdf(file)) { rejected.push(file.name); continue; }
      const item = { id: combine.nextId++, file, pages: null, error: null };
      combine.items.push(item);
      file.arrayBuffer()
        .then((buf) => engine.pageCount(buf))
        .then((n) => { item.pages = n; }, (err) => { item.error = errorMessage(err); })
        .then(renderCombine);
    }
    if (rejected.length) showCombineError(`Skipped (not PDF): ${rejected.join(', ')}`);
    renderCombine();
  }

  function moveItem(id, toIndex) {
    const from = combine.items.findIndex((it) => it.id === id);
    if (from < 0) return;
    const [item] = combine.items.splice(from, 1);
    combine.items.splice(Math.max(0, Math.min(combine.items.length, toIndex)), 0, item);
    resetCombineOutput();
    renderCombine();
  }

  const ICONS = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  function iconButton(kind, label, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.innerHTML = ICONS[kind];
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderCombine() {
    const { items } = combine;
    list.textContent = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'file-item';
      li.dataset.id = String(item.id);
      if (!touchOnly && items.length > 1) li.draggable = true;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i + 1}.`;
      const text = document.createElement('div');
      text.className = 'file-text';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.file.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      if (item.error) { meta.textContent = item.error; meta.style.color = 'var(--danger)'; } else meta.textContent = `${item.pages == null ? 'Reading…' : plural(item.pages, 'page')} · ${formatBytes(item.file.size)}`;
      text.append(name, meta);
      li.append(num, text,
        iconButton('up', `Move ${item.file.name} up`, () => moveItem(item.id, i - 1), i === 0),
        iconButton('down', `Move ${item.file.name} down`, () => moveItem(item.id, i + 1), i === items.length - 1),
        iconButton('remove', `Remove ${item.file.name}`, () => {
          combine.items = combine.items.filter((it) => it !== item);
          resetCombineOutput();
          renderCombine();
        }));
      list.append(li);
    });
    const ready = items.filter((it) => it.pages != null && !it.error);
    const pending = items.some((it) => it.pages == null && !it.error);
    const hasErrors = items.some((it) => it.error);
    $('combine-row').hidden = items.length === 0;
    $('combine-drop').hidden = items.length > 0;
    combineInput.tabIndex = items.length > 0 ? -1 : 0;
    const summary = $('combine-summary');
    summary.hidden = items.length === 0;
    if (items.length) {
      const pages = ready.reduce((a, it) => a + it.pages, 0);
      const size = items.reduce((a, it) => a + it.file.size, 0);
      summary.textContent = `${plural(items.length, 'file')} · ${plural(pages, 'page')} · ${formatBytes(size)}` +
        (items.length === 1 ? ' — add at least one more' : '') + (hasErrors ? ' — remove files that cannot be read' : '');
    }
    $('combine-btn').disabled = !!combine.controller || pending || hasErrors || ready.length < 2;
    setState('combine', pending ? 'reading' : items.length ? 'ready' : 'empty');
  }

  // Desktop drag-to-reorder (touch devices use the arrow buttons).
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest && e.target.closest('.file-item');
    if (!li) return;
    combine.dragId = Number(li.dataset.id);
    li.classList.add('drag-source');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch (err) { /* IE-style DnD */ }
  });
  list.addEventListener('dragover', (e) => {
    if (combine.dragId == null) return;
    const li = e.target.closest && e.target.closest('.file-item');
    e.preventDefault();
    list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (!li) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (combine.dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest && e.target.closest('.file-item');
    const id = combine.dragId;
    combine.dragId = null;
    if (!li) { renderCombine(); return; }
    const targetIndex = combine.items.findIndex((it) => it.id === Number(li.dataset.id));
    const r = li.getBoundingClientRect();
    const after = e.clientY >= r.top + r.height / 2;
    const fromIndex = combine.items.findIndex((it) => it.id === id);
    let to = targetIndex + (after ? 1 : 0);
    if (fromIndex < to) to--;
    moveItem(id, to);
  });
  list.addEventListener('dragend', () => {
    combine.dragId = null;
    renderCombine();
  });

  combineInput.addEventListener('change', () => {
    addCombineFiles(Array.from(combineInput.files));
    combineInput.value = '';
  });
  $('combine-add').addEventListener('click', () => combineInput.click());

  async function runCombine() {
    const items = combine.items.filter((it) => !it.error);
    if (items.length < 2 || combine.controller) return;
    resetCombineOutput();
    const controller = new AbortController();
    combine.controller = controller;
    renderCombine();
    combine.progress.show();
    setState('combine', 'working');
    try {
      const files = [];
      for (const it of items) files.push({ name: it.file.name, bytes: await it.file.arrayBuffer() });
      const result = await engine.combine(files, { signal: controller.signal, onProgress: (f, m) => combine.progress.update(f, m) });
      combine.bytes = result.bytes;
      combine.url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
      const download = $('combine-download');
      download.href = combine.url;
      download.download = 'combined.pdf';
      $('combine-share').hidden = !canShareFiles;
      $('combine-headline').textContent = `Combined ${plural(items.length, 'file')}`;
      $('combine-sizes').textContent = `${plural(result.pages, 'page')} · ${formatBytes(result.bytes.length)}`;
      const box = $('combine-result');
      box.hidden = false;
      box.focus({ preventScroll: true });
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setState('combine', 'done');
    } catch (err) {
      if (err && err.name === 'AbortError') setState('combine', 'ready');
      else {
        if (!err || err.name !== 'PDFMiniError') console.error(err);
        showCombineError(errorMessage(err));
      }
    } finally {
      combine.controller = null;
      combine.progress.hide();
      renderCombine();
      if (combine.bytes) setState('combine', 'done');
    }
  }

  $('combine-btn').addEventListener('click', runCombine);
  $('combine-cancel').addEventListener('click', () => combine.controller && combine.controller.abort());
  $('combine-share').addEventListener('click', () => combine.bytes && shareFile(combine.bytes, 'combined.pdf'));
  $('combine-compress').addEventListener('click', () => {
    if (!combine.bytes) return;
    selectTab(tabs[0]);
    setCompressFile(new File([combine.bytes], 'combined.pdf', { type: 'application/pdf' }));
    $('compress-btn').focus();
  });

  // ------------------------------------------------- page-wide dropping

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const dropZone = () => {
    const panel = activePanel();
    const zone = $(`${panel}-drop`);
    return zone.hidden ? $(panel === 'compress' ? 'compress-file' : 'combine-list') : zone;
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropZone().classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone().classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser navigate to a dropped PDF
    dragDepth = 0;
    dropZone().classList.remove('dragging');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    if (activePanel() === 'compress') setCompressFile(files[0]);
    else addCombineFiles(files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (compress.controller || combine.controller) { e.preventDefault(); e.returnValue = ''; }
  });

  setState('compress', 'empty');
  setState('combine', 'empty');
  // A file picked before this script ran (slow network) is still in the input.
  if (compressInput.files && compressInput.files[0]) setCompressFile(compressInput.files[0]);
  if (combineInput.files && combineInput.files.length) addCombineFiles(Array.from(combineInput.files));
  setState('app', 'ready');
})();
