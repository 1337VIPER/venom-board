// Public roadmap pages: voting, copying the link and reporting. One vote per card per network, and pressing it
// again takes it back. The page reads fine without this script; it just can't vote.
(() => {
  const root = document.getElementById('rm');
  if (!root) return;
  const id = root.dataset.id;
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VB': '1' }, body: JSON.stringify(body) })
    .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again.'); return d; });
  let toastT = 0;
  const note = msg => {
    let t = document.querySelector('.rm-toast');
    if (!t) { t = document.createElement('div'); t.className = 'rm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
  };
  root.addEventListener('click', async e => {
    const v = e.target.closest('.rm-vote');
    if (!v || v.disabled) return;
    v.disabled = true;
    try {
      const r = await post(`/api/roadmaps/${id}/vote`, { card: v.dataset.card });
      v.setAttribute('aria-pressed', String(r.voted));
      v.querySelector('b').textContent = r.votes;
    } catch (err) { note(err.message); }
    v.disabled = false;
  });
  const copy = document.querySelector('.rm-copy');
  if (copy) copy.addEventListener('click', () => navigator.clipboard.writeText(location.href.split('#')[0]).then(() => note('Link copied'), () => note(location.href)));
  const report = document.querySelector('.rm-report');
  if (report) report.addEventListener('click', async () => {
    const reason = window.prompt('What’s wrong with this roadmap (spam, abuse, something illegal)? It goes to the Venom Board team.');
    if (!reason || !reason.trim()) return;
    try { await post(`/api/roadmaps/${id}/report`, { reason: reason.trim().slice(0, 1000) }); note('Thanks. Your report was sent.'); } catch (err) { note(err.message); }
  });
})();
