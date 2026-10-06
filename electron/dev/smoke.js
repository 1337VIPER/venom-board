// Self-test, only used when VB_SMOKE=<folder> is set: loads the app hidden, exercises the
// desktop-only window controls, saves screenshots and a JSON report to that folder, then quits.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

module.exports = function smoke(app, win, outDir) {
  win.webContents.once('did-finish-load', async () => {
    // paint for real, but beyond the right edge of every monitor and without a taskbar button
    const farRight = Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width)) + 400;
    win.setSkipTaskbar(true);
    win.setPosition(farRight, 0);
    win.showInactive();
    await new Promise(r => setTimeout(r, 3000));
    const report = {};
    const js = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const shot = async name => {
      win.webContents.invalidate();  // hidden windows skip repaints; force a fresh frame first
      await wait(400);
      fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    win.webContents.setBackgroundThrottling(false);
    try {
      report.bridge = await js('typeof window.venomDesktop');
      report.cards = await js("document.querySelectorAll('.item.node').length");
      report.opacitySliderVisible = await js("getComputedStyle(document.querySelector('.opac')).display !== 'none'");

      report.pin = await js('window.venomDesktop.setPin(true)') && win.isAlwaysOnTop();
      await js('window.venomDesktop.setPin(false)');

      await js("(() => { const r = document.getElementById('opRange'); r.value = 70; r.dispatchEvent(new Event('input', {bubbles: true})); })()");
      await wait(300);
      report.opacityFromTopSlider = Math.round(win.getOpacity() * 100) / 100;
      report.opacityLabel = await js("document.getElementById('opVal').textContent");
      await js('window.venomDesktop.setOpacity(1)');

      const locked = await js('window.venomDesktop.setLock(true)');
      report.lock = {state: locked.locked, movable: win.isMovable(), resizable: win.isResizable()};
      await wait(150);
      report.lockBadgeShown = await js("!document.getElementById('winLockBtn').hidden");
      await js('window.venomDesktop.setLock(false)');
      report.unlock = {movable: win.isMovable(), resizable: win.isResizable()};

      const ct = await js('window.venomDesktop.setClickThrough(true)');
      await wait(200);
      report.clickThrough = {on: ct.clickThrough, keyRegistered: ct.keyOk, key: ct.keyLabel, autoPinned: win.isAlwaysOnTop(),
        badge: await js("!document.getElementById('ctBadge').hidden")};
      await shot('electron-clickthrough.png');
      const ctOff = await js('window.venomDesktop.setClickThrough(false)');
      await wait(200);
      report.clickThroughOff = {on: ctOff.clickThrough, unpinnedAgain: !win.isAlwaysOnTop(), keyReleased: !ctOff.keyOk,
        badgeGone: await js("document.getElementById('ctBadge').hidden && !document.documentElement.classList.contains('ct-on')")};

      const k = await js("window.venomDesktop.setClickKey('CommandOrControl+Alt+Shift+F9')");
      report.keyChange = {ok: k.ok, label: k.keyLabel};
      await js("window.venomDesktop.setClickKey('CommandOrControl+Shift+X')");

      const ctrlShiftB = "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true, bubbles: true}))";
      await js(ctrlShiftB); await wait(200);
      report.topbarHidden = await js("getComputedStyle(document.getElementById('top')).display === 'none'");
      await js(ctrlShiftB); await wait(200);
      report.topbarBack = await js("getComputedStyle(document.getElementById('top')).display !== 'none'");

      // file guard: the page may only write to files picked in a dialog (dialog stubbed so nothing pops up)
      const { dialog } = require('electron');
      const realSave = dialog.showSaveDialog;
      const evil = path.join(outDir, 'not-picked.txt'), picked = path.join(outDir, 'picked.txt');
      let dialogCalls = 0, answer = { canceled: true };
      dialog.showSaveDialog = async () => { dialogCalls++; return answer; };
      const blockedWrite = await js(`window.venomDesktop.saveFile({name: 'x.txt', data: 'pwned', path: ${JSON.stringify(evil)}})`);
      report.fileGuard = { unpickedPathAskedDialog: dialogCalls === 1, unpickedResult: blockedWrite, unpickedFileWritten: fs.existsSync(evil) };
      answer = { canceled: false, filePath: picked };
      await js(`window.venomDesktop.saveFile({name: 'picked.txt', data: 'one'})`);
      const before = dialogCalls;
      await js(`window.venomDesktop.saveFile({name: 'picked.txt', data: 'two', path: ${JSON.stringify(picked)}})`);
      report.fileGuard.pickedFileResaveSkipsDialog = dialogCalls === before;
      report.fileGuard.pickedFileContent = fs.readFileSync(picked, 'utf8');
      dialog.showSaveDialog = realSave;

      await js("document.getElementById('minimap').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 1100, clientY: 300}))");
      await wait(200);
      report.windowMenu = await js("[...document.querySelectorAll('#menu button .lbl, #menu .msl span')].map(e => e.textContent)");
      await shot('electron-menu.png');
      await js("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");

      // settings: Ctrl+, opens it, the desktop page drives the real window, Esc closes it
      await js("window.dispatchEvent(new KeyboardEvent('keydown', {key: ',', code: 'Comma', ctrlKey: true, bubbles: true}))");
      await wait(300);
      report.settings = {open: await js("!document.getElementById('settings').hidden"), tabs: await js("[...document.querySelectorAll('.st-tab')].map(b => b.textContent.trim())")};
      await js("[...document.querySelectorAll('.st-tab')].find(b => b.textContent.trim() === 'Desktop app').click()");
      await wait(200);
      await js("document.querySelector('.st-sw[aria-label=\"Pin on top\"]').click()");
      await wait(400);
      report.settings.pinSwitch = {pinned: win.isAlwaysOnTop(), shown: await js("document.querySelector('.st-sw[aria-label=\"Pin on top\"]').getAttribute('aria-checked')")};
      report.settings.version = await js("[...document.querySelectorAll('#stBody .st-txt b')].map(b => b.textContent).find(t => /^Version|ready|Downloading/.test(t)) || ''");
      await shot('electron-settings.png');
      await js("document.querySelector('.st-sw[aria-label=\"Pin on top\"]').click()");
      await wait(300);
      report.settings.unpinned = !win.isAlwaysOnTop();
      await js("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
      report.settings.closed = await js("document.getElementById('settings').hidden");

      // hostile board file: markup in colours, ids, widths and text must never reach the page as HTML
      report.hostileBoard = await js(`(async () => {
        const X = '"><img src=x onerror="window.__pwned=1">';
        const board = {app: 'venom-board', version: 2, name: 'Hostile' + X, cam: {x: X, y: 0, z: 1}, doc: {
          items: [
            {id: 'a1', type: 'node', kind: 'task', x: 0, y: 0, w: 240, title: 'Card ' + X, body: '[ ] ' + X, color: X, disc: X, prio: X, est: X, due: X},
            {id: 'b1' + X, type: 'node', x: 300, y: 0, w: 240, title: 'bad id'},
            {id: 'm1', type: 'node', kind: 'milestone', x: 0, y: 300, w: 250, title: 'MS ' + X, color: X, due: '2030-01-01'},
            {id: 'f1', type: 'frame', x: -40, y: -60, w: 700, h: 600, title: 'Phase ' + X, color: X},
            {id: 'i1', type: 'image', x: 600, y: 0, w: 80, h: 80, src: 'javascript:window.__pwned=1'}],
          links: [{id: 'l1', from: {id: 'a1'}, to: {id: 'm1'}, color: X, width: X, label: X, style: X, head: X}],
          strokes: [{id: 's1', kind: 'pen', color: X, size: X, pts: [0, 0, 40, 40]}]}, assets: {}};
        const dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(board)], 'hostile.venomboard.json', {type: 'application/json'}));
        document.getElementById('stage').dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt, clientX: 300, clientY: 300}));
        await new Promise(r => setTimeout(r, 800));
        if (document.getElementById('planner').hidden) document.getElementById('planBtn').click();
        await new Promise(r => setTimeout(r, 800));
        return {pwned: !!window.__pwned, injectedElements: document.querySelectorAll('[onerror]').length,
          cards: document.querySelectorAll('.item.node').length, plannerRows: document.querySelectorAll('.pl-row, .pl-msrow').length,
          links: document.querySelectorAll('#linkSvg .l-path').length};
      })()`);
    } catch (e) {
      report.error = String(e && e.stack || e);
    }
    fs.writeFileSync(path.join(outDir, 'electron-smoke.json'), JSON.stringify(report, null, 2));
    app.quit();
  });
};
