// MCP tools and the newer board features: tags, tracked time, linked pull requests and references on cards, sprints
// and collapsed phases, cropped and turned pictures, and comment threads with replies, feedback pins and resolving.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/index');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-mcpfields-'));
const mail = [];
let srv, base;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')  // a real 1x1 PNG (uploads are rebuilt, so broken ones are refused)

async function api(method, p, body, token) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
const linkToken = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
});
test.after(() => srv.close());

test('MCP tools read and set the newer card, phase, picture and comment features', async () => {
  const signup = async u => {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    await api('POST', '/api/auth/verify', { token: linkToken(u + '@studio.test', 'verify') });
    return r.data;
  };
  const lead = await signup('leadmcp'), mate = await signup('matemcp');
  const token = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, lead.token)).data.token;
  const mateTok = (await api('POST', '/api/me/tokens', { name: 'Laptop', password: 'correct horse' }, mate.token)).data.token;
  const call = async (tok, name, args) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const ok = async (name, args, tok = token) => { const r = await call(tok, name, args); assert.ok(!r.isError, `${name}: ${r.isError && r.content[0].text}`); return r.structuredContent; };
  const fails = async (name, args, re, tok = token) => { const r = await call(tok, name, args); assert.equal(r.isError, true, name + ' should fail'); assert.match(r.content[0].text, re); };

  const team = (await api('POST', '/api/teams', { name: 'Fields Studio' }, lead.token)).data.team.id;
  await api('POST', `/api/teams/${team}/invites`, { who: 'matemcp', role: 'editor' }, lead.token);
  const inv = (await api('GET', '/api/me', undefined, mate.token)).data.invites.find(i => i.team.id === team).id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, mate.token);
  const proj = (await ok('create_project', { team_id: team, name: 'Fields' })).project_id;

  // cards: tags, tracked time, linked pull requests and a reference
  const phase = (await ok('add_phase', { project_id: proj, title: 'Sprint 1' })).phase_id;
  const card = (await ok('add_cards', { project_id: proj, phase_id: phase, cards: [{ title: 'Boss fight', tags: ['Boss Fight', 'ui'], tracked_minutes: 150, git_links: ['https://github.com/studio/game/pull/12'] }] })).added[0].id;
  await fails('update_cards', { project_id: proj, updates: [{ card_id: card, tags: ['no spaces?!'] }] }, /Tags are/);
  await fails('update_cards', { project_id: proj, updates: [{ card_id: card, git_links: ['https://example.com/pr/1'] }] }, /github\.com or gitlab\.com/);
  const c = (await ok('get_items', { project_id: proj, types: ['card'] })).items[0];
  assert.deepEqual([c.tags, c.tracked, c.tracked_minutes, c.git_links], [['boss-fight', 'ui'], '2.5h', 150, ['https://github.com/studio/game/pull/12']]);
  assert.match(c.reference, /^VB-[0-9A-Z]{8,12}$/);

  // phases: a sprint with capacity by username, collapsed
  await ok('update_items', { project_id: proj, updates: [{ id: phase, sprint: { start: '2030-03-04', end: '2030-03-15', capacity_days: { matemcp: 8, everyone: 20 } }, collapsed: true }] });
  const board = await ok('get_board', { project_id: proj });
  assert.deepEqual(board.phases[0].sprint, { start: '2030-03-04', end: '2030-03-15', capacity_days: { Matemcp: 8, everyone: 20 } });
  assert.equal(board.phases[0].collapsed, true);
  assert.equal(board.phases[0].cards[0].reference, c.reference);
  assert.deepEqual(board.phases[0].cards[0].tags, ['boss-fight', 'ui']);
  await fails('update_items', { project_id: proj, updates: [{ id: phase, sprint: { start: '2030-03-15', end: '2030-03-01' } }] }, /end not before the start/);
  await ok('update_items', { project_id: proj, updates: [{ id: phase, sprint: null, collapsed: false }] });
  const plain = (await ok('get_items', { project_id: proj, types: ['frame'] })).items[0];
  assert.equal(plain.sprint, undefined); assert.equal(plain.collapsed, undefined);

  // pictures: a crop and a quarter turn keep the centre and the scale
  const wide = Buffer.from(PNG); wide.writeUInt32BE(800, 16); wide.writeUInt32BE(400, 20);
  const pic = (await ok('add_image', { project_id: proj, images: [{ data: wide.toString('base64'), width: 400, x: 1000, y: 0 }] })).added[0];
  await ok('update_items', { project_id: proj, updates: [{ id: pic.id, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, rotate: 90 }] });
  const turned = (await ok('get_items', { project_id: proj, ids: [pic.id] })).items[0];
  assert.deepEqual([turned.crop, turned.rotate, turned.w, turned.h], [{ x: 0.5, y: 0, w: 0.5, h: 1 }, 90, 200, 200]);
  assert.deepEqual([turned.x + turned.w / 2, turned.y + turned.h / 2], [pic.x + pic.w / 2, pic.y + pic.h / 2], 'the centre stays');
  await ok('update_items', { project_id: proj, updates: [{ id: pic.id, crop: null, rotate: 0 }] });
  const back = (await ok('get_items', { project_id: proj, ids: [pic.id] })).items[0];
  assert.deepEqual([back.crop, back.rotate, back.w, back.h], [undefined, undefined, 400, 200], 'undone exactly');
  await fails('update_items', { project_id: proj, updates: [{ id: pic.id, crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }] }, /inside 0\.\.1/);
  // replacing a turned picture keeps the turn (the crop belonged to the old picture), like the app
  await ok('update_items', { project_id: proj, updates: [{ id: pic.id, rotate: 90 }] });
  const swapped = await ok('replace_media', { project_id: proj, id: pic.id, data: wide.toString('base64') });
  const after = (await ok('get_items', { project_id: proj, ids: [swapped.id] })).items[0];
  assert.deepEqual([after.rotate, after.w, after.h], [90, 200, 400], 'still turned, in the new picture\'s turned shape');
  await ok('update_items', { project_id: proj, updates: [{ id: pic.id, rotate: 0 }] });

  // comments: a feedback pin on the picture, a reply, resolving by the author, not by someone else
  const pin = await ok('add_comment', { project_id: proj, card_id: pic.id, text: 'Silhouette reads badly here', pin: { x: 0.25, y: 0.6 } });
  const reply = await ok('add_comment', { project_id: proj, card_id: pic.id, text: 'Agreed, darker rim light', reply_to: pin.comment_id }, mateTok);
  assert.equal(reply.reply_to, pin.comment_id);
  await fails('add_comment', { project_id: proj, card_id: card, text: 'x', pin: { x: 0.5, y: 0.5 } }, /pictures/);
  const thread = (await ok('get_comments', { project_id: proj, card_id: pic.id })).comments;
  assert.deepEqual(thread.map(m => [m.text, m.pin || null, m.reply_to || null]), [['Silhouette reads badly here', { x: 0.25, y: 0.6 }, null], ['Agreed, darker rim light', null, pin.comment_id]]);
  await fails('resolve_thread', { project_id: proj, comment_id: pin.comment_id }, /started the thread or a team admin/, mateTok);
  await fails('resolve_thread', { project_id: proj, comment_id: reply.comment_id }, /is a reply/);
  assert.equal((await ok('resolve_thread', { project_id: proj, comment_id: pin.comment_id })).changed, true);
  const resolved = (await ok('get_comments', { project_id: proj, card_id: pic.id })).comments[0];
  assert.equal(resolved.resolved_by, 'Leadmcp');
  assert.equal((await ok('resolve_thread', { project_id: proj, comment_id: pin.comment_id, resolved: false })).changed, true);
  assert.equal((await ok('get_comments', { project_id: proj, card_id: pic.id })).comments[0].resolved, undefined, 'reopened');
});

test('MCP schedule: a start date holds a card back, and an arrow between phases makes the second wait on the first', async () => {
  const signup = async u => {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    await api('POST', '/api/auth/verify', { token: linkToken(u + '@studio.test', 'verify') });
    return r.data;
  };
  const lead = await signup('leadsched');
  const token = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, lead.token)).data.token;
  const call = async (tok, name, args) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const ok = async (name, args, tok = token) => { const r = await call(tok, name, args); assert.ok(!r.isError, `${name}: ${r.isError && r.content[0].text}`); return r.structuredContent; };
  const fails = async (name, args, re, tok = token) => { const r = await call(tok, name, args); assert.equal(r.isError, true, name + ' should fail'); assert.match(r.content[0].text, re); };

  const team = (await api('POST', '/api/teams', { name: 'Schedule Studio' }, lead.token)).data.team.id;
  const proj = (await ok('create_project', { team_id: team, name: 'Schedule' })).project_id;
  const p1 = (await ok('add_phase', { project_id: proj, title: 'Prototype' })).phase_id;
  const p2 = (await ok('add_phase', { project_id: proj, title: 'Production' })).phase_id;
  const a = (await ok('add_cards', { project_id: proj, phase_id: p1, cards: [{ title: 'Combat', estimate: '3d' }] })).added[0].id;
  await ok('add_cards', { project_id: proj, phase_id: p2, cards: [{ title: 'Boss fight', estimate: '2d' }] });
  const row = (s, t) => s.tasks.find(x => x.title === t);
  let s = await ok('get_schedule', { project_id: proj });
  assert.equal(row(s, 'Boss fight').start, row(s, 'Combat').start, 'unconnected, both start today');
  // an arrow from one phase to the next: everything in the second waits on the first
  await ok('add_connectors', { project_id: proj, connectors: [{ from: p1, to: p2 }] });
  s = await ok('get_schedule', { project_id: proj });
  assert.ok(row(s, 'Boss fight').start > row(s, 'Combat').finish, 'Boss fight waits for Combat: ' + JSON.stringify(s.tasks));
  assert.deepEqual(s.critical_path, ['Combat', 'Boss fight']);
  // a start date holds Combat back, and what waits on it moves too; clearing it brings it back
  const later = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  await fails('update_cards', { project_id: proj, updates: [{ card_id: a, starts: 'next week' }] }, /Start dates look like/);
  await ok('update_cards', { project_id: proj, updates: [{ card_id: a, starts: later }] });
  assert.equal((await ok('get_items', { project_id: proj, types: ['card'] })).items.find(i => i.id === a).starts, later);
  s = await ok('get_schedule', { project_id: proj });
  assert.ok(row(s, 'Combat').start >= later, 'Combat doesn’t start before ' + later + ': ' + row(s, 'Combat').start);
  assert.ok(row(s, 'Boss fight').start > row(s, 'Combat').finish, 'and Boss fight still waits for it');
  await ok('update_cards', { project_id: proj, updates: [{ card_id: a, starts: '' }] });
  s = await ok('get_schedule', { project_id: proj });
  assert.ok(row(s, 'Combat').start < later, 'an empty start date clears it');
  assert.ok(!(await ok('get_items', { project_id: proj, types: ['card'] })).items.find(i => i.id === a).starts);
});
