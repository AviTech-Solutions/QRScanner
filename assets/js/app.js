// Update year
document.getElementById("year").textContent = new Date().getFullYear();

(() => {
  'use strict';

  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const formats = Object.entries(window.Html5QrcodeSupportedFormats || {})
    .filter(([name, value]) => /^[A-Z0-9_]+$/.test(name) && typeof value === 'number')
    .map(([name, value]) => [value, name.replaceAll('_', ' ')]);
  const formatName = value => {
    if (value && typeof value === 'object') {
      if (typeof value.formatName === 'string') return value.formatName.replaceAll('_', ' ');
      value = value.format;
    }
    return formats.find(([id]) => id === value)?.[1] || 'Barcode';
  };
  const $ = id => document.getElementById(id);
  const queue = [];
  const results = [];
  let scanner = null;
  let scanning = false;
  let batchRunning = false;
  let cancelRequested = false;
  let torchOn = false;
  const seenLiveCodes = new Set();
  let cameras = [];

  function setStatus(element, message, kind = '') {
    element.textContent = message;
    element.className = `status-message${kind ? ` ${kind}` : ''}`;
  }

  function classifyContent(value) {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) {
      try { const url = new URL(text); return ['Link', ['http:', 'https:'].includes(url.protocol) ? url.href : null]; }
      catch { return ['Text', null]; }
    }
    if (/^mailto:/i.test(text)) return ['Email', text];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return ['Email', `mailto:${text}`];
    if (/^tel:/i.test(text)) return ['Phone', text];
    if (/^\+?[\d(). -]{7,}$/.test(text)) return ['Phone', `tel:${text.replace(/[^\d+]/g, '')}`];
    if (/^WIFI:/i.test(text)) return ['Wi-Fi configuration', null];
    if (/^(BEGIN:VCARD|MECARD:)/i.test(text)) return ['Contact', null];
    if (/^geo:/i.test(text) || /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/.test(text)) return ['Location', null];
    if (/^sms:/i.test(text)) return ['SMS', text];
    return ['Text', null];
  }

  function addResult(value, format, filename = '') {
    const key = `${format}\u0000${value}`;
    if (!filename && seenLiveCodes.has(key)) return;
    if (!filename) seenLiveCodes.add(key);
    const [type, actionUrl] = classifyContent(value);
    const result = { value, format, type, timestamp: new Date().toISOString(), filename, actionUrl };
    results.unshift(result);
    renderResults();
    if (filename) setStatus($('uploadStatus'), `Decoded a ${format} code from ${filename}.`, 'success');
  }

  function renderResults() {
    const list = $('resultsList');
    list.replaceChildren();
    $('emptyResults').hidden = results.length > 0;
    $('resultCount').textContent = String(results.length);
    $('exportTxtButton').disabled = $('exportCsvButton').disabled = $('clearResultsButton').disabled = results.length === 0;
    results.forEach((result, index) => {
      const article = document.createElement('article'); article.className = 'result-item';
      const top = document.createElement('div'); top.className = 'result-meta';
      const badge = document.createElement('span'); badge.className = 'format-badge'; badge.textContent = result.format;
      const type = document.createElement('span'); type.textContent = result.type;
      const time = document.createElement('time'); time.dateTime = result.timestamp; time.textContent = new Date(result.timestamp).toLocaleString();
      top.append(badge, type, time); article.append(top);
      if (result.filename) { const source = document.createElement('div'); source.className = 'result-source'; source.textContent = result.filename; article.append(source); }
      const content = document.createElement('pre'); content.className = 'result-content'; content.textContent = result.value; article.append(content);
      const actions = document.createElement('div'); actions.className = 'result-actions';
      const action = (label, handler, cls = 'text-button') => { const button = document.createElement('button'); button.type = 'button'; button.className = cls; button.textContent = label; button.addEventListener('click', handler); actions.append(button); return button; };
      action('Copy', () => copyText(result.value));
      action('Download', () => download(`${result.format} · ${result.type}\n${result.timestamp}\n${result.filename ? `File: ${result.filename}\n` : ''}\n${result.value}`, `scan-result-${index + 1}.txt`, 'text/plain;charset=utf-8'));
      if (result.actionUrl) { const link = document.createElement('a'); link.className = 'button button-small button-primary'; link.textContent = result.type === 'Email' ? 'Email' : result.type === 'Phone' ? 'Call' : 'Open link'; link.href = result.actionUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); }
      action('Clear', () => { results.splice(index, 1); renderResults(); }, 'text-button text-danger');
      article.append(actions); list.append(article);
    });
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(text);
      else { const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select(); const ok = document.execCommand('copy'); field.remove(); if (!ok) throw new Error('Copy failed'); }
      setStatus($('cameraStatus'), 'Result copied to clipboard.', 'success'); setStatus($('uploadStatus'), 'Result copied to clipboard.', 'success');
    } catch { setStatus($('cameraStatus'), 'Could not copy automatically. Select and copy the result text.', 'error'); }
  }

  function download(text, filename, type) {
    try { const url = URL.createObjectURL(new Blob([text], { type })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch { setStatus($('uploadStatus'), 'The download could not be created. Try again.', 'error'); }
  }

  function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
  function exportResults(kind) {
    if (!results.length) return;
    if (kind === 'txt') download(results.map(r => [`File: ${r.filename || 'Camera'}`, `Timestamp: ${r.timestamp}`, `Format: ${r.format}`, `Content type: ${r.type}`, `Status: Completed`, '', r.value].join('\n')).join('\n\n---\n\n'), 'qr-scanner-results.txt', 'text/plain;charset=utf-8');
    else {
      const rows = [['Filename', 'Timestamp', 'Code format', 'Content type', 'Decoded content', 'Processing status'], ...results.map(r => [r.filename || 'Camera', r.timestamp, r.format, r.type, r.value, 'Completed'])];
      download(`\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'qr-scanner-results.csv', 'text/csv;charset=utf-8');
    }
  }

  function stopScanner() {
    if (!scanner || !scanning) return Promise.resolve();
    const active = scanner; scanning = false; $('cameraBadge').hidden = true; $('startButton').disabled = false; $('stopButton').disabled = true; $('torchButton').disabled = true; $('cameraPlaceholder').hidden = false;
    return active.stop().catch(() => {}).then(() => active.clear().catch(() => {})).then(() => { if (scanner === active) scanner = null; });
  }

  async function startScanner(cameraId = '') {
    if (!window.Html5Qrcode) { setStatus($('cameraStatus'), 'The scanning library did not load. Refresh the page or use image upload.', 'error'); return; }
    if (scanning) await stopScanner();
    try {
      cameras = await Html5Qrcode.getCameras();
      const select = $('cameraSelect'); select.replaceChildren();
      cameras.forEach((camera, index) => { const option = document.createElement('option'); option.value = camera.id; option.textContent = camera.label || `Camera ${index + 1}`; select.append(option); });
      select.disabled = cameras.length < 2;
      const selected = cameraId || cameras.find(c => /back|rear|environment/i.test(c.label))?.id || cameras[0]?.id;
      if (!selected) throw new Error('No camera was found.');
      select.value = selected;
      scanner = new Html5Qrcode('reader', { formatsToSupport: formats.map(([id]) => id) });
      await scanner.start(selected, { fps: 10, qrbox: (width, height) => ({ width: Math.floor(Math.min(width * .82, height * .72, 460)), height: Math.floor(Math.min(width * .82, height * .72, 460)) }), aspectRatio: 1, experimentalFeatures: { useBarCodeDetectorIfSupported: false } }, (decoded, details) => addResult(decoded, formatName(details?.result?.format)), () => {});
      scanning = true; torchOn = false; $('cameraBadge').hidden = false; $('cameraPlaceholder').hidden = true; $('startButton').disabled = true; $('stopButton').disabled = false; $('torchButton').disabled = false; $('torchButton').setAttribute('aria-pressed', 'false');
      setStatus($('cameraStatus'), 'Camera is active. Hold a code inside the frame.', 'success');
    } catch (error) {
      scanner = null;
      const message = /permission|denied|notallowed/i.test(error?.name + error?.message) ? 'Camera permission was denied. Allow camera access in your browser settings, or upload an image.' : /not found|no camera/i.test(error?.message) ? 'No camera was found. Connect a camera or upload an image.' : 'Could not start the camera. Check that it is available and that this page is using HTTPS or localhost.';
      setStatus($('cameraStatus'), message, 'error'); $('cameraPlaceholder').hidden = false;
    }
  }

  function queueFiles(fileList) {
    const files = [...fileList]; let added = 0;
    files.forEach(file => {
      if (!ALLOWED_TYPES.has(file.type) || !/\.(png|jpe?g|webp)$/i.test(file.name)) { setStatus($('uploadStatus'), `${file.name}: choose a PNG, JPG, or WebP image.`, 'error'); return; }
      if (file.size > MAX_FILE_BYTES) { setStatus($('uploadStatus'), `${file.name}: the file is larger than 15 MB.`, 'error'); return; }
      if (queue.some(item => item.file === file || (item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified))) return;
      queue.push({ file, status: 'Pending', preview: URL.createObjectURL(file), error: '' }); added++;
    });
    renderQueue(); if (added) setStatus($('uploadStatus'), `${added} image${added === 1 ? '' : 's'} added to the queue.`, 'success');
    $('fileInput').value = '';
  }

  function renderQueue() {
    const list = $('fileQueue'); list.replaceChildren(); $('queueCount').textContent = String(queue.length);
    $('scanAllButton').disabled = batchRunning || !queue.some(item => ['Pending', 'Failed', 'No code found'].includes(item.status));
    $('clearQueueButton').disabled = batchRunning || queue.length === 0;
    $('retryButton').disabled = batchRunning || !queue.some(item => ['Failed', 'No code found'].includes(item.status));
    queue.forEach((item, index) => {
      const row = document.createElement('article'); row.className = 'queue-item'; const image = document.createElement('img'); image.src = item.preview; image.alt = ''; image.width = 50; image.height = 50;
      const details = document.createElement('div'); details.className = 'queue-details'; const name = document.createElement('strong'); name.textContent = item.file.name; const size = document.createElement('span'); size.textContent = `${(item.file.size / 1024 / 1024).toFixed(2)} MB · ${item.status}${item.error ? ` · ${item.error}` : ''}`; details.append(name, size);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item.file.name}`); remove.disabled = batchRunning; remove.addEventListener('click', () => { URL.revokeObjectURL(item.preview); queue.splice(index, 1); renderQueue(); }); row.append(image, details, remove); list.append(row);
    });
  }

  async function scanImage(item) {
    item.status = 'Scanning'; item.error = ''; renderQueue();
    try {
      if (!window.Html5Qrcode) throw new Error('The scanning library is unavailable.');
      const decoder = new Html5Qrcode('image-reader', { formatsToSupport: formats.map(([id]) => id) });
      const result = typeof decoder.scanFileV2 === 'function'
        ? await decoder.scanFileV2(item.file, false)
        : { decodedText: await decoder.scanFile(item.file, false) };
      const format = result?.result?.format;
      addResult(result.decodedText, format === undefined ? 'Code format unavailable' : formatName(format), item.file.name); item.status = 'Completed';
    } catch (error) {
      const message = String(error?.message || error);
      if (/No MultiFormat Readers were able to detect the code|NotFoundException|No barcode or QR code/i.test(message)) { item.status = 'No code found'; item.error = ''; }
      else { item.status = 'Failed'; item.error = /image|file|decode|load/i.test(message) ? 'Could not read this image' : 'Could not decode'; }
    }
  }

  async function runBatch(retriesOnly = false) {
    if (batchRunning) return; batchRunning = true; cancelRequested = false; $('scanAllButton').disabled = $('cancelBatchButton').disabled = false; $('clearQueueButton').disabled = $('retryButton').disabled = true;
    const targets = queue.filter(item => retriesOnly ? ['Failed', 'No code found'].includes(item.status) : ['Pending', 'Failed', 'No code found'].includes(item.status));
    let finished = 0;
    for (const item of targets) {
      if (cancelRequested) { item.status = 'Cancelled'; finished++; renderQueue(); continue; }
      await scanImage(item); finished++; $('batchProgress').textContent = `${finished} of ${targets.length} files processed`; renderQueue();
    }
    batchRunning = false; $('cancelBatchButton').disabled = true; $('batchProgress').textContent = cancelRequested ? `Cancelled. ${finished} of ${targets.length} files processed.` : `Finished: ${targets.filter(i => i.status === 'Completed').length} decoded, ${targets.filter(i => i.status === 'No code found').length} with no code, ${targets.filter(i => i.status === 'Failed').length} failed.`;
    setStatus($('uploadStatus'), cancelRequested ? 'Batch cancelled. Files that had not started were skipped.' : 'Batch processing is complete.', cancelRequested ? '' : 'success'); renderQueue();
  }

  $('cameraTab').addEventListener('click', () => { $('cameraTab').classList.add('is-selected'); $('cameraTab').setAttribute('aria-selected', 'true'); $('uploadTab').classList.remove('is-selected'); $('uploadTab').setAttribute('aria-selected', 'false'); $('cameraPanel').hidden = false; $('uploadPanel').hidden = true; });
  $('uploadTab').addEventListener('click', async () => { await stopScanner(); $('uploadTab').classList.add('is-selected'); $('uploadTab').setAttribute('aria-selected', 'true'); $('cameraTab').classList.remove('is-selected'); $('cameraTab').setAttribute('aria-selected', 'false'); $('uploadPanel').hidden = false; $('cameraPanel').hidden = true; });
  $('startButton').addEventListener('click', () => startScanner());
  $('stopButton').addEventListener('click', () => stopScanner().then(() => setStatus($('cameraStatus'), 'Scanning stopped. Start again whenever you are ready.')));
  $('scanAgainButton').addEventListener('click', () => { seenLiveCodes.clear(); if (scanning) { setStatus($('cameraStatus'), 'Ready for the next code.', 'success'); } else startScanner($('cameraSelect').value); });
  $('cameraSelect').addEventListener('change', () => startScanner($('cameraSelect').value));
  $('torchButton').addEventListener('click', async () => { try { await scanner.applyVideoConstraints({ advanced: [{ torch: !torchOn }] }); torchOn = !torchOn; $('torchButton').setAttribute('aria-pressed', String(torchOn)); $('torchButton').textContent = torchOn ? 'Turn flashlight off' : 'Flashlight'; } catch { setStatus($('cameraStatus'), 'Flashlight control is not supported by this camera.', 'error'); $('torchButton').disabled = true; } });
  $('chooseFilesButton').addEventListener('click', event => { event.stopPropagation(); $('fileInput').click(); });
  $('dropZone').addEventListener('click', event => { if (event.target !== $('chooseFilesButton')) $('fileInput').click(); });
  $('dropZone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('fileInput').click(); } });
  $('fileInput').addEventListener('change', event => queueFiles(event.target.files));
  ['dragenter', 'dragover'].forEach(type => $('dropZone').addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); $('dropZone').classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach(type => $('dropZone').addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); $('dropZone').classList.remove('is-dragging'); }));
  $('dropZone').addEventListener('drop', event => queueFiles(event.dataTransfer.files));
  document.addEventListener('paste', event => { const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean); if (files.length) { $('uploadTab').click(); queueFiles(files.map((file, i) => new File([file], file.name || `pasted-image-${Date.now()}-${i + 1}.png`, { type: file.type || 'image/png' }))); } });
  $('scanAllButton').addEventListener('click', () => runBatch(false)); $('retryButton').addEventListener('click', () => runBatch(true));
  $('cancelBatchButton').addEventListener('click', () => { cancelRequested = true; $('cancelBatchButton').disabled = true; setStatus($('uploadStatus'), 'Cancelling after the current image finishes…'); });
  $('clearQueueButton').addEventListener('click', () => { if (batchRunning) return; queue.forEach(item => URL.revokeObjectURL(item.preview)); queue.length = 0; renderQueue(); $('batchProgress').textContent = 'Add images to get started.'; });
  $('clearResultsButton').addEventListener('click', () => { if (results.length && window.confirm('Clear all decoded results from this session?')) { results.length = 0; renderResults(); } });
  $('exportTxtButton').addEventListener('click', () => exportResults('txt')); $('exportCsvButton').addEventListener('click', () => exportResults('csv'));
  const cookieNotice = $('cookieNotice');
  try { cookieNotice.hidden = localStorage.getItem('qr-scanner-notice-dismissed') === 'yes'; }
  catch { cookieNotice.hidden = false; }
  $('dismissCookieNotice').addEventListener('click', () => {
    cookieNotice.hidden = true;
    try { localStorage.setItem('qr-scanner-notice-dismissed', 'yes'); } catch { /* Dismiss for this page view if storage is unavailable. */ }
  });
  document.addEventListener('visibilitychange', () => { if (!scanner || !scanning) return; try { if (document.hidden) scanner.pause(true); else scanner.resume(); } catch { /* Camera stream may have been ended by the browser. */ } });
  window.addEventListener('pagehide', () => { if (scanner && scanning) scanner.stop().catch(() => {}); queue.forEach(item => URL.revokeObjectURL(item.preview)); });
  if (!window.Html5Qrcode) { setStatus($('cameraStatus'), 'Scanning library failed to load. Image and camera scanning are unavailable until it loads.', 'error'); setStatus($('uploadStatus'), 'Scanning library failed to load. Refresh the page or check the local scanner library file.', 'error'); }
  renderQueue(); renderResults();
})();
