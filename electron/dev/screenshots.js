// Renders the README screenshots from the real app with simulated input.
// Usage: set VB_SHOTS=<folder>, then run the app. It works on a fresh sample board and quits when done.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

module.exports = function screenshots(app, win, outDir) {
  win.webContents.once('did-finish-load', async () => {
    const wc = win.webContents;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const js = code => wc.executeJavaScript(code);

    // paint for real, but beyond the right edge of every monitor and without a taskbar button
    const farRight = Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width)) + 400;
    win.setSkipTaskbar(true);
    win.setContentSize(1600, 1000);
    win.setPosition(farRight, 0);
    win.showInactive();
    wc.setBackgroundThrottling(false);
    await wait(3500);
    // the native window buttons are not part of a page capture, so let the top bar use that space
    await js("document.getElementById('top').style.paddingRight = '12px'");

    const shot = async name => {
      await wait(700);
      fs.writeFileSync(path.join(outDir, name + '.png'), (await wc.capturePage()).toPNG());
    };
    const rect = sel => js(`(() => { const r = (${sel}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
    const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
    const click = async (x, y, button = 'left') => {
      mouse('mouseMove', x, y);
      mouse('mouseDown', x, y, { button, clickCount: 1 });
      mouse('mouseUp', x, y, { button, clickCount: 1 });
      await wait(300);
    };
    const drag = async (x0, y0, x1, y1) => {
      mouse('mouseMove', x0, y0);
      mouse('mouseDown', x0, y0, { button: 'left', clickCount: 1 });
      for (let i = 1; i <= 14; i++) {
        mouse('mouseMove', x0 + (x1 - x0) * i / 14, y0 + (y1 - y0) * i / 14, { button: 'left', modifiers: ['leftButtonDown'] });
        await wait(16);
      }
      mouse('mouseUp', x1, y1, { button: 'left', clickCount: 1 });
      await wait(500);
    };
    const key = (k, extra = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, ...extra })}))`);
    const fit = async () => { await js("document.getElementById('zoomBtn').click()"); await wait(700); };
    const card = t => `[...document.querySelectorAll('.item.node')].find(e => e.textContent.includes(${JSON.stringify(t)}))`;
    const menuButton = t => `[...document.querySelectorAll('#menu button')].find(b => b.textContent.includes(${JSON.stringify(t)}))`;

    try {
      // 1. the whole sample roadmap
      await fit();
      await shot('board');

      // 2. planner with the "ready to start" filter dimming everything else
      await js("document.getElementById('planBtn').click()");
      await wait(300);
      await js("document.querySelector('[data-f=\"ready\"]').click()");
      await fit();
      await shot('planner');
      await js("document.querySelector('[data-pl=\"clear\"]').click()");
      await js("document.getElementById('planBtn').click()");
      await wait(300);

      // 3. close-up of one phase: click its title tab, fit the selection, deselect
      const tab = await rect("document.querySelectorAll('#frameLayer .item.frame')[1].querySelector('.f-title')");
      await click(tab.x, tab.y);
      await key('@', { code: 'Digit2', shiftKey: true });
      await wait(500);
      await key('Escape');
      await shot('cards');

      // 4. drag a tendril out of a card into empty space: the place-next picker
      const c = await rect(card('First playtest'));
      await click(c.x, c.t + 40);
      const port = await rect("document.querySelector('#ui .u-port')");
      const frame = await rect("document.querySelectorAll('#frameLayer .item.frame')[1]");
      await drag(port.x, port.y, frame.l + frame.w * 0.06, frame.t + frame.h * 0.86);
      await shot('place-next');
      await js("document.getElementById('pkSearch').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
      await key('Escape');

      // 5. template gallery
      await fit();
      await js("document.getElementById('tplBtn').click()");
      await shot('templates');
      await key('Escape');

      // 6. right-click window menu, with the opacity slider moved off 100%
      await js("(() => { const r = document.getElementById('opRange'); r.value = 85; r.dispatchEvent(new Event('input', {bubbles: true})); })()");
      await wait(300);
      const mm = await rect("document.getElementById('minimap')");
      await click(mm.l + 40, mm.t + 30, 'right');
      await shot('window-menu');
      await key('Escape');
      await js("(() => { const r = document.getElementById('opRange'); r.value = 100; r.dispatchEvent(new Event('input', {bubbles: true})); })()");

      // 7. Anti-Venom skin
      await js("document.getElementById('viewBtn').click()");
      await wait(200);
      await js(`${menuButton('Anti-Venom skin')}.click()`);
      await fit();
      await shot('anti-venom');
      await js("document.getElementById('viewBtn').click()");
      await wait(200);
      await js(`${menuButton('Venom skin')}.click()`);
    } catch (e) {
      fs.writeFileSync(path.join(outDir, 'screenshots-error.txt'), String(e && e.stack || e));
    }
    app.quit();
  });
};
