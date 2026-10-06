// Layout check for small and large screens (run with VB_LAYOUT=<dir>). Resizes the real desktop window
// through common screen sizes and interface sizes, measures whether anything spills under the window
// buttons or off the tool spine, and saves screenshots. Never shipped in the installer.
const fs = require('fs');
const path = require('path');

const SIZES = [[1920, 1040], [1366, 728], [1093, 614], [1024, 576], [800, 480], [560, 420], [480, 400]];
const SCALES = [0.8, 1, 1.25, 1.5];
const MEASURE = `(() => {
  const $ = s => document.querySelector(s), top = $('#top'), cs = getComputedStyle(top);
  const limit = top.getBoundingClientRect().right - parseFloat(cs.paddingRight) + 0.5;
  const kids = [...top.children].filter(e => e.getClientRects().length);
  const over = Math.max(0, ...kids.map(e => e.getBoundingClientRect().right - limit));
  let overlap = 0;
  for (let i = 0; i < kids.length - 1; i++) overlap = Math.max(overlap, kids[i].getBoundingClientRect().right - kids[i + 1].getBoundingClientRect().left);
  const t = $('#tools'), bs = $('.boardsel');
  return { css: innerWidth + 'x' + innerHeight, topH: Math.round(top.getBoundingClientRect().height), reserved: Math.round(parseFloat(cs.paddingRight)),
    overflow: Math.round(over), overlap: Math.round(Math.max(0, overlap)), nameSpill: bs.scrollWidth - bs.clientWidth,
    folded: top.querySelectorAll('.folded').length, more: $('#moreBtn').classList.contains('on'),
    toolsHidden: t.scrollHeight - t.clientHeight };
})()`;

module.exports = function layout(app, win, dir) {
  const { screen } = require('electron');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  // paint for real, just beyond the right edge of every monitor, without a taskbar button
  const farRight = Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width)) + 400;
  win.setSkipTaskbar(true);
  win.webContents.once('did-finish-load', async () => {
    const results = [];
    try {
      win.setPosition(farRight, 0);
      win.showInactive();
      win.webContents.setBackgroundThrottling(false);
      await wait(2000);
      for (const scale of SCALES) {
        await js(`window.venomDesktop.setUiScale(${scale})`);
        for (const [w, h] of SIZES) {
          win.setContentSize(w, h);
          win.setPosition(farRight, 0);
          await wait(500);
          const m = await js(MEASURE);
          const overlayH = Math.round(52 * scale);
          results.push({ scale, window: `${w}x${h}`, ...m, topMatchesOverlay: Math.abs(m.topH * scale - overlayH) <= 1 });
          if ((w === 800 && scale === 1) || (w === 1366 && scale === 1.25) || (w === 480 && scale === 0.8)) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, `layout-${w}x${h}-${Math.round(scale * 100)}.png`), img.toPNG());
          }
        }
      }
      await js('window.venomDesktop.setUiScale(1)');
    } catch (e) {
      results.push({ error: String(e && e.stack || e) });
    }
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(results, null, 1));
    app.exit(0);
  });
};
