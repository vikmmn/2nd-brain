// 2nd Brain Notes: browse, read and edit an Obsidian vault kept in Google Drive.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG;
  var Drive = window.Drive;
  var FOLDER = Drive.FOLDER;
  var AUTOSAVE_MS = 1500;
  var AUTO_IMAGE_BYTES = 8 * 1024 * 1024;

  var S = {
    stack: [], folder: null, searching: false,
    note: null,            // { id, name, parents, md5 }
    baseText: '', dirty: false, saving: false, timer: null,
    conflict: false, readOnly: false, drawing: false,
    mode: 'read'
  };
  try { S.mode = localStorage.getItem('note-mode') || 'read'; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setState(t, bad) { $('state').textContent = t || ''; $('state').classList.toggle('bad', !!bad); }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' }) : '';
  }
  function fmtSize(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  function home() {
    var h = null;
    try { h = JSON.parse(localStorage.getItem('home-folder') || 'null'); } catch (e) {}
    if (h && h.id === '16FHBAxU1PocgsN_EDWK4AHCw3LFVqUn_') h = null; // the old "0. 2nd Brain" folder; the vault moved
    return h || { id: CFG.HOME_FOLDER_ID, name: CFG.HOME_FOLDER_NAME };
  }
  function show(view) {
    ['welcome', 'browser', 'noteView'].forEach(function (v) { $(v).classList.toggle('hidden', v !== view); });
    $('modeBtn').classList.toggle('hidden', view !== 'noteView' || S.readOnly || !S.note);
    $('newBtn').classList.toggle('hidden', view !== 'browser');
  }

  // ---------- Problems and how to fix them ----------
  var lastAction = null;
  function clearProblem() { $('problem').classList.add('hidden'); }
  function explain(err) {
    var code = err && err.code, html;
    if (code === 'auth') {
      html = '<b>You are signed out of Google.</b>Your Google sign-in lasts about an hour at a time. Any unsaved edits are still here.' +
        '<div class="row"><button type="button" class="primary" data-fix="signin">Sign in again</button></div>';
    } else if (code === 'signin') {
      html = '<b>Sign-in did not finish.</b>' + esc(err.message) + '<div class="row"><button type="button" class="primary" data-fix="signin">Try again</button></div>';
    } else if (code === 'offline') {
      html = '<b>No connection to Google Drive.</b>Check your internet, then try again.<div class="row"><button type="button" data-fix="retry">Try again</button></div>';
    } else if (code === 'busy') {
      html = '<b>Google Drive is busy right now.</b>Wait a few seconds, then try again.<div class="row"><button type="button" data-fix="retry">Try again</button></div>';
    } else if (code === 'notfound') {
      html = '<b>That file is no longer in Google Drive.</b>It may have been moved, renamed or deleted on another device.';
    } else if (code === 'forbidden') {
      html = '<b>Google Drive refused that.</b>' + esc(err.message);
    } else {
      html = '<b>Something went wrong.</b>' + esc((err && err.message) || String(err)) + '<div class="row"><button type="button" data-fix="retry">Try again</button></div>';
    }
    $('problem').innerHTML = html;
    $('problem').classList.remove('hidden');
  }
  $('problem').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-fix]');
    if (!b) return;
    if (b.dataset.fix === 'signin') {
      try { await Drive.signIn(); } catch (err) { explain(err); return; }
    }
    clearProblem();
    if (lastAction) lastAction();
  });

  // Renew the Google sign-in quietly while the person is tapping around, before it runs out.
  async function keepSignedIn() {
    if (Drive.demo || (Drive.signedIn() && Drive.minutesLeft() > 8)) return;
    try { await Drive.signIn(); } catch (e) {}
  }

  // ---------- File kinds ----------
  var EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', pdf: 'application/pdf',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac' };
  var KIND_LABEL = { note: 'Note', drawing: 'Draw', image: 'Img', pdf: 'PDF', video: 'Video', audio: 'Audio', other: 'File' };
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function kindOf(name, mime) {
    if (/\.excalidraw(\.md)?$/i.test(name)) return 'drawing';
    if (/\.md$/i.test(name)) return 'note';
    var m = EXT_MIME[extOf(name)] || mime || '';
    if (m.indexOf('image/') === 0) return 'image';
    if (m === 'application/pdf') return 'pdf';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return 'other';
  }
  function shownName(f) {
    var k = kindOf(f.name, f.mimeType);
    return k === 'note' ? f.name.replace(/\.md$/i, '') : k === 'drawing' ? f.name.replace(/\.excalidraw\.md$/i, '') : f.name;
  }

  // ---------- Folders ----------
  var FILES = {};
  function fileRow(f) {
    FILES[f.id] = f;
    var k = kindOf(f.name, f.mimeType);
    var extra = (k === 'note' || k === 'drawing') ? fmtDate(f.modifiedTime) : fmtSize(f.size);
    return '<li tabindex="0" data-file="' + esc(f.id) + '"><span class="kind">' + KIND_LABEL[k] +
      '</span><span class="name">' + esc(shownName(f)) + '</span><span class="date">' + extra + '</span></li>';
  }

  async function openFolder(folder, push) {
    lastAction = function () { openFolder(folder, false); };
    clearProblem();
    S.note = null;
    show('browser');
    $('title').textContent = folder.name;
    $('list').innerHTML = '<li class="loading">Loading…</li>';
    setState('Loading…');
    try {
      var all = await Drive.list(folder.id);
      if (push && S.folder) S.stack.push(S.folder);
      S.folder = folder; S.searching = false;
      var byName = function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); };
      var folders = all.filter(function (f) { return f.mimeType === FOLDER && f.name.charAt(0) !== '.'; }).sort(byName);
      var files = all.filter(function (f) {
        return f.mimeType !== FOLDER && f.name.charAt(0) !== '.' && f.mimeType.indexOf('application/vnd.google-apps') !== 0;
      }).sort(byName);
      $('crumbs').textContent = S.stack.map(function (x) { return x.name; }).concat(folder.name).join('  /  ');
      var rows = folders.map(function (f) {
        return '<li tabindex="0" class="folder" data-folder="' + esc(f.id) + '" data-name="' + esc(f.name) +
          '"><span class="kind">Dir</span><span class="name">' + esc(f.name) + '</span></li>';
      }).concat(files.map(fileRow));
      var isHome = folder.id === home().id;
      $('list').innerHTML = (rows.length ? rows.join('') : '<li class="empty">This folder is empty.</li>') +
        (isHome ? '' : '<li class="empty"><button type="button" id="makeHome">Open the app in this folder from now on</button></li>');
      $('backBtn').classList.toggle('hidden', !S.stack.length);
      setState('');
    } catch (e) { $('list').innerHTML = ''; setState(''); explain(e); }
  }

  async function search(text) {
    lastAction = function () { search(text); };
    clearProblem();
    setState('Searching…');
    try {
      var found = (await Drive.searchNames(text)).filter(function (f) { return f.mimeType.indexOf('application/vnd.google-apps') !== 0; });
      S.searching = true;
      show('browser');
      $('title').textContent = 'Search';
      $('crumbs').textContent = 'File names containing “' + text + '”';
      $('list').innerHTML = found.length ? found.map(fileRow).join('') : '<li class="empty">Nothing found.</li>';
      $('backBtn').classList.remove('hidden');
      setState('');
    } catch (e) { setState(''); explain(e); }
  }

  // ---------- Notes ----------
  async function openNote(id) {
    await flush();
    if (S.note && (S.dirty || S.conflict)) return;
    lastAction = function () { openNote(id); };
    clearProblem();
    setState('Opening…');
    try {
      var both = await Promise.all([Drive.get(id), Drive.readBytes(id)]);
      var meta = both[0];
      var text = new TextDecoder('utf-8').decode(both[1]);
      S.note = { id: id, name: meta.name, parents: meta.parents, md5: meta.md5Checksum };
      S.baseText = text; S.dirty = false; S.conflict = false;
      S.drawing = /\.excalidraw\.md$/i.test(meta.name) || /^---[\s\S]{0,200}?excalidraw-plugin:/.test(text);
      S.readOnly = S.drawing;
      $('editor').value = text;
      $('conflict').classList.add('hidden');
      $('title').textContent = shownName(meta);
      show('noteView');
      $('backBtn').classList.remove('hidden');
      setMode(S.drawing ? 'read' : S.mode, true);
      window.scrollTo(0, 0);
      setState(S.drawing ? 'Drawing' : 'Saved');
    } catch (e) { setState(''); explain(e); }
  }

  $('editor').addEventListener('input', function () {
    S.dirty = $('editor').value !== S.baseText;
    setState(S.dirty ? 'Editing…' : 'Saved');
    clearTimeout(S.timer);
    if (S.dirty) S.timer = setTimeout(function () { save(false); }, AUTOSAVE_MS);
  });

  async function save(force) {
    if (!S.note || S.readOnly || S.saving) return;
    if (!S.dirty && !force) return;
    if (S.conflict && !force) return;
    clearTimeout(S.timer);
    S.saving = true;
    setState('Saving…');
    var text = $('editor').value;
    try {
      var r = await Drive.saveText(S.note.id, text, force ? null : S.note.md5);
      if (r.conflict) {
        S.conflict = true;
        $('conflict').classList.remove('hidden');
        setState('Not saved', true);
        return;
      }
      S.note.md5 = r.file.md5Checksum;
      S.baseText = text;
      S.dirty = $('editor').value !== S.baseText;
      S.conflict = false;
      $('conflict').classList.add('hidden');
      setState(S.dirty ? 'Editing…' : 'Saved');
      if (S.dirty) S.timer = setTimeout(function () { save(false); }, AUTOSAVE_MS);
    } catch (e) {
      setState('Not saved', true);
      lastAction = function () { save(false); };
      explain(e);
    } finally {
      S.saving = false;
    }
  }

  async function flush() {
    clearTimeout(S.timer);
    while (S.saving) await new Promise(function (r) { setTimeout(r, 120); });
    if (S.note && S.dirty && !S.conflict && !S.readOnly) await save(false);
  }

  $('loadTheirs').onclick = function () { S.dirty = false; S.conflict = false; openNote(S.note.id); };
  $('keepMine').onclick = function () { S.conflict = false; $('conflict').classList.add('hidden'); save(true); };
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', function () { flush(); });

  // ---------- Read / Edit ----------
  function render(md) {
    var fm = '';
    md = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, function (m) { fm = m; return ''; });
    md = md.replace(/!\[\[([^\]]+)\]\]/g, function (_, t) {
      return '<span class="slot" data-target="' + esc(t) + '"><span class="muted">Loading ' + esc(t.split('|')[0]) + '…</span></span>';
    });
    md = md.replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g, function (all, alt, p1, p2) {
      var src = p1 || p2;
      if (/^https?:\/\//i.test(src)) return '<img alt="' + esc(alt) + '" src="' + esc(src) + '">';
      var name;
      try { name = decodeURIComponent(src); } catch (e) { name = src; }
      return '<span class="slot" data-target="' + esc(name.split('/').pop()) + '"><span class="muted">Loading…</span></span>';
    });
    md = md.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|([^\]]+))?\]\]/g, function (_, t, h, a, alias) {
      return '<a class="wiki" href="#" data-wiki="' + esc(t.trim()) + '">' + esc(alias || t) + '</a>';
    });
    var html = window.marked ? window.marked.parse(md) : '<pre>' + esc(md) + '</pre>';
    return (fm ? '<div class="frontmatter">' + esc(fm.replace(/^---\r?\n|\r?\n---\r?\n?$/g, '')) + '</div>' : '') + html;
  }

  function setMode(m, silent) {
    if (!silent) { S.mode = m; try { localStorage.setItem('note-mode', m); } catch (e) {} }
    var reading = m === 'read' || S.readOnly;
    if (reading) {
      if (S.drawing) {
        $('reader').innerHTML = '<div class="slot"></div>';
        renderDrawing($('reader').firstChild, $('editor').value);
      } else {
        $('reader').innerHTML = render($('editor').value);
        hydrate($('reader'), 0);
      }
    }
    $('reader').classList.toggle('hidden', !reading);
    $('editor').classList.toggle('hidden', reading);
    $('modeBtn').textContent = reading ? 'Edit' : 'Read';
    $('modeBtn').classList.toggle('hidden', S.readOnly);
    if (!reading && !silent) $('editor').focus();
  }
  $('modeBtn').onclick = function () { setMode($('editor').classList.contains('hidden') ? 'edit' : 'read'); };

  $('reader').addEventListener('click', async function (e) {
    var a = e.target.closest('a.wiki');
    if (!a) return;
    e.preventDefault();
    await keepSignedIn();
    var name = a.dataset.wiki.split('/').pop();
    setState('Finding…');
    try {
      var f = await Drive.findExact(name + '.md') || await Drive.findExact(name);
      if (!f) { setState('“' + name + '” not found', true); return; }
      var k = kindOf(f.name, f.mimeType);
      if (k === 'note' || k === 'drawing') openNote(f.id); else openFile(f);
    } catch (err) { setState(''); explain(err); }
  });

  // ---------- Attachments ----------
  var scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) scriptCache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('Could not load a helper (' + src.split('/')[2] + ').')); };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  var embedCache = {};
  async function resolveEmbed(target) {
    var name = target.split('|')[0].split('#')[0].trim().split('/').pop();
    if (!name) return null;
    if (embedCache[name] !== undefined) return embedCache[name];
    var ext = extOf(name);
    var tries = ext === 'excalidraw' ? [name + '.md', name] : (EXT_MIME[ext] || ext === 'md') ? [name] : [name + '.md', name];
    var hit = null;
    for (var i = 0; i < tries.length && !hit; i++) hit = await Drive.findExact(tries[i]);
    embedCache[name] = hit;
    return hit;
  }

  function driveLink(f) {
    return f.webViewLink ? '<a href="' + esc(f.webViewLink) + '" target="_blank" rel="noopener">Open in Google Drive</a>' : '';
  }
  function fileCard(f, kind, buttonLabel) {
    return '<div class="card"><span class="kind">' + KIND_LABEL[kind] + '</span><span class="fname">' + esc(f.name) +
      '</span><span class="size">' + fmtSize(f.size) + '</span>' +
      (buttonLabel ? '<button type="button" class="load">' + buttonLabel + '</button>' : '') + driveLink(f) + '</div>';
  }

  async function showMedia(slot, f, kind) {
    slot.innerHTML = '<span class="muted">Loading ' + esc(f.name) + '…</span>';
    try {
      var mime = EXT_MIME[extOf(f.name)] || f.mimeType || 'application/octet-stream';
      if (kind === 'video' || kind === 'audio') {
        var stream = Drive.streamUrl(f.id);
        if (stream) {
          slot.innerHTML = kind === 'video'
            ? '<video controls playsinline preload="metadata" src="' + esc(stream) + '"></video>'
            : '<audio controls src="' + esc(stream) + '"></audio>';
          var el = slot.firstChild;
          el.onerror = function () { downloadAndPlay(slot, f, kind, mime); };
          return;
        }
        return downloadAndPlay(slot, f, kind, mime);
      }
      var bytes = await Drive.readBytes(f.id);
      if (kind === 'pdf') return await renderPdf(slot, bytes, f);
      var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      slot.innerHTML = '<img alt="' + esc(f.name) + '" src="' + url + '">';
    } catch (e) {
      slot.innerHTML = fileCard(f, kind, 'Try again') + '<p class="muted">Could not show it here' +
        (e && e.code === 'auth' ? ' because you are signed out.' : '.') + ' Open in Google Drive always works.</p>';
      slot.querySelector('.load').onclick = async function () { await keepSignedIn(); showMedia(slot, f, kind); };
      if (e && e.code === 'auth') explain(e);
    }
  }
  async function downloadAndPlay(slot, f, kind, mime) {
    slot.innerHTML = '<span class="muted">Downloading ' + esc(f.name) + ' (' + fmtSize(f.size) + ')…</span>';
    try {
      var url = URL.createObjectURL(new Blob([await Drive.readBytes(f.id)], { type: mime }));
      slot.innerHTML = kind === 'video' ? '<video controls playsinline src="' + url + '"></video>' : '<audio controls src="' + url + '"></audio>';
    } catch (e) {
      slot.innerHTML = fileCard(f, kind, '') + '<p class="muted">Could not play it here. Use Open in Google Drive.</p>';
    }
  }

  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  async function renderPdf(slot, bytes, f) {
    await loadScript(PDFJS + 'pdf.min.js');
    var lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    var doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    slot.innerHTML = '<div class="muted">' + esc(f.name) + ' · ' + doc.numPages + ' page' + (doc.numPages === 1 ? '' : 's') +
      ' · ' + driveLink(f) + '</div><div class="pdfpages"></div><div class="more"></div>';
    var pages = slot.querySelector('.pdfpages');
    var next = 1;
    async function drawSome(count) {
      var end = Math.min(doc.numPages, next + count - 1);
      for (; next <= end; next++) {
        var page = await doc.getPage(next);
        var base = page.getViewport({ scale: 1 });
        var scale = Math.min(3, (pages.clientWidth || 600) * (window.devicePixelRatio || 1) / base.width);
        var vp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        pages.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      var more = slot.querySelector('.more');
      more.innerHTML = next <= doc.numPages ? '<button type="button">Show more pages</button>' : '';
      if (more.firstChild) more.firstChild.onclick = function () { drawSome(10); };
    }
    await drawSome(5);
  }

  // Excalidraw drawings (Obsidian Excalidraw plugin)
  async function parseDrawing(text) {
    var m = /```compressed-json\s*\n([\s\S]*?)```/.exec(text), json;
    if (m) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js');
      json = window.LZString.decompressFromBase64(m[1].replace(/\s/g, ''));
    } else {
      m = /```json\s*\n([\s\S]*?)```/.exec(text);
      if (!m) return null;
      json = m[1];
    }
    var scene = JSON.parse(json);
    scene.elements = (scene.elements || []).filter(function (e) { return !e.isDeleted; });
    return scene;
  }
  async function renderDrawing(slot, text) {
    slot.innerHTML = '<span class="muted">Drawing the sketch…</span>';
    try {
      var scene = await parseDrawing(text);
      if (!scene) { slot.innerHTML = '<p class="muted">This drawing has no saved picture data yet.</p>'; return; }
      if (!scene.elements.length) { slot.innerHTML = '<p class="muted">This drawing is empty.</p>'; return; }
      var svg = null;
      try {
        window.EXCALIDRAW_ASSET_PATH = 'https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/';
        await loadScript('https://unpkg.com/react@18.3.1/umd/react.production.min.js');
        await loadScript('https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js');
        await loadScript('https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js');
        svg = await window.ExcalidrawLib.exportToSvg({
          elements: scene.elements,
          appState: Object.assign({}, scene.appState || {}, { exportBackground: true, exportWithDarkMode: false }),
          files: scene.files || {}
        });
      } catch (e) { svg = null; }
      slot.innerHTML = '<div class="drawing"></div>';
      var box = slot.querySelector('.drawing');
      if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); box.appendChild(svg); }
      else box.innerHTML = simpleSvg(scene.elements);
    } catch (e) {
      slot.innerHTML = '<p class="muted">Could not draw this sketch (' + esc(e.message || e) + ').</p>';
    }
  }
  // Plain fallback: shapes, lines, arrows, pen strokes and text, without the hand-drawn look.
  function simpleSvg(els) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function grow(x, y) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    els.forEach(function (e) {
      if (e.points && e.points.length) e.points.forEach(function (p) { grow(e.x + p[0], e.y + p[1]); });
      else { grow(e.x, e.y); grow(e.x + (e.width || 0), e.y + (e.height || 0)); }
    });
    var pad = 16, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
    var out = els.map(function (e) {
      var x = e.x - minX + pad, y = e.y - minY + pad, ew = e.width || 0, eh = e.height || 0;
      var stroke = e.strokeColor || '#1e1e1e';
      var fill = e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : 'none';
      var dash = e.strokeStyle === 'dashed' ? ' stroke-dasharray="8 6"' : e.strokeStyle === 'dotted' ? ' stroke-dasharray="2 5"' : '';
      var base = ' stroke="' + esc(stroke) + '" stroke-width="' + (e.strokeWidth || 1) + '" opacity="' +
        ((e.opacity == null ? 100 : e.opacity) / 100) + '"' + dash;
      var rot = e.angle ? ' transform="rotate(' + (e.angle * 180 / Math.PI) + ' ' + (x + ew / 2) + ' ' + (y + eh / 2) + ')"' : '';
      if (e.type === 'rectangle' || e.type === 'frame' || e.type === 'image') {
        var r = e.roundness ? Math.min(ew, eh) * 0.12 : 0;
        return '<rect x="' + x + '" y="' + y + '" width="' + ew + '" height="' + eh + '" rx="' + r + '" fill="' + esc(fill) + '"' + base +
          (e.type === 'image' ? ' stroke-dasharray="4 4"' : '') + rot + '/>';
      }
      if (e.type === 'ellipse') return '<ellipse cx="' + (x + ew / 2) + '" cy="' + (y + eh / 2) + '" rx="' + ew / 2 + '" ry="' + eh / 2 + '" fill="' + esc(fill) + '"' + base + rot + '/>';
      if (e.type === 'diamond') return '<polygon points="' + [[x + ew / 2, y], [x + ew, y + eh / 2], [x + ew / 2, y + eh], [x, y + eh / 2]].join(' ') + '" fill="' + esc(fill) + '"' + base + rot + '/>';
      if (e.points && (e.type === 'line' || e.type === 'arrow' || e.type === 'freedraw')) {
        var pts = e.points.map(function (p) { return (x + p[0]) + ',' + (y + p[1]); }).join(' ');
        var line = '<polyline points="' + pts + '" fill="none"' + base + ' stroke-linecap="round" stroke-linejoin="round"' + rot + '/>';
        if (e.type === 'arrow' && e.points.length > 1 && e.endArrowhead !== null) {
          var a = e.points[e.points.length - 1], b = e.points[e.points.length - 2];
          var ang = Math.atan2(a[1] - b[1], a[0] - b[0]), len = 14, ax = x + a[0], ay = y + a[1];
          line += '<polyline points="' + (ax - len * Math.cos(ang - 0.45)) + ',' + (ay - len * Math.sin(ang - 0.45)) + ' ' + ax + ',' + ay +
            ' ' + (ax - len * Math.cos(ang + 0.45)) + ',' + (ay - len * Math.sin(ang + 0.45)) + '" fill="none" stroke="' + esc(stroke) +
            '" stroke-width="' + (e.strokeWidth || 1) + '" stroke-linecap="round"/>';
        }
        return line;
      }
      if (e.type === 'text') {
        var fs = e.fontSize || 20, lh = fs * (e.lineHeight || 1.25);
        var anchor = e.textAlign === 'center' ? 'middle' : e.textAlign === 'right' ? 'end' : 'start';
        var tx = anchor === 'middle' ? x + ew / 2 : anchor === 'end' ? x + ew : x;
        return '<text x="' + tx + '" y="' + (y + fs) + '" font-size="' + fs + '" font-family="Segoe Print, Comic Sans MS, sans-serif" fill="' +
          esc(stroke) + '" text-anchor="' + anchor + '"' + rot + '>' +
          String(e.text || '').split('\n').map(function (t, i) { return '<tspan x="' + tx + '" dy="' + (i ? lh : 0) + '">' + esc(t) + '</tspan>'; }).join('') + '</text>';
      }
      return '';
    }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' + out + '</svg>';
  }

  function hydrate(root, depth) {
    var slots = root.querySelectorAll('.slot[data-target]:not([data-done])');
    Array.prototype.forEach.call(slots, function (slot) {
      slot.setAttribute('data-done', '1');
      fillSlot(slot, slot.getAttribute('data-target'), depth);
    });
  }
  async function fillSlot(slot, target, depth) {
    try {
      var f = await resolveEmbed(target);
      if (!f) { slot.innerHTML = '<span class="embed">not found: ' + esc(target.split('|')[0]) + '</span>'; return; }
      var kind = kindOf(f.name, f.mimeType);
      if (kind === 'image' && Number(f.size || 0) <= AUTO_IMAGE_BYTES) return showMedia(slot, f, kind);
      if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
        slot.innerHTML = fileCard(f, kind, { image: 'Show image', pdf: 'Show PDF', video: 'Play video', audio: 'Play audio' }[kind]);
        slot.querySelector('.load').onclick = async function () { await keepSignedIn(); showMedia(slot, f, kind); };
        return;
      }
      if (kind === 'drawing' || kind === 'note') {
        if (depth >= 2) { slot.innerHTML = fileCard(f, kind, ''); return; }
        var text = new TextDecoder('utf-8').decode(await Drive.readBytes(f.id));
        if (kind === 'drawing') return renderDrawing(slot, text);
        var section = target.indexOf('#') > -1 ? target.split('#')[1].split('|')[0].trim() : '';
        if (section) text = sectionOf(text, section);
        slot.innerHTML = '<div class="transclude"><div class="from">from ' + esc(shownName(f)) +
          (section ? ' › ' + esc(section) : '') + '</div>' + render(text) + '</div>';
        hydrate(slot, depth + 1);
        return;
      }
      slot.innerHTML = fileCard(f, kind, '');
    } catch (e) {
      slot.innerHTML = '<span class="embed">could not load: ' + esc(target.split('|')[0]) + '</span>';
    }
  }
  function sectionOf(text, heading) {
    var lines = text.split('\n'), out = [], level = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (level) { if (m && m[1].length <= level) break; out.push(lines[i]); }
      else if (m && m[2].trim().toLowerCase() === heading.toLowerCase()) { level = m[1].length; out.push(lines[i]); }
    }
    return out.length ? out.join('\n') : text;
  }

  function openFile(f) {
    S.note = null; S.drawing = false; S.readOnly = true;
    clearProblem();
    var kind = kindOf(f.name, f.mimeType);
    $('title').textContent = f.name;
    show('noteView');
    $('conflict').classList.add('hidden');
    $('editor').classList.add('hidden');
    $('reader').classList.remove('hidden');
    $('backBtn').classList.remove('hidden');
    $('reader').innerHTML = '<div class="slot"></div>';
    setState('');
    window.scrollTo(0, 0);
    var slot = $('reader').firstChild;
    if (kind === 'other') slot.innerHTML = fileCard(f, kind, '') + '<p class="muted">This kind of file can\'t be shown here.</p>';
    else showMedia(slot, f, kind);
  }

  // ---------- Navigation ----------
  $('backBtn').onclick = async function () {
    if (!$('noteView').classList.contains('hidden')) {
      await flush();
      if (S.conflict) { setState('Choose an option in the yellow box', true); return; }
      if (S.dirty) { setState('Not saved yet', true); return; }
      return openFolder(S.folder || home(), false);
    }
    if (S.searching) return openFolder(S.folder || home(), false);
    if (S.stack.length) return openFolder(S.stack.pop(), false);
  };
  $('list').addEventListener('click', async function (e) {
    if (e.target.id === 'makeHome') {
      try { localStorage.setItem('home-folder', JSON.stringify(S.folder)); } catch (err) {}
      S.stack = [];
      return openFolder(S.folder, false);
    }
    var li = e.target.closest('li');
    if (!li || (!li.dataset.folder && !li.dataset.file)) return;
    await keepSignedIn();
    if (li.dataset.folder) return openFolder({ id: li.dataset.folder, name: li.dataset.name }, true);
    var f = FILES[li.dataset.file], k = kindOf(f.name, f.mimeType);
    if (k === 'note' || k === 'drawing') openNote(f.id); else openFile(f);
  });
  $('list').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches('li')) e.target.click(); });
  $('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('q').value.trim();
    if (t) search(t);
  });
  $('newBtn').onclick = function () {
    $('newForm').classList.toggle('hidden');
    if (!$('newForm').classList.contains('hidden')) $('newName').focus();
  };
  $('newForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('newName').value.trim().replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-');
    if (!name || !S.folder) return;
    clearProblem();
    setState('Creating…');
    try {
      if (await Drive.findExact(name + '.md', S.folder.id)) { setState('A note with that name is already here', true); return; }
      var f = await Drive.create(name + '.md', S.folder.id, '');
      $('newName').value = '';
      $('newForm').classList.add('hidden');
      S.mode = 'edit';
      await openNote(f.id);
      setMode('edit');
    } catch (err) { setState(''); explain(err); }
  });

  // ---------- Updates: only applied when you tap "Update now" ----------
  var registration = null;
  function offerUpdate() { setState(''); $('updateBar').classList.remove('hidden'); }
  if ('serviceWorker' in navigator && !/(^|[#&])nosw\b/.test(location.hash)) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        });
      });
    }).catch(function () {});
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  $('applyUpdateBtn').onclick = async function () {
    await flush();
    if (S.dirty || S.conflict) { setState('Save your note first', true); return; }
    $('applyUpdateBtn').textContent = 'Updating…';
    if (registration && registration.waiting) registration.waiting.postMessage('skipWaiting');
    else location.reload();
  };
  $('checkUpdateBtn').onclick = async function () {
    if (!registration) { setState('Updates work once the app is installed from its web address'); return; }
    setState('Checking for update…');
    try { await registration.update(); } catch (e) {}
    setTimeout(function () {
      if (registration.waiting || registration.installing) offerUpdate();
      else setState('You have the latest version');
    }, 1500);
  };
  $('versionLabel').textContent = '2nd Brain Notes ' + CFG.VERSION + (Drive.demo ? ' · demo vault' : '');

  // ---------- Start ----------
  $('signInBtn').onclick = async function () {
    $('signInBtn').disabled = true;
    try { await Drive.signIn(); clearProblem(); openFolder(home(), false); }
    catch (e) { explain(e); }
    $('signInBtn').disabled = false;
  };
  if (Drive.demo) {
    $('welcomeText').textContent = CFG.CLIENT_ID
      ? 'Demo mode: a pretend vault, so you can try everything without touching your real notes.'
      : 'The Google sign-in key has not been added yet, so this opens a pretend vault you can try out.';
    $('signInBtn').textContent = 'Open the demo vault';
  }
  $('title').textContent = '2nd Brain Notes';
  if (!Drive.demo && Drive.signedIn()) {
    // Still signed in from earlier (the sign-in lasts about an hour): go straight to the notes.
    openFolder(home(), false);
  } else {
    if (!Drive.demo && Drive.signedInBefore()) {
      $('welcomeText').textContent = 'Welcome back. Tap Continue to renew your Google sign-in; it only takes a moment.';
      $('signInBtn').textContent = 'Continue';
    }
    show('welcome');
  }
})();
