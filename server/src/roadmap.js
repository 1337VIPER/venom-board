// Public roadmaps: the page players follow for a team project, at /r/<id>. This file decides what a roadmap shows
// and writes its pages (the full page, an embed for other sites, and an RSS feed); collab.js stores roadmaps and
// votes. Nothing private is ever shown: no pictures, comments, people, estimates or links between cards, and no
// card the team hides from the roadmap. Everything shown is escaped.
'use strict';
const site = require('./page');

const { esc } = site;
const DISC = { code: 'Code', art: 'Art', design: 'Design', level: 'Level', audio: 'Audio', ui: 'UI/UX', vfx: 'VFX', narr: 'Narrative', qa: 'QA', tech: 'Tech / build', mkt: 'Marketing' };
const CHK = /^\s*(?:[-*]\s*)?\[([ xX])\]\s?(.*)$/;
const COLUMN_MAX = 150, DONE_SHOWN = 40;
const okHex = c => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#9d99aa');
const slug = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
const pathOf = (rm, name) => `/r/${rm.token}${slug(name) ? '-' + slug(name) : ''}`;

// What a roadmap shows of a board. votes: card id -> count.
function view(doc, rm, votes) {
  const frames = doc.items.filter(i => i.type === 'frame').sort((a, b) => Math.round(a.y / 500) - Math.round(b.y / 500) || a.x - b.x);
  const order = new Map(frames.map((f, i) => [f.id, i]));
  const phase = new Map();
  for (const c of doc.items) {
    if (c.type !== 'node') continue;
    const f = frames.find(f => c.x >= f.x && c.y >= f.y && c.x + (c.w || 0) <= f.x + f.w && c.y + (c.h || 0) <= f.y + f.h);
    if (f) phase.set(c.id, f);
  }
  const shown = c => c.type === 'node' && !c.nopub && c.prio !== 'wont' && (c.kind === 'task' || c.kind === 'milestone' || (c.kind === 'bug' && rm.show_bugs) || (c.kind === 'idea' && rm.show_ideas));
  const cards = doc.items.filter(shown).map(c => {
    const f = phase.get(c.id), lines = String(c.body || '').split('\n');
    const checks = lines.map(l => l.match(CHK)).filter(Boolean);
    const body = lines.filter(l => !CHK.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    return {
      id: c.id, title: String(c.title || '').trim() || 'Untitled card', kind: c.kind, status: c.status, disc: DISC[c.disc] || '', due: c.due || '',
      phase: f ? { id: f.id, title: String(f.title || '').trim() || 'Phase', color: okHex(f.color), n: order.get(f.id) } : null,
      body: rm.show_details ? (body.length > 280 ? body.slice(0, 277).trimEnd() + '…' : body) : '',
      checks: rm.show_details && checks.length ? { done: checks.filter(m => m[1].toLowerCase() === 'x').length, total: checks.length } : null,
      doneAt: c.doneAt || 0, votes: votes.get(c.id) || 0, x: c.x, y: c.y,
    };
  });
  const byPlace = (a, b) => ((a.phase ? a.phase.n : 1e9) - (b.phase ? b.phase.n : 1e9)) || a.y - b.y || a.x - b.x;
  const work = cards.filter(c => c.kind !== 'idea' && c.kind !== 'milestone');
  const milestones = cards.filter(c => c.kind === 'milestone').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || byPlace(a, b));
  for (const m of milestones) {  // how far along the work in the milestone's phase is
    const mine = m.phase ? doc.items.filter(c => shown(c) && c.kind !== 'idea' && c.kind !== 'milestone' && phase.get(c.id) && phase.get(c.id).id === m.phase.id) : [];  // only what the roadmap shows
    m.progress = mine.length ? { done: mine.filter(c => c.status === 'done').length, total: mine.length } : null;
  }
  const done = work.filter(c => c.status === 'done').sort((a, b) => b.doneAt - a.doneAt || byPlace(a, b));
  return {
    milestones,
    columns: [
      ...(rm.show_ideas ? [{ key: 'ideas', title: 'Ideas', note: 'Under consideration', cards: cards.filter(c => c.kind === 'idea').sort(byPlace).slice(0, COLUMN_MAX) }] : []),
      { key: 'planned', title: 'Planned', cards: work.filter(c => c.status === 'todo' || c.status === 'blocked').sort(byPlace).slice(0, COLUMN_MAX) },
      { key: 'doing', title: 'In progress', cards: work.filter(c => c.status === 'doing').sort(byPlace).slice(0, COLUMN_MAX) },
      { key: 'done', title: 'Done', cards: done.slice(0, DONE_SHOWN), more: Math.max(0, done.length - DONE_SHOWN) },
    ],
    publicIds: new Set(cards.map(c => c.id)),
    titles: new Map(cards.map(c => [c.id, c.title])),
    votable: new Set(cards.filter(c => c.kind === 'idea' || (c.kind !== 'milestone' && c.status !== 'done')).map(c => c.id)),
  };
}

const fmtDate = d => { const t = Date.parse(d + 'T00:00:00Z'); return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const daysTo = d => Math.ceil((Date.parse(d + 'T00:00:00Z') - Date.now()) / 86400000);
const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };
const when = m => (m.status === 'done' ? 'Reached' : m.due ? `${fmtDate(m.due)}${daysTo(m.due) > 0 ? ` · in ${daysTo(m.due)} day${daysTo(m.due) === 1 ? '' : 's'}` : daysTo(m.due) === 0 ? ' · today' : ''}` : 'No date yet');

function cardHtml(c, v, voted) {
  const tags = [c.phase ? `<span class="rm-phase" style="--c:${c.phase.color}">${esc(c.phase.title)}</span>` : '', c.kind === 'bug' ? '<span class="rm-tag">Bug fix</span>' : '',
    c.disc ? `<span class="rm-tag">${esc(c.disc)}</span>` : '', c.status === 'blocked' ? '<span class="rm-tag">Waiting</span>' : ''].join('');
  const vote = v.votable.has(c.id)
    ? `<button class="rm-vote" type="button" data-card="${esc(c.id)}" aria-pressed="${voted.has(c.id) ? 'true' : 'false'}" title="Vote for this"><span aria-hidden="true">♥</span> <b>${c.votes}</b></button>`
    : c.votes ? `<span class="rm-votes" title="Votes"><span aria-hidden="true">♥</span> ${c.votes}</span>` : '';
  return `<article class="rm-card" id="c-${esc(c.id)}">${tags ? `<div class="rm-tags">${tags}</div>` : ''}<h3>${esc(c.title)}</h3>${c.body ? `<p>${esc(c.body)}</p>` : ''}
<footer>${c.checks ? `<span class="rm-check">${c.checks.done}/${c.checks.total} steps done</span>` : '<span></span>'}${vote}</footer></article>`;
}
function boardHtml(v, voted) {
  const ms = v.milestones.length ? `<div class="rm-ms">${v.milestones.map(m => {
    const pct = m.progress ? Math.round(m.progress.done / m.progress.total * 100) : null;
    return `<div class="rm-m${m.status === 'done' ? ' done' : ''}" style="--c:${m.phase ? m.phase.color : '#f1eef2'}"><span class="rm-dia" aria-hidden="true"></span><div><b>${esc(m.title)}</b><em>${esc(when(m))}</em>${pct !== null ? `<span class="rm-bar" title="${pct}% of this phase done"><i style="width:${pct}%"></i></span>` : ''}</div></div>`;
  }).join('')}</div>` : '';
  const cols = v.columns.map(c => `<section class="rm-col rm-${c.key}"><h2>${esc(c.title)} <em>${c.cards.length + (c.more || 0)}</em></h2>${c.note ? `<p class="rm-note">${esc(c.note)}</p>` : ''}
${c.cards.map(x => cardHtml(x, v, voted)).join('\n') || '<p class="rm-empty">Nothing here yet.</p>'}${c.more ? `<p class="rm-more">…and ${c.more} more</p>` : ''}</section>`).join('\n');
  return `${ms}<div class="rm-cols" style="--n:${v.columns.length}">${cols}</div>`;
}

// the full page. o: { rm, name, view, voted, updatedAt, image, noindex }
function page(o) {
  const { rm, name, view: v } = o, path = pathOf(rm, name);
  const next = v.milestones.find(m => m.status !== 'done');
  const description = `What's planned, in progress and done for ${name}${next ? `, and what's next: ${next.title}` : ''}. Follow along and vote for what you want most.`;
  const body = `<section class="section rm-head"><div class="wrap">
  <span class="kicker">Public roadmap</span>
  <h1 class="page-h">${esc(name)}</h1>
  <p class="lead">${next ? `Next up: <b>${esc(next.title)}</b>${next.due && next.status !== 'done' ? `, ${esc(fmtDate(next.due))}` : ''}. ` : ''}Here's what the team is planning, working on and has finished. Vote for what you want most.</p>
  <p class="rm-meta">Updated ${esc(ago(o.updatedAt))} · <a href="/r/${esc(rm.token)}/feed.xml">Follow with RSS</a> · <button class="rm-link rm-copy" type="button">Copy link</button></p>
</div></section>
<div class="wrap rm-board" id="rm" data-id="${esc(rm.token)}">
${boardHtml(v, o.voted)}
<div class="rm-foot"><a class="rm-made" href="/?from=roadmap">Made with <b>VENOM<em>/</em>BOARD</b> · plan your game on one living board, free</a><button class="rm-link rm-report" type="button">Report this roadmap</button></div>
</div>`;
  return site.layout({ title: `${name} roadmap · Venom Board`, description, path, image: o.image, body, noindex: o.noindex, scripts: '\n<script src="/web/roadmap.js" defer></script>' });
}
// a compact copy for other sites to show in a frame
function embed(o) {
  const { rm, name, view: v } = o;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} roadmap</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700;800;900&family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap">
<link rel="stylesheet" href="/web/site.css">
<script src="/web/roadmap.js" defer></script>
</head>
<body class="rm-embed">
<div class="rm-board" id="rm" data-id="${esc(rm.token)}">
<div class="rm-ebar"><b>${esc(name)}</b><span>Roadmap</span><a href="${esc(site.base() + pathOf(rm, name))}" target="_blank" rel="noopener">Open ↗</a></div>
${boardHtml(v, o.voted)}
<a class="rm-made" href="${esc(site.base())}/?from=embed" target="_blank" rel="noopener">Made with <b>VENOM<em>/</em>BOARD</b></a>
</div>
</body>
</html>`;
}
// RSS (Atom): finished work and reached milestones. entries: [{ id, at, title, card }]
function feed(o) {
  const url = site.base() + pathOf(o.rm, o.name), iso = t => new Date(t).toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${esc(o.name)} roadmap</title>
<subtitle>What's done on the ${esc(o.name)} roadmap, made with Venom Board</subtitle>
<link href="${esc(url)}"/>
<link rel="self" href="${esc(site.base())}/r/${esc(o.rm.token)}/feed.xml"/>
<id>${esc(url)}</id>
<updated>${iso(o.updatedAt)}</updated>
<generator uri="${esc(site.base())}">Venom Board</generator>
${o.entries.map(e => `<entry><title>${esc(e.title)}</title><link href="${esc(url)}#c-${esc(e.card)}"/><id>${esc(url)}#activity-${e.id}</id><updated>${iso(e.at)}</updated><author><name>${esc(o.name)}</name></author></entry>`).join('\n')}
</feed>
`;
}

module.exports = { view, page, embed, feed, pathOf, slug };
