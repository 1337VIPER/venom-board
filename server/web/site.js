// Landing page: if you're already signed in, the top bar links straight to your account.
fetch('/api/session', { credentials: 'same-origin', headers: { 'X-VB': '1' } })
  .then(r => (r.ok ? r.json() : null))
  .then(s => {
    const a = document.getElementById('navAccount');
    if (s && s.user && a) a.textContent = 'Your teams';
  })
  .catch(() => {});

// Download buttons name the visitor's system. They all still lead to the latest release, which has every installer.
(() => {
  const ua = navigator.userAgent || '', p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') + ' ' + ua;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return;
  const os = /Win/i.test(p) ? 'Windows' : /Mac/i.test(p) ? 'Mac' : /Linux|X11|CrOS/i.test(p) ? 'Linux' : '';
  if (!os) return;
  document.querySelectorAll('[data-dl-label]').forEach(e => { e.textContent = 'Download for ' + os; });
  document.querySelectorAll('[data-dl-sub]').forEach(e => { e.textContent = 'Free desktop app'; });
})();
