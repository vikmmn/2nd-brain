// Google Drive access for 2nd Brain Notes.
// Real mode talks to the Drive API with the user's own Google sign-in.
// Demo mode (no CLIENT_ID, or #demo in the address) uses a small pretend vault so the app can be tried and tested.
(function () {
  var CFG = window.APP_CONFIG;
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,md5Checksum,trashed';
  var FOLDER = 'application/vnd.google-apps.folder';
  var SCOPE = 'https://www.googleapis.com/auth/drive';

  function fail(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function qs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  // ---------------- Real Google Drive ----------------
  function RealDrive() {
    var token = null, expiresAt = 0, client = null;

    function loadGis() {
      if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = function () { reject(fail('offline', 'Could not reach Google sign-in. Check your internet connection.')); };
        document.head.appendChild(s);
      });
    }

    // Must be called from a tap or click: Google opens a small sign-in window.
    async function signIn() {
      await loadGis();
      if (!client) {
        client = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPE, callback: function () {} });
      }
      return new Promise(function (resolve, reject) {
        client.callback = function (r) {
          if (r.error) return reject(fail('signin', r.error_description || r.error));
          token = r.access_token;
          expiresAt = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          try { localStorage.setItem('signed-in-before', '1'); } catch (e) {}
          resolve();
        };
        client.error_callback = function (e) {
          reject(fail('signin', e && e.type === 'popup_closed' ? 'The Google sign-in window was closed.' :
            e && e.type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this app.' :
            'Google sign-in did not finish.'));
        };
        var before = false;
        try { before = localStorage.getItem('signed-in-before') === '1'; } catch (e) {}
        client.requestAccessToken({ prompt: before ? '' : 'consent' });
      });
    }

    function signedIn() { return !!token && Date.now() < expiresAt; }
    function minutesLeft() { return token ? (expiresAt - Date.now()) / 60000 : 0; }

    async function api(url, opts) {
      if (!signedIn()) throw fail('auth', 'Please sign in to Google again.');
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      var r;
      try { r = await fetch(url, Object.assign({}, opts, { headers: headers })); }
      catch (e) { throw fail('offline', 'No internet connection, or Google Drive could not be reached.'); }
      if (r.status === 401) { token = null; throw fail('auth', 'Your Google sign-in has ended. Please sign in again.'); }
      if (!r.ok) {
        var msg = r.statusText;
        try { msg = (await r.json()).error.message || msg; } catch (e) {}
        throw fail(r.status === 404 ? 'notfound' : r.status === 403 ? 'forbidden' : r.status === 429 || r.status >= 500 ? 'busy' : 'http',
          msg, { status: r.status });
      }
      return r;
    }

    async function query(q, pageSize, maxPages) {
      var out = [], page = null;
      for (var i = 0; i < (maxPages || 50); i++) {
        var url = API + '/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(' + FIELDS + ')') +
          '&pageSize=' + (pageSize || 1000) + '&spaces=drive' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
        var data = await (await api(url)).json();
        out = out.concat(data.files || []);
        page = data.nextPageToken;
        if (!page) break;
      }
      return out;
    }

    return {
      demo: false,
      signIn: signIn,
      signedIn: signedIn,
      minutesLeft: minutesLeft,
      list: function (folderId) { return query("'" + qs(folderId) + "' in parents and trashed = false"); },
      get: async function (id) { return (await api(API + '/files/' + id + '?fields=' + FIELDS)).json(); },
      readBytes: async function (id) { return new Uint8Array(await (await api(API + '/files/' + id + '?alt=media')).arrayBuffer()); },
      // Saves into the same file. Refuses (conflict) if it changed elsewhere since it was opened.
      saveText: async function (id, text, expectedMd5) {
        if (expectedMd5) {
          var now = await (await api(API + '/files/' + id + '?fields=' + FIELDS)).json();
          if (now.trashed || now.md5Checksum !== expectedMd5) return { conflict: true, file: now };
        }
        var r = await api(UPLOAD + '/files/' + id + '?uploadType=media&fields=' + FIELDS, {
          method: 'PATCH', headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: text
        });
        return { file: await r.json() };
      },
      create: async function (name, parentId, text) {
        var b = 'bnd' + Math.random().toString(36).slice(2);
        var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify({ name: name, parents: [parentId], mimeType: 'text/markdown' }) + '\r\n--' + b +
          '\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
        var r = await api(UPLOAD + '/files?uploadType=multipart&fields=' + FIELDS, {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
        });
        return r.json();
      },
      searchNames: function (text) {
        return query("name contains '" + qs(text) + "' and trashed = false and mimeType != '" + FOLDER + "'", 50, 1);
      },
      findExact: async function (name, parentId) {
        var q = "name = '" + qs(name) + "' and trashed = false" + (parentId ? " and '" + qs(parentId) + "' in parents" : '');
        return (await query(q, 10, 1))[0] || null;
      },
      // Lets the phone's player stream a video without downloading it all first.
      streamUrl: function (id) { return signedIn() ? API + '/files/' + id + '?alt=media&access_token=' + encodeURIComponent(token) : null; }
    };
  }

  // ---------------- Demo vault ----------------
  function DemoDrive() {
    var enc = new TextEncoder();
    var n = 0;
    var files = {};
    function add(name, parent, mime, content) {
      var id = 'demo' + (++n);
      var bytes = typeof content === 'string' ? enc.encode(content) : (content || new Uint8Array());
      files[id] = { id: id, name: name, mimeType: mime, parents: [parent], bytes: bytes, rev: 1,
        size: String(bytes.length), modifiedTime: new Date(Date.now() - n * 86400000).toISOString(),
        createdTime: new Date(2025, 0, 1).toISOString(), webViewLink: 'https://drive.google.com/', trashed: false };
      return id;
    }
    var home = CFG.HOME_FOLDER_ID;
    var vault = add('Vik Vault (demo)', home, FOLDER);
    var misc = add('002 Misc', vault, FOLDER);
    var assets = add('998 Assets', vault, FOLDER);
    var draw = add('997 Excalidraw', vault, FOLDER);
    add('.obsidian', vault, FOLDER);
    add('Welcome.md', vault, 'text/markdown',
      '---\ntags: [demo]\n---\n# Welcome to the demo\n\nThis is a **pretend vault** so you can try the app.\n\n' +
      '- [ ] Tap *Edit* and type something\n- [x] Links like [[Reading list]] open other notes\n\n' +
      '## A picture\n![[Pasted image demo.png]]\n\n## A PDF\n![[Sample.pdf]]\n\n## A drawing\n![[Sketch.excalidraw]]\n\n' +
      '## An embedded note\n![[Reading list#Now]]\n');
    add('Reading list.md', misc, 'text/markdown', '# Reading list\n\n## Now\n- Atomic Habits\n- Deep Work\n\n## Later\n- Gödel, Escher, Bach\n');
    add('HP Printer Refill Links.md', misc, 'text/markdown', 'https://www.youtube.com/watch?v=j_glxAuV5Rk\n\nGoogle: hp 3835 cartridge reuse hack\n');
    var pngBase64 = window.DEMO_PNG || '';
    var png = pngBase64 ? Uint8Array.from(atob(pngBase64), function (c) { return c.charCodeAt(0); }) : new Uint8Array();
    add('Pasted image demo.png', assets, 'image/png', png);
    add('Sample.pdf', assets, 'application/pdf', enc.encode(window.DEMO_PDF || ''));
    add('Sketch.excalidraw.md', draw, 'text/markdown', window.DEMO_DRAWING || '');

    function md5ish(f) { return f.id + ':' + f.rev; }
    function meta(f) {
      return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime,
        createdTime: f.createdTime, parents: f.parents, webViewLink: f.webViewLink, md5Checksum: md5ish(f), trashed: f.trashed };
    }
    function wait(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 120); }); }
    function live() { return Object.keys(files).map(function (k) { return files[k]; }).filter(function (f) { return !f.trashed; }); }
    var signed = false;
    return {
      demo: true,
      signIn: function () { signed = true; return wait(); },
      signedIn: function () { return signed; },
      minutesLeft: function () { return 60; },
      list: function (folderId) { return wait(live().filter(function (f) { return f.parents[0] === folderId; }).map(meta)); },
      get: function (id) { return files[id] ? wait(meta(files[id])) : Promise.reject(fail('notfound', 'File not found')); },
      readBytes: function (id) { return wait(files[id].bytes); },
      saveText: function (id, text, expected) {
        var f = files[id];
        if (expected && md5ish(f) !== expected) return wait({ conflict: true, file: meta(f) });
        f.bytes = enc.encode(text); f.size = String(f.bytes.length); f.rev++; f.modifiedTime = new Date().toISOString();
        return wait({ file: meta(f) });
      },
      create: function (name, parentId, text) { return wait(meta(files[add(name, parentId, 'text/markdown', text)])); },
      searchNames: function (t) {
        t = t.toLowerCase();
        return wait(live().filter(function (f) { return f.mimeType !== FOLDER && f.name.toLowerCase().indexOf(t) > -1; }).map(meta));
      },
      findExact: function (name, parentId) {
        var f = live().filter(function (x) { return x.name === name && (!parentId || x.parents[0] === parentId); })[0];
        return wait(f ? meta(f) : null);
      },
      streamUrl: function () { return null; },
      // For tests: pretend the laptop changed a note.
      _touch: function (name) { var f = live().filter(function (x) { return x.name === name; })[0]; if (f) f.rev++; }
    };
  }

  var demo = !CFG.CLIENT_ID || /(^|[#&])demo\b/.test(location.hash);
  window.Drive = demo ? DemoDrive() : RealDrive();
  window.Drive.FOLDER = FOLDER;
})();
