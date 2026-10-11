// Screenshot tool self-test, only used when VB_SNIPTEST=<folder> is set: drives the real overlay with real mouse and
// key events (an area, F, L, drawing, text, steps, pixelating, the window picker), checks every way out (board, copy,
// save, pin, short link against a local copy of the server), saves pictures of the overlay and a JSON report to that
// folder, then quits. The overlays and pinned screenshots are fully transparent while it runs, notifications are
// silenced, and whatever was on the clipboard is put back at the end.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { BrowserWindow, clipboard, ClipboardItem, dialog, Notification, screen, desktopCapturer, nativeImage } = require('electron');

const wait = ms => new Promise(r => setTimeout(r, ms));
// the clipboard (Electron 44's is asynchronous): the picture on it, or an empty one; and its text
async function clipImage() {
  for (const item of await clipboard.read()) {
    if (item.types.includes('image/png')) return nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()));
  }
  return nativeImage.createEmpty();
}
const clipText = () => clipboard.readText();
// the first pixel of a 1 × 1 PNG, as [r, g, b]
function pngPixel(buf) {
  let i = 8, idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

module.exports = function sniptest(app, win, outDir) {
  const report = { steps: [] };
  const note = (name, v) => { report.steps.push(name); report[name] = v; };
  const notes = [];
  Notification.prototype.show = function () { notes.push(this.title); };
  app.on('browser-window-created', (e, w) => {
    setTimeout(() => { if (!w.isDestroyed() && /^Venom Board (screenshot|pinned screenshot)$/.test(w.getTitle())) w.setOpacity(0); }, 0);
  });
  let saved = null, server = null;

  win.webContents.once('did-finish-load', async () => {
    const farRight = Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width)) + 400;
    win.setSkipTaskbar(true);
    win.setPosition(farRight, 0);
    win.showInactive();
    win.webContents.setBackgroundThrottling(false);
    await wait(2500);
    try { saved = await clipboard.read(); } catch (e) { saved = null; }
    const js = code => win.webContents.executeJavaScript(code);
    const overlays = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.getTitle() === 'Venom Board screenshot');
    const pinsOpen = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.getTitle() === 'Venom Board pinned screenshot');
    const primary = screen.getPrimaryDisplay();
    async function overlay(opts = {}) {
      await js(`window.venomDesktop.snip(${JSON.stringify(opts)})`);
      for (let i = 0; i < 80; i++) {
        const o = overlays().find(w => { const b = w.getBounds(); return b.x === primary.bounds.x && b.y === primary.bounds.y; });
        if (o && o.isVisible() && (await o.webContents.executeJavaScript('document.body.dataset.mode')) !== 'wait') return o;
        await wait(100);
      }
      throw new Error('the overlay never opened');
    }
    const oj = (o, code) => o.webContents.executeJavaScript(code);
    const mouse = async (o, type, x, y, down) => { o.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: down ? ['leftButtonDown'] : [] }); await wait(16); };
    async function drag(o, a, b, steps = 8) {
      await mouse(o, 'mouseMove', a[0], a[1]);
      await mouse(o, 'mouseDown', a[0], a[1]);
      for (let i = 1; i <= steps; i++) await mouse(o, 'mouseMove', a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps, true);
      await mouse(o, 'mouseUp', b[0], b[1]);
      await wait(60);
    }
    const click = async (o, x, y) => { await mouse(o, 'mouseMove', x, y); await mouse(o, 'mouseDown', x, y); await mouse(o, 'mouseUp', x, y); await wait(60); };
    async function key(o, keyCode, modifiers = []) {
      o.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      o.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await wait(80);
    }
    const shot = async (o, name) => { o.webContents.invalidate(); await wait(250); fs.writeFileSync(path.join(outDir, name), (await o.webContents.capturePage()).toPNG()); };
    const gone = async () => { for (let i = 0; i < 50 && overlays().length; i++) await wait(100); return !overlays().length; };
    const state = o => oj(o, `({mode: document.body.dataset.mode, sel: (s => s.display === 'block' ? [parseFloat(s.left), parseFloat(s.top), parseFloat(s.width), parseFloat(s.height)] : null)(document.getElementById('sel').style), size: document.getElementById('size').textContent})`);
    const boardImages = () => js("document.querySelectorAll('.item.image').length");

    try {
      // 1. the frozen screen is exact: pixels match a separate capture (so the BGRA → RGBA turn is right)
      let o = await overlay();
      const S = primary.scaleFactor;
      const thumb = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(primary.size.width * S), height: Math.round(primary.size.height * S) } }))
        .find(s => s.display_id === String(primary.id)) || null;
      const points = [[3, 3], [40, 300], [primary.size.width - 5, primary.size.height - 5], [Math.round(primary.size.width / 2), 8], [10, primary.size.height - 12]];
      let same = 0, swapped = 0;
      for (const [x, y] of points) {
        const px = [Math.floor(x * S), Math.floor(y * S)];
        const mine = await oj(o, `Array.from(document.getElementById('bg').getContext('2d').getImageData(${px[0]}, ${px[1]}, 1, 1).data.slice(0, 3))`);
        const ref = thumb ? pngPixel(thumb.thumbnail.crop({ x: px[0], y: px[1], width: 1, height: 1 }).toPNG()) : null;
        if (!ref) continue;
        const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 6);
        if (close(mine, ref)) same++;
        if (close(mine, [ref[2], ref[1], ref[0]]) && ref[0] !== ref[2]) swapped++;
      }
      note('pixelsMatch', { same, swapped, of: points.length });
      note('selectMode', await state(o));
      await mouse(o, 'mouseMove', 300, 200);
      await shot(o, 'snip-1-select.png');

      // 2. drag an area: the editor and its toolbars appear; draw an arrow, a box, text, a step and a pixelated patch
      await drag(o, [200, 150], [700, 450]);
      note('afterDrag', await state(o));
      note('toolbars', await oj(o, "['tools', 'acts'].map(id => getComputedStyle(document.getElementById(id)).display)"));
      await key(o, 'A'); await drag(o, [260, 400], [420, 220]);
      await key(o, 'R'); await drag(o, [450, 200], [600, 280]);
      await key(o, 'B'); await drag(o, [470, 320], [650, 420]);
      await key(o, 'N'); await click(o, 240, 180); await click(o, 300, 180);
      await key(o, 'T'); await click(o, 460, 300);
      o.webContents.insertText('Bug here');
      await key(o, 'Enter');
      await key(o, 'V');
      await shot(o, 'snip-2-edit.png');
      // undo and redo the last thing (the text)
      await key(o, 'Z', ['control']); await key(o, 'Y', ['control']);
      // Ctrl+C: on the clipboard at full resolution, with the drawing on it; the board stays where it was
      const before = await boardImages();
      await key(o, 'C', ['control']);
      note('copyClosed', await gone());
      const copied = await clipImage(), csz = copied.getSize();
      const red = csz.width ? pngPixel(copied.crop({ x: Math.round(((260 + 420) / 2 - 200) * S), y: Math.round(((400 + 220) / 2 - 150) * S), width: 1, height: 1 }).toPNG()) : null;
      note('copy', { size: csz, expected: { width: Math.round(500 * S), height: Math.round(300 * S) }, arrowPixel: red, boardUnchanged: (await boardImages()) === before, notified: notes.includes('Screenshot copied') });

      // 3. F takes the whole screen; Enter puts it on the board (and the clipboard)
      o = await overlay();
      await key(o, 'F');
      note('wholeScreen', await state(o));
      await key(o, 'Enter');
      await gone();
      for (let i = 0; i < 30 && (await boardImages()) === before; i++) await wait(100);
      note('board', { images: await boardImages(), before, clipboard: (await clipImage()).getSize() });

      // 4. L brings back the last area (the whole screen now); then a smaller one, pinned on top where it was
      o = await overlay();
      await key(o, 'L');
      note('lastArea', await state(o));
      await key(o, 'Escape');
      await gone();
      o = await overlay();
      await drag(o, [100, 100], [340, 260]);
      await key(o, 'P', ['control']);
      await gone();
      await wait(600);
      const pin = pinsOpen()[0];
      note('pin', pin ? { bounds: pin.getBounds(), expected: { x: primary.bounds.x + 100, y: primary.bounds.y + 100, width: 240, height: 160 } } : null);
      if (pin) {
        pin.webContents.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaY: 120, wheelTicksY: 1 });  // scroll up: bigger
        await wait(300);
        note('pinZoomed', pin.getBounds());
        pin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await wait(400);
        note('pinClosed', !pinsOpen().length);
      }

      // 5. save: the dialog (stubbed here) and the file
      const file = path.join(outDir, 'saved-shot.png'), realSave = dialog.showSaveDialog;
      let asked = null;
      dialog.showSaveDialog = async (...a) => { asked = (a.find(x => x && x.defaultPath) || {}).defaultPath; return { canceled: false, filePath: file }; };
      o = await overlay();
      await drag(o, [500, 500], [620, 580]);
      await key(o, 'S', ['control']);
      await gone();
      for (let i = 0; i < 30 && !fs.existsSync(file); i++) await wait(100);
      dialog.showSaveDialog = realSave;
      note('save', { suggested: asked && path.basename(asked), written: fs.existsSync(file), size: fs.existsSync(file) ? nativeImage.createFromPath(file).getSize() : null });

      // 6. the window picker: W lists windows; picking one opens it in the editor at its own size
      o = await overlay();
      await key(o, 'W');
      let cards = 0;
      for (let i = 0; i < 50 && !cards; i++) { await wait(100); cards = await oj(o, "document.querySelectorAll('#wins .grid button').length"); }
      note('windows', { mode: (await state(o)).mode, cards });
      await shot(o, 'snip-3-windows.png');
      if (cards) {
        const r = await oj(o, "(b => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, b.title]; })(document.querySelector('#wins .grid button'))");
        await click(o, r[0], r[1]);
        let st = null;
        for (let i = 0; i < 60; i++) { await wait(100); st = await state(o); if (st.mode === 'edit') break; }
        note('windowPicked', { title: r[2], ...st });
        await shot(o, 'snip-4-window.png');
      }
      await key(o, 'Escape');
      await gone();

      // 7. short links, against a local copy of the server: the app is loaded from that server's /app and signed in there
      const serverDir = process.env.VB_SERVER_DIR || path.join(__dirname, '..', '..', '..', 'Venom Board Server', 'server');
      if (fs.existsSync(path.join(serverDir, 'src', 'index.js'))) {
        const data = fs.mkdtempSync(path.join(outDir, 'server-'));
        const port = 18000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
        server = spawn(process.env.VB_NODE || 'node', ['src/index.js'], { cwd: serverDir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, PUBLIC_URL: base, QUIET: 'true', MIN_FREE_DISK_MB: '0', RATE_SCALE: '50', APP_DIR: path.join(__dirname, '..', '..'), INDEXNOW: 'off' }, stdio: 'ignore' });
        for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) { /* not up yet */ } await wait(200); }
        const signup = await (await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'shots@studio.test', username: 'shots', password: 'correct horse', displayName: 'Shots' }) })).json();
        await win.loadURL(base + '/app');
        await wait(1200);
        await js(`localStorage.setItem('venom-board-account', JSON.stringify({token: ${JSON.stringify(signup.token)}}))`);
        await win.loadURL(base + '/app');
        let signedIn = false;
        for (let i = 0; i < 50 && !signedIn; i++) { await wait(100); signedIn = await js("document.getElementById('teamBtn').classList.contains('signed')"); }
        // from the screenshot tool: Ctrl+L, and the link is on the clipboard
        o = await overlay();
        await drag(o, [150, 150], [450, 350]);
        await key(o, 'A'); await drag(o, [200, 300], [400, 200]);
        await key(o, 'L', ['control']);
        await gone();
        let link = '';
        for (let i = 0; i < 80 && !/\/s\/\w{12}$/.test(link); i++) { await wait(100); link = await clipText(); }
        const page = /\/s\/\w{12}$/.test(link) ? await fetch(link) : null, html = page ? await page.text() : '';
        const image = (html.match(/og:image" content="([^"]+)"/) || [])[1];
        const img = image ? Buffer.from(await (await fetch(image)).arrayBuffer()) : null;
        note('linkFromTool', { signedIn, link: link.replace(base, ''), page: page && page.status, image: img ? nativeImage.createFromBuffer(img).getSize() : null, notified: notes.includes('Screenshot link copied') });
        // any picture on the board: right-click it → Get a short link
        o = await overlay();
        await drag(o, [300, 300], [520, 440]);
        await key(o, 'Enter');
        await gone();
        await wait(1500);
        const menuLabels = await js(`(async () => {
          const el = document.querySelector('.item.image');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2}));
          await new Promise(res => setTimeout(res, 300));
          const items = [...document.querySelectorAll('#menu button')];
          const b = items.find(x => /Get a short link/.test(x.textContent));
          if (b) b.click();
          return items.map(x => (x.querySelector('.lbl') || x).textContent.trim()).filter(Boolean);
        })()`);
        let link2 = link;
        for (let i = 0; i < 80 && link2 === link; i++) { await wait(100); link2 = await clipText(); }
        note('linkFromBoard', { menuHasIt: !!menuLabels && menuLabels.includes('Get a short link'), link: link2.replace(base, ''), page: link2 !== link ? (await fetch(link2)).status : null });
        // Settings → Account lists them; deleting one asks first, then it's gone from the list and the server
        await js("window.dispatchEvent(new KeyboardEvent('keydown', {key: ',', code: 'Comma', ctrlKey: true, bubbles: true}))");
        await wait(300);
        await js("[...document.querySelectorAll('.st-tab')].find(b => b.textContent.trim() === 'Account').click()");
        let rows = 0;
        for (let i = 0; i < 50 && rows < 2; i++) { await wait(100); rows = await js("document.querySelectorAll('.st-shot').length"); }
        await js("document.querySelector('.st-shot').scrollIntoView({block: 'center'})");
        win.webContents.invalidate(); await wait(500);
        fs.writeFileSync(path.join(outDir, 'snip-5-settings.png'), (await win.webContents.capturePage()).toPNG());
        await js("[...document.querySelectorAll('.st-shot button')].find(b => b.textContent === 'Delete').click()");
        await wait(300);
        await js("document.getElementById('cfYes').click()");
        let left = rows;
        for (let i = 0; i < 30 && left >= rows; i++) { await wait(100); left = await js("document.querySelectorAll('.st-shot').length"); }
        const statuses = [(await fetch(link)).status, link2 !== link ? (await fetch(link2)).status : null];
        note('settingsList', { rows, afterDelete: left, statusesAfter: statuses });
        await js("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
      } else note('linkFromTool', 'skipped: no server checkout at ' + serverDir);
    } catch (e) {
      report.error = String(e && e.stack || e);
    }
    for (const w of overlays()) w.destroy();
    for (const w of pinsOpen()) w.destroy();
    if (server) server.kill();
    // what was on the clipboard before goes back (as new items: the ones read can't be written again)
    try {
      if (saved && saved.length) {
        const items = [];
        for (const it of saved) { const o = {}; for (const t of it.types) o[t] = await it.getType(t); items.push(new ClipboardItem(o)); }
        await clipboard.write(items);
      }
    } catch (e) { report.clipboardRestore = String(e); }
    fs.writeFileSync(path.join(outDir, 'snip-report.json'), JSON.stringify(report, null, 2));
    app.quit();
  });
};
