// The look the server's own pages share (public roadmaps, playtest forms, screenshot links): escaping, the address
// the server is reached at, and the page shell. venomboard.com puts its own navigation and footer on it (site.js);
// a self-hosted server shows plain ones.
'use strict';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let SITE = '';
const setBase = url => { SITE = String(url).replace(/\/+$/, ''); };
const base = () => SITE;

const BRAND = '<a class="brand" href="/"><img src="/favicon.svg" alt=""><span class="word">VENOM<em>/</em>BOARD</span></a>';
let chrome = {
  nav: `    <div class="nav-end">
      <a class="btn ghost" href="/account" id="navAccount">Sign in</a>
      <a class="btn red" href="/app">Open the app</a>
    </div>
`,
  footer: () => `<footer class="foot">
  <div class="wrap fine">Runs on <a class="inl" href="https://github.com/1337VIPER/venom-board" rel="noopener">Venom Board</a> by 1337VIPER · <a class="inl" href="/app">Open the app</a> · <a class="inl" href="/account">Your account</a></div>
</footer>`,
};
// the navigation (inside the header, after the logo) and the footer
const setChrome = c => { chrome = { ...chrome, ...c }; };
function layout({ title, description, path, image, body, noindex, jsonld, scripts = '' }) {
  const url = SITE + path, img = image || SITE + '/docs/banner.png';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="Venom Board">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#060609">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800;900&family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap">
<link rel="stylesheet" href="/web/site.css">
<script src="/web/site.js" defer></script>${scripts}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>\n` : ''}</head>
<body>
<header class="nav">
  <div class="wrap">
    ${BRAND}
${chrome.nav}
  </div>
</header>
<main>
${body}
</main>
${chrome.footer()}
</body>
</html>`;
}
module.exports = { esc, setBase, base, layout, setChrome, BRAND };
