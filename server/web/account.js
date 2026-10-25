// venomboard.com/account: sign up, sign in, password reset, email confirmation and the team dashboard.
const SUPPORT = document.body ? (document.body.dataset.support || '') : '';  // who to write to when an email doesn't come
// It talks to the same API as the app, signed in with the site's httpOnly session cookie.
// Everything people type is shown with textContent, never parsed as HTML.
'use strict';
(() => {
  const ROLE = { leader: 'Team leader', admin: 'Team admin', editor: 'Editor', viewer: 'Viewer' };
  const RANK = { viewer: 0, editor: 1, admin: 2, leader: 3 };
  // same rules as the server: leaders grant admin and below, admins grant editor and viewer
  const grantable = actor => (actor === 'leader' ? ['admin', 'editor', 'viewer'] : actor === 'admin' ? ['editor', 'viewer'] : []);
  const canManage = (actor, target) => (actor === 'leader' ? target !== 'leader' : actor === 'admin' ? RANK[target] < RANK.admin : false);

  const view = document.getElementById('view');
  const S = { me: null, teams: [], invites: [], teamId: '', detail: null };
  try { S.teamId = localStorage.getItem('vb-site-team') || ''; } catch (e) {}

  /* ---------- helpers ---------- */
  function h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'css') for (const [p, val] of Object.entries(v)) e.style.setProperty(p, val);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }
  const ICONS = {
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  const iconBtn = (name, label, onclick) => {
    const b = h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick });
    b.innerHTML = ICONS[name];  // static markup only
    return b;
  };
  const safeColor = c => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#5f5c6c');
  const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const avatar = (name, color) => h('span', { class: 'av', css: { '--c': safeColor(color) }, 'aria-hidden': 'true' }, initials(name));
  const roleChip = r => h('span', { class: 'chip ' + r }, ROLE[r] || r);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  async function api(path, method = 'GET', body) {
    const headers = { 'X-VB': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Error('Can’t reach the server. Check your connection and try again.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `The server answered ${r.status}.`), { status: r.status, code: data.code });
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), bad ? 5200 : 3600);
  }

  function show(...nodes) { view.replaceChildren(...nodes.flat().filter(Boolean)); }
  const setHash = hash => history.replaceState(null, '', location.pathname + hash);

  // A form whose inputs are collected into an object for the submit handler. Errors show under the fields.
  function form(fields, submitLabel, onSubmit, opts = {}) {
    const inputs = {};
    const err = h('p', { class: 'err', role: 'alert' });
    const btn = h('button', { class: 'btn red ' + (opts.small ? 'small' : 'big'), type: 'submit' }, submitLabel);
    const rows = fields.map(f => {
      const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
      inputs[f.name] = h('input', { class: 'input' + (opts.small ? ' sm' : ''), id, name: f.name, type: f.type || 'text', autocomplete: f.autocomplete || 'off',
        required: !f.optional, value: f.value, maxlength: f.max, placeholder: f.placeholder, autofocus: f.autofocus });
      return h('div', { class: 'field' }, h('label', { for: id }, f.label), inputs[f.name]);
    });
    const el = h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try { await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])), inputs); }
      catch (x) { err.textContent = x.message; }
      finally { btn.disabled = false; }
    } }, rows, err, btn);
    return el;
  }
  const authShell = (title, sub, ...kids) => h('div', { class: 'auth' }, h('h1', {}, title), h('p', { class: 'sub' }, sub), kids);

  /* ---------- data ---------- */
  async function loadMe() {
    // ask who's signed in first, so a signed-out visitor never gets an error response
    const s = await api('/api/session');
    if (!s.user) { S.me = null; return; }
    try {
      const me = await api('/api/me');
      S.me = me.user; S.teams = me.teams; S.invites = me.invites; S.sessionsOthers = me.sessions ? me.sessions.others : 0;
      S.security = me.security || null; S.notify = me.notify || null;
    } catch (e) {
      if (e.status !== 401) throw e;
      S.me = null;
    }
  }
  async function loadTeam() {
    if (!S.teams.some(t => t.id === S.teamId)) S.teamId = S.teams[0] ? S.teams[0].id : '';
    try { localStorage.setItem('vb-site-team', S.teamId); } catch (e) {}
    S.detail = S.teamId ? await api('/api/teams/' + S.teamId).catch(() => null) : null;
  }
  async function refresh() {
    await loadMe();
    if (!S.me) return signInView('Your session ended. Sign in again.');
    await loadTeam();
    renderDash();
  }
  // run an action from the dashboard, report how it went, then redraw with fresh data
  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
    await refresh().catch(e => toast(e.message, true));
  }

  /* ---------- signed-out views ---------- */
  function signInView(msg) {
    document.title = 'Sign in · Venom Board';
    show(authShell('Welcome back.', 'Sign in to manage your teams, invites and shared projects.',
      msg ? h('p', { class: 'ok-msg' }, msg) : null,
      form([
        { name: 'login', label: 'Email or username', autocomplete: 'username', max: 254, autofocus: true },
        { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', max: 200 },
      ], 'Sign in', async v => {
        const r = await api('/api/auth/login', 'POST', { login: v.login.trim(), password: v.password, web: true });
        if (r.twoFactor) { codeView(r.ticket); return; }
        setHash('');
        await openDashboard();
      }),
      h('div', { class: 'alt' },
        h('span', {}, 'New here? ', h('a', { class: 'link', href: '#signup' }, 'Create a free account')),
        h('a', { class: 'link muted', href: '#forgot' }, 'Forgot password?'))));
  }

  // the second step of signing in, for accounts with two-step sign-in on
  function codeView(ticket) {
    document.title = 'Two-step sign-in · Venom Board';
    show(authShell('One more step.', 'Type the 6-digit code from your authenticator app, or one of your recovery codes.',
      form([{ name: 'code', label: 'Code', autocomplete: 'one-time-code', max: 12, autofocus: true }], 'Sign in', async v => {
        try { await api('/api/auth/2fa', 'POST', { ticket, code: v.code.trim() }); }
        catch (e) { if (e.code === 'expired' || e.status === 429) setTimeout(() => signInView(e.message), 1500); throw e; }
        setHash('');
        await openDashboard();
      }),
      h('div', { class: 'alt' }, h('a', { class: 'link muted', href: '#signin', onclick: () => signInView() }, 'Start again'))));
  }

  function signUpView() {
    document.title = 'Create an account · Venom Board';
    show(authShell('Join Venom Board.', 'One free account works on this site, in the web app and in the desktop app.',
      form([
        { name: 'email', label: 'Email', type: 'email', autocomplete: 'email', max: 254, autofocus: true },
        { name: 'username', label: 'Username', autocomplete: 'username', max: 24, placeholder: 'letters, numbers or _' },
        { name: 'displayName', label: 'Display name (what your team sees)', autocomplete: 'nickname', max: 40, optional: true },
        { name: 'password', label: 'Password (8+ characters)', type: 'password', autocomplete: 'new-password', max: 200 },
      ], 'Create account', async v => {
        if (v.password.length < 8) throw new Error('Use at least 8 characters for your password.');
        await api('/api/auth/signup', 'POST', { email: v.email.trim(), username: v.username.trim(), displayName: v.displayName.trim(), password: v.password, web: true });
        setHash('');
        await openDashboard();
        toast('Account created. Check your inbox to confirm your email.');
      }),
      h('p', { class: 'fine-print' }, 'By creating an account you agree to the ', h('a', { class: 'link', href: '/terms', target: '_blank', rel: 'noopener' }, 'terms of use'),
        ' and the ', h('a', { class: 'link', href: '/privacy', target: '_blank', rel: 'noopener' }, 'privacy policy'), '.'),
      h('div', { class: 'alt' }, h('span', {}, 'Already have an account? ', h('a', { class: 'link', href: '#signin' }, 'Sign in')))));
  }

  function forgotView() {
    document.title = 'Reset your password · Venom Board';
    const done = h('p', { class: 'ok-msg', hidden: true });
    show(authShell('Forgot your password?', 'Enter your account email and we’ll send you a link to choose a new one.',
      done,
      form([{ name: 'email', label: 'Email', type: 'email', autocomplete: 'email', max: 254, autofocus: true }], 'Send reset link', async v => {
        await api('/api/auth/forgot', 'POST', { email: v.email.trim() });
        done.textContent = 'If an account uses that email, a reset link is on its way. Links work for 24 hours, and earlier ones keep working, so any recent email from us will do.';
        done.hidden = false;
      }),
      h('div', { class: 'alt' }, h('a', { class: 'link', href: '#signin' }, 'Back to sign in'),
        SUPPORT ? h('span', {}, 'No email? ', h('a', { class: 'link muted', href: 'mailto:' + SUPPORT }, SUPPORT)) : null)));
  }

  function resetView(token) {
    document.title = 'Choose a new password · Venom Board';
    show(authShell('Choose a new password.', 'Saving it signs you out on every device. Then sign in with the new password.',
      form([
        { name: 'password', label: 'New password (8+ characters)', type: 'password', autocomplete: 'new-password', max: 200, autofocus: true },
        { name: 'confirm', label: 'Type it again', type: 'password', autocomplete: 'new-password', max: 200 },
      ], 'Save new password', async v => {
        if (v.password.length < 8) throw new Error('Use at least 8 characters.');
        if (v.password !== v.confirm) throw new Error('The two passwords don’t match.');
        await api('/api/auth/reset', 'POST', { token, password: v.password });
        setHash('#signin');
        S.me = null;
        signInView('Password changed. Sign in with your new password.');
      })));
  }

  async function verifyEmail(token) {
    setHash('');
    show(h('div', { class: 'center' }, 'Confirming your email…'));
    let msg = 'Email confirmed. Team invites sent to it will now reach you.', bad = false;
    try { await api('/api/auth/verify', 'POST', { token }); }
    catch (e) { msg = e.message; bad = true; }
    await loadMe();
    if (S.me) { await openDashboard(); toast(msg, bad); }
    else if (bad) { signInView(); toast(msg, true); }
    else signInView(msg + ' Sign in to see them.');
  }

  /* ---------- dashboard ---------- */
  async function openDashboard() {
    if (!S.me) await loadMe();
    if (!S.me) return signInView();
    await loadTeam();
    renderDash();
  }

  function renderDash() {
    document.title = 'Your teams · Venom Board';
    const u = S.me;
    show(h('div', { class: 'dash' },
      h('aside', { class: 'side' }, profilePanel(u), S.invites.length ? invitesPanel() : null, teamsPanel()),
      h('div', { class: 'main' }, u.emailVerified ? null : verifyBanner(u), S.detail ? teamMain(S.detail) : startPanel())));
  }

  function verifyBanner(u) {
    return h('div', { class: 'banner' },
      h('p', {}, h('b', {}, 'Confirm your email. '), `We sent a link to ${u.email}. Invites sent to your email address reach you once it’s confirmed.`),
      h('button', { class: 'btn small', type: 'button', onclick: () => act(() => api('/api/auth/verify/resend', 'POST', {}), 'Sent. Check your inbox and spam folder.') }, 'Send it again'));
  }

  function profilePanel(u) {
    const nameForm = form([{ name: 'displayName', label: 'Display name', value: u.displayName, max: 40 }], 'Save name',
      v => act(() => api('/api/me', 'PATCH', { displayName: v.displayName.trim() }), 'Name saved.'), { small: true });
    const passForm = form([
      { name: 'currentPassword', label: 'Current password', type: 'password', autocomplete: 'current-password', max: 200 },
      { name: 'newPassword', label: 'New password (8+ characters)', type: 'password', autocomplete: 'new-password', max: 200 },
    ], 'Change password', async (v, inputs) => {
      if (v.newPassword.length < 8) throw new Error('Use at least 8 characters for your new password.');
      await api('/api/me', 'PATCH', v);
      inputs.currentPassword.value = ''; inputs.newPassword.value = '';
      toast('Password changed.');
    }, { small: true });
    return h('section', { class: 'panel' },
      h('div', { class: 'me' }, avatar(u.displayName, u.color), h('div', {}, h('b', {}, u.displayName), h('span', {}, '@' + u.username), h('span', {}, u.email))),
      h('div', { class: 'inline', css: { 'margin-top': '16px' } },
        h('a', { class: 'btn small red', href: '/app' }, 'Open web app'),
        h('button', { class: 'btn small', type: 'button', onclick: signOut }, 'Sign out')),
      h('details', { class: 'more', css: { 'margin-top': '16px' } }, h('summary', {}, 'Profile and password'), nameForm, h('div', { css: { height: '6px' } }), passForm),
      h('details', { class: 'more', css: { 'margin-top': '12px' } }, h('summary', {}, 'Two-step sign-in'), twoStepPanel()),
      h('details', { class: 'more', css: { 'margin-top': '12px' } }, h('summary', {}, 'Email notifications'), notifyPanel()),
      h('details', { class: 'more', id: 'mcp', open: location.hash === '#mcp', css: { 'margin-top': '12px' } }, h('summary', {}, 'Connect tools (MCP)'), mcpPanel()),
      h('details', { class: 'more', id: 'calendar', open: location.hash === '#calendar', css: { 'margin-top': '12px' } }, h('summary', {}, 'Calendar feed'), calendarPanel()),
      accountDetails());
  }

  // Two-step sign-in: a code from an authenticator app as well as the password. Setup scans a QR code, checks one
  // code, then shows ten one-time recovery codes once.
  function twoStepPanel() {
    const box = h('div', { css: { 'margin-top': '10px' } });
    let state = null;
    const pass = { name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', max: 200 };
    const draw = () => {
      const sec = S.security || { twoFactor: false, recoveryLeft: 0 };
      if (state && state.step === 'setup') {
        const canvas = h('canvas', { css: { width: '180px', height: '180px', 'border-radius': '10px', 'image-rendering': 'pixelated', 'margin-top': '10px' }, 'aria-label': 'QR code for your authenticator app' });
        if (window.VBQR) window.VBQR.draw(canvas, state.uri, 5);
        box.replaceChildren(
          h('p', { class: 'hint' }, 'Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), then type the code it shows.'),
          canvas,
          h('p', { class: 'hint' }, 'Can’t scan it? Enter this key: ', h('code', { css: { 'user-select': 'all', 'overflow-wrap': 'anywhere' } }, state.secret.replace(/(.{4})/g, '$1 ').trim())),
          form([{ name: 'code', label: 'Code from the app', autocomplete: 'one-time-code', max: 7 }], 'Turn on', async v => {
            const r = await api('/api/me/2fa/enable', 'POST', { code: v.code.trim() });
            state = { step: 'codes', codes: r.recoveryCodes }; S.security = { twoFactor: true, recoveryLeft: r.recoveryCodes.length }; draw();
          }, { small: true }));
      } else if (state && state.step === 'codes') {
        box.replaceChildren(
          h('p', { class: 'hint' }, 'Keep these recovery codes somewhere safe, like a password manager. Each one signs you in once if you lose your phone. They won’t be shown again.'),
          h('pre', { css: { 'font-family': 'JetBrains Mono, monospace', 'font-size': '14px', 'line-height': '1.7', padding: '12px 16px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', 'border-radius': '10px', 'user-select': 'all' } }, state.codes.join('\n')),
          h('button', { class: 'btn small red', type: 'button', onclick: () => { state = null; refresh().catch(() => {}); } }, 'I’ve saved them'));
      } else if (sec.twoFactor) {
        box.replaceChildren(
          h('p', { class: 'hint' }, `On. Signing in takes your password and a code from your app. ${plural(sec.recoveryLeft, 'recovery code')} left.`),
          form([pass, { name: 'code', label: 'Code from your app (or a recovery code)', autocomplete: 'one-time-code', max: 12 }], 'New recovery codes', async v => { const r = await api('/api/me/2fa/recovery', 'POST', { password: v.password, code: v.code.trim() }); state = { step: 'codes', codes: r.recoveryCodes }; draw(); }, { small: true }),
          h('div', { css: { height: '8px' } }),
          form([pass, { name: 'code', label: 'Code from your app (or a recovery code)', autocomplete: 'one-time-code', max: 12 }], 'Turn off', async v => {
            await api('/api/me/2fa/disable', 'POST', v); toast('Two-step sign-in is off.'); await refresh();
          }, { small: true }));
      } else {
        box.replaceChildren(
          h('p', { class: 'hint' }, 'Off. Turn it on so a leaked password alone can’t get into your account.'),
          form([pass], 'Turn on', async v => { const r = await api('/api/me/2fa/setup', 'POST', v); state = { step: 'setup', secret: r.secret, uri: r.uri }; draw(); }, { small: true }));
      }
    };
    draw();
    return box;
  }

  // Access tokens for tools that support the Model Context Protocol: assistants and planning tools that read your
  // team boards and map out work on them. A token acts as you, with your role in each team, and is shown once.
  function mcpPanel() {
    const box = h('div', { css: { 'margin-top': '10px' } });
    let fresh = null;
    const mono = { 'font-family': 'JetBrains Mono, monospace', 'font-size': '12.5px', 'overflow-wrap': 'anywhere', 'user-select': 'all' };
    const copyBtn = text => h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast('Select it and copy it yourself.', true)) }, 'Copy');
    const draw = async () => {
      let data = { tokens: [], endpoint: location.origin + '/mcp' };
      try { data = await api('/api/me/tokens'); } catch (e) { /* shown as no tokens */ }
      const ago = t => { if (!t) return 'never used'; const d = Math.floor((Date.now() - t) / 86400000); return 'used ' + (d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'); };
      const config = fresh && JSON.stringify({ mcpServers: { 'venom-board': { type: 'http', url: data.endpoint, headers: { Authorization: 'Bearer ' + fresh.token } } } }, null, 2);
      box.replaceChildren(
        h('p', { class: 'hint' }, 'Let tools that support the Model Context Protocol (MCP) work on your team boards the way you do: plan with phases, cards, dependencies and the schedule, and lay out text, frames, pictures, GIFs, videos, ink, connectors and templates. A token acts as you, with your role in each team. What it changes shows up live for your team, and every board stays in version history. Inviting people, sharing, publishing and deleting projects stay in the app.'),
        h('p', { class: 'hint' }, 'Server address: ', h('code', { css: mono }, data.endpoint)),
        fresh ? h('div', { css: { 'margin-top': '12px', padding: '12px 14px', border: '1px solid var(--line-2)', 'border-radius': '10px', background: 'rgba(255,255,255,.03)' } },
          h('p', { class: 'hint', css: { 'margin-top': '0' } }, h('b', {}, 'Your new token. '), 'Copy it now: it won’t be shown again.'),
          h('div', { class: 'inline', css: { 'margin-top': '8px', 'align-items': 'center' } }, h('code', { css: { ...mono, flex: '1' } }, fresh.token), copyBtn(fresh.token)),
          h('p', { class: 'hint' }, 'Most tools take a server entry like this in their MCP settings:'),
          h('pre', { css: { ...mono, 'font-size': '11.5px', 'overflow-wrap': 'normal', 'white-space': 'pre', 'overflow-x': 'auto', padding: '10px 12px', background: 'rgba(0,0,0,.25)', 'border-radius': '8px', margin: '6px 0 0' } }, config),
          h('div', { class: 'inline', css: { 'margin-top': '8px' } }, copyBtn(config)),
          h('p', { class: 'hint' }, 'A tool that only runs local servers can reach it through the mcp-remote bridge: ',
            h('code', { css: mono }, `npx mcp-remote ${data.endpoint} --header "Authorization: Bearer ${fresh.token}"`))) : '',
        data.tokens.length ? h('div', { class: 'rows', css: { 'margin-top': '12px' } }, data.tokens.map(t => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('b', {}, t.name), h('span', {}, `Made ${new Date(t.createdAt).toLocaleDateString()} · ${ago(t.lastUsed)}`)),
          h('button', { class: 'btn small', type: 'button', onclick: async () => {
            if (!confirm(`Revoke “${t.name}”? Tools using it stop working straight away.`)) return;
            try { await api('/api/me/tokens/' + encodeURIComponent(t.id), 'DELETE'); if (fresh && fresh.id === t.id) fresh = null; toast('Token revoked.'); draw(); } catch (e) { toast(e.message, true); }
          } }, 'Revoke')))) : h('p', { class: 'hint' }, 'No tokens yet.'),
        h('div', { css: { height: '10px' } }),
        form([{ name: 'name', label: 'Name it, e.g. “My laptop”', max: 60 }, { name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', max: 200 }], 'Create a token', async v => {
          fresh = await api('/api/me/tokens', 'POST', { name: v.name.trim(), password: v.password });
          draw();
        }, { small: true }),
        h('p', { class: 'hint' }, 'Changing your password or signing out everywhere else revokes every token.'));
    };
    draw();
    return box;
  }

  // A private address calendar apps subscribe to: cards assigned to you that have a due date, and your teams'
  // milestones, as all-day events that link back to the card. It can be replaced or turned off at any time.
  function calendarPanel() {
    const box = h('div', { css: { 'margin-top': '10px' } });
    const mono = { 'font-family': 'JetBrains Mono, monospace', 'font-size': '12px', 'word-break': 'break-all', 'user-select': 'all' };
    const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); } draw(); };
    const draw = async () => {
      let feed = null;
      try { feed = (await api('/api/me/calendar')).feed; } catch (e) { /* shown as off */ }
      const lead = h('p', { class: 'hint' }, 'Subscribe in Google Calendar, Outlook or Apple Calendar to see the cards assigned to you that have a due date, and your teams’ milestones, as all-day events that link back to each card. Calendar apps check for changes every few hours.');
      if (!feed) {
        box.replaceChildren(lead, h('p', { class: 'hint' }, 'Off.'),
          h('button', { class: 'btn small red', type: 'button', css: { 'margin-top': '10px' }, onclick: () => run(() => api('/api/me/calendar', 'POST', {}), 'Calendar feed on.') }, 'Turn on'));
        return;
      }
      const used = feed.lastUsed ? `A calendar app last read it ${ago(feed.lastUsed)}.` : 'No calendar app has read it yet.';
      box.replaceChildren(lead,
        h('div', { class: 'inline', css: { 'margin-top': '10px', 'align-items': 'center' } }, h('code', { css: { ...mono, flex: '1' } }, feed.url),
          h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(feed.url).then(() => toast('Copied.'), () => toast('Select it and copy it yourself.', true)) }, 'Copy')),
        h('div', { class: 'inline', css: { 'margin-top': '10px' } }, h('a', { class: 'btn small red', href: feed.webcal }, 'Open in my calendar app')),
        h('p', { class: 'hint' }, 'Google Calendar: under Other calendars choose + then From URL, and paste the address. ' + used),
        h('p', { class: 'hint' }, 'Anyone with this address can see those cards’ titles and dates, so keep it to yourself. If it gets out, make a new one and the old one stops working. Changing your password, turning on two-step sign-in or signing out everywhere else turns the feed off.'),
        h('div', { class: 'inline', css: { 'margin-top': '10px' } },
          h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Make a new address? The old one stops working, so calendars subscribed to it stop updating.')) run(() => api('/api/me/calendar', 'POST', {}), 'New address made. Subscribe to it again in your calendar app.'); } }, 'Make a new address'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Turn the calendar feed off? Calendars subscribed to it stop updating.')) run(() => api('/api/me/calendar', 'DELETE'), 'Calendar feed off.'); } }, 'Turn off')));
    };
    draw();
    if (location.hash === '#calendar' && !calendarPanel.shown) {  // opened from the app's settings: bring it into view once
      calendarPanel.shown = true;
      setTimeout(() => { const d = box.closest('details'); if (d) d.scrollIntoView({ block: 'center' }); }, 0);
    }
    return box;
  }

  function notifyPanel() {
    const n = S.notify || { mentions: true, due: true };
    const box = (key, field, label) => {
      const c = h('input', { type: 'checkbox', checked: !!n[field], css: { 'accent-color': '#ff2a4f', margin: '0' } });
      c.addEventListener('change', () => act(() => api('/api/me', 'PATCH', { [key]: c.checked }), c.checked ? 'Emails on.' : 'Emails off.'));
      return h('label', { css: { display: 'flex', gap: '10px', 'align-items': 'center', 'margin-top': '10px', cursor: 'pointer', color: 'var(--bone-dim)', 'font-size': '14px' } }, c, label);
    };
    return h('div', {},
      box('notifyMentions', 'mentions', 'Email me when someone mentions me in a comment'),
      box('notifyDue', 'due', 'Email me in the morning about my tasks due soon'),
      h('p', { class: 'hint' }, 'Mentions and assignments always show in the app’s notifications too.'));
  }

  // ending other sign-ins, and deleting the account (a team with other people in it is never deleted from under them)
  function accountDetails() {
    const others = S.sessionsOthers || 0, shared = S.teams.filter(t => t.role === 'leader' && t.members > 1), one = shared.length === 1;
    const tfa = !!(S.security && S.security.twoFactor);
    const delForm = form([{ name: 'password', label: 'Your password, to confirm', type: 'password', autocomplete: 'current-password', max: 200 },
      ...(tfa ? [{ name: 'code', label: 'Code from your authenticator app', autocomplete: 'one-time-code', max: 12 }] : [])], 'Delete my account', async v => {
      if (!confirm('Delete your Venom Board account for good? Teams only you are in go with it, along with their projects. This can’t be undone.')) return;
      await api('/api/me', 'DELETE', { password: v.password, code: v.code });
      S.me = null; S.detail = null;
      setHash('#signin');
      signInView('Your account was deleted.');
    }, { small: true });
    delForm.querySelector('button[type=submit]').className = 'btn small danger';
    return h('details', { class: 'more', css: { 'margin-top': '12px' } }, h('summary', {}, 'Sign-ins and account'),
      h('p', { class: 'hint' }, others ? `Signed in on ${plural(others, 'other device')} or browser${others === 1 ? '' : 's'}.` : 'You’re only signed in here.'),
      h('button', { class: 'btn small', type: 'button', disabled: !others, css: { 'margin-top': '10px' },
        onclick: () => act(() => api('/api/me/sign-out-others', 'POST', {}), 'Every other sign-in has ended.') }, 'Sign out everywhere else'),
      h('p', { class: 'hint', css: { 'margin-top': '20px' } }, 'Deleting your account removes it, your sign-ins and your place in every team. Teams only you are in are deleted with their projects.'),
      shared.length
        ? h('p', { class: 'err', css: { 'margin-top': '10px' } }, `You lead ${shared.map(t => '“' + t.name + '”').join(', ')}, which other people are in. Hand ${one ? 'it' : 'them'} over or delete ${one ? 'it' : 'them'} first.`)
        : delForm);
  }

  async function signOut() {
    try { await api('/api/auth/logout', 'POST'); } catch (e) {}
    S.me = null; S.detail = null;
    setHash('#signin');
    signInView('You’re signed out.');
  }

  function invitesPanel() {
    return h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h3', {}, 'Invitations')),
      h('div', { class: 'rows' }, S.invites.map(i => h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('b', {}, i.team.name), h('span', {}, `${i.from ? i.from + ' invited you' : 'Invited'} as ${(ROLE[i.role] || i.role).toLowerCase()}`)),
        h('button', { class: 'btn small red', type: 'button', onclick: () => act(async () => { const r = await api(`/api/invites/${encodeURIComponent(i.id)}/accept`, 'POST'); S.teamId = r.team.id; }, `You joined ${i.team.name}.`) }, 'Accept'),
        h('button', { class: 'btn small', type: 'button', onclick: () => act(() => api(`/api/invites/${encodeURIComponent(i.id)}/decline`, 'POST'), 'Invite declined.') }, 'Decline')))));
  }

  async function selectTeam(id) {
    S.teamId = id;
    try { await loadTeam(); } catch (e) { toast(e.message, true); }
    renderDash();
  }

  function teamsPanel() {
    const name = h('input', { class: 'input sm', placeholder: 'New team name', maxlength: 60, 'aria-label': 'New team name' });
    const create = h('form', { class: 'inline', css: { 'margin-top': '14px' }, onsubmit: e => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      act(async () => { const r = await api('/api/teams', 'POST', { name: n }); S.teamId = r.team.id; }, `${n} is ready. You’re its team leader.`);
    } }, name, h('button', { class: 'btn small', type: 'submit' }, 'Create team'));
    return h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h3', {}, 'Your teams')),
      S.teams.length
        ? h('div', { class: 'rows' }, S.teams.map(t => h('div', { class: 'row' + (t.id === S.teamId ? ' on' : '') },
            h('button', { class: 'row-main', type: 'button', onclick: () => selectTeam(t.id) }, h('b', {}, t.name), h('span', {}, `${plural(t.members, 'member')} · ${plural(t.projects, 'project')}`)),
            roleChip(t.role))))
        : h('p', { class: 'empty' }, 'You’re not in a team yet. Create one, or ask a team leader to invite you.'),
      create);
  }

  function startPanel() {
    return h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h2', { class: 'big' }, 'Plan together, live.')),
      h('div', { class: 'steps' },
        h('div', { class: 'step' }, h('div', {}, h('b', {}, 'Create a team'), h('span', {}, 'Name it on the left. You become the team leader.'))),
        h('div', { class: 'step' }, h('div', {}, h('b', {}, 'Invite your people'), h('span', {}, 'By username or email. Choose who can edit, who can only view, and who can invite others.'))),
        h('div', { class: 'step' }, h('div', {}, h('b', {}, 'Share a board'), h('span', {}, 'Open the app, sign in from the Team panel and choose “Share this board”. Everyone sees changes as they happen.')))),
      h('div', { class: 'inline', css: { 'margin-top': '20px' } },
        h('a', { class: 'btn red', href: '/app' }, 'Open the web app'),
        h('a', { class: 'btn', href: 'https://github.com/1337VIPER/venom-board/releases/latest' }, 'Download for Windows')));
  }

  function teamMain(d) {
    const role = d.role, isAdmin = RANK[role] >= RANK.admin, isEditor = RANK[role] >= RANK.editor, me = S.me.id;
    const tid = encodeURIComponent(d.team.id);

    const rename = isAdmin ? h('details', { class: 'more', css: { 'margin-top': '12px' } }, h('summary', {}, 'Rename team'),
      form([{ name: 'name', label: 'Team name', value: d.team.name, max: 60 }], 'Save', v => act(() => api(`/api/teams/${tid}`, 'PATCH', { name: v.name.trim() }), 'Team renamed.'), { small: true })) : null;
    const head = h('section', { class: 'panel' },
      h('div', { class: 'ph', css: { 'margin-bottom': '4px' } }, h('h2', { class: 'big' }, d.team.name), roleChip(role)),
      h('p', { class: 'hint', css: { margin: '0' } }, `${plural(d.members.length, 'member')} · ${plural(d.projects.length, 'shared project')}`),
      rename);

    // projects
    const pname = h('input', { class: 'input sm', placeholder: 'New project name', maxlength: 80, 'aria-label': 'New project name' });
    const newProject = isEditor ? h('form', { class: 'inline', css: { 'margin-top': '14px' }, onsubmit: e => {
      e.preventDefault();
      const n = pname.value.trim() || 'Untitled project';
      act(() => api(`/api/teams/${tid}/projects`, 'POST', { name: n }), `${n} created. Open it to start planning.`);
    } }, pname, h('button', { class: 'btn small', type: 'submit' }, 'New project')) : null;
    const projects = h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h3', {}, 'Shared projects')),
      d.projects.length
        ? h('div', { class: 'rows' }, d.projects.map(p => h('div', { class: 'row' },
            h('div', { class: 'row-main' }, h('b', {}, p.name), h('span', {}, `Updated ${ago(p.updatedAt)}${p.updatedBy ? ' by ' + p.updatedBy : ''}`)),
            h('a', { class: 'btn small red', href: '/app#p=' + encodeURIComponent(p.id) }, 'Open'),
            isEditor ? iconBtn('pen', 'Rename ' + p.name, () => {
              const n = (prompt('Rename this project', p.name) || '').trim();
              if (n && n !== p.name) act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'PATCH', { name: n }), 'Project renamed.');
            }) : null,
            isAdmin ? iconBtn('trash', 'Delete ' + p.name, () => {
              if (confirm(`Delete “${p.name}” for the whole team? This can’t be undone.`)) act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'DELETE'), 'Project deleted.');
            }) : null)))
        : h('p', { class: 'empty' }, isEditor ? 'No shared projects yet. Create one here, or open a board in the app and choose “Share this board”.' : 'No shared projects yet.'),
      newProject);

    // members
    const members = h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h3', {}, 'Members')),
      h('div', { class: 'rows' }, d.members.map(m => {
        const manage = m.id !== me && canManage(role, m.role);
        const control = manage
          ? h('select', { class: 'input sm', css: { width: 'auto', flex: 'none' }, 'aria-label': 'Role for ' + m.displayName,
              onchange: e => act(() => api(`/api/teams/${tid}/members/${encodeURIComponent(m.id)}`, 'PATCH', { role: e.target.value }), `${m.displayName} is now ${ROLE[e.target.value].toLowerCase()}.`) },
              grantable(role).map(r => h('option', { value: r, selected: r === m.role }, ROLE[r])))
          : roleChip(m.role);
        return h('div', { class: 'row' }, avatar(m.displayName, m.color),
          h('div', { class: 'row-main' }, h('b', {}, m.displayName + (m.id === me ? ' (you)' : '')), h('span', {}, '@' + m.username)),
          control,
          manage ? iconBtn('x', 'Remove ' + m.displayName, () => {
            if (confirm(`Remove ${m.displayName} from ${d.team.name}?`)) act(() => api(`/api/teams/${tid}/members/${encodeURIComponent(m.id)}`, 'DELETE'), `${m.displayName} was removed.`);
          }) : null);
      })),
      isAdmin ? inviteForm(d, tid) : h('p', { class: 'hint' }, 'Team admins and the team leader can invite people and change roles.'));

    const pending = isAdmin && d.invites.length ? h('section', { class: 'panel' },
      h('div', { class: 'ph' }, h('h3', {}, 'Waiting to accept')),
      h('div', { class: 'rows' }, d.invites.map(i => h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('b', {}, i.displayName || i.username || i.email), h('span', {}, `Invited as ${(ROLE[i.role] || i.role).toLowerCase()} · ${ago(i.createdAt)}${i.email ? ' · by email' : ''}`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => act(() => api(`/api/teams/${tid}/invites/${encodeURIComponent(i.id)}`, 'DELETE'), 'Invite withdrawn.') }, 'Withdraw'))))) : null;

    return [head, projects, members, pending, dangerZone(d, tid)];
  }

  function inviteForm(d, tid) {
    const who = h('input', { class: 'input sm', placeholder: 'Username or email', maxlength: 254, 'aria-label': 'Username or email to invite' });
    const roles = grantable(d.role);
    const role = h('select', { class: 'input sm', css: { width: 'auto', flex: 'none' }, 'aria-label': 'Role for the invite' },
      roles.map(r => h('option', { value: r, selected: r === 'editor' }, ROLE[r])));
    return h('form', { class: 'inline', css: { 'margin-top': '14px' }, onsubmit: e => {
      e.preventDefault();
      const w = who.value.trim();
      if (!w) { who.focus(); return; }
      act(() => api(`/api/teams/${tid}/invites`, 'POST', { who: w, role: role.value }), `Invite sent to ${w}.`);
    } }, who, role, h('button', { class: 'btn small red', type: 'submit' }, 'Invite'));
  }

  function dangerZone(d, tid) {
    const me = S.me.id;
    if (d.role !== 'leader') {
      return h('section', { class: 'panel danger-zone' },
        h('div', { class: 'ph' }, h('h3', {}, 'Leave team')),
        h('p', { class: 'hint', css: { margin: '0 0 12px' } }, 'You’ll lose access to this team’s shared projects until someone invites you again.'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => {
          if (confirm(`Leave ${d.team.name}?`)) act(async () => { await api(`/api/teams/${tid}/members/${encodeURIComponent(me)}`, 'DELETE'); S.teamId = ''; }, `You left ${d.team.name}.`);
        } }, 'Leave team'));
    }
    const others = d.members.filter(m => m.id !== me);
    const pick = h('select', { class: 'input sm', css: { width: 'auto', 'min-width': '180px' }, 'aria-label': 'New team leader' },
      others.map(m => h('option', { value: m.id }, `${m.displayName} (@${m.username})`)));
    return h('section', { class: 'panel danger-zone' },
      h('div', { class: 'ph' }, h('h3', {}, 'Leadership')),
      others.length ? h('div', { class: 'inline' }, pick, h('button', { class: 'btn small', type: 'button', onclick: () => {
        const m = others.find(o => o.id === pick.value);
        if (m && confirm(`Make ${m.displayName} the team leader? You’ll become a team admin.`)) act(() => api(`/api/teams/${tid}/transfer`, 'POST', { userId: m.id }), `${m.displayName} now leads ${d.team.name}.`);
      } }, 'Hand over leadership')) : h('p', { class: 'hint', css: { margin: '0' } }, 'Invite someone before you can hand the team over.'),
      h('p', { class: 'hint' }, 'Deleting the team removes every shared project in it for everyone.'),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => {
        const typed = prompt(`This deletes ${d.team.name} and all of its shared projects for everyone. Type the team name to confirm.`);
        if (typed === null) return;
        if (typed.trim() !== d.team.name) { toast('The name didn’t match, so nothing was deleted.', true); return; }
        act(async () => { await api(`/api/teams/${tid}`, 'DELETE'); S.teamId = ''; }, `${d.team.name} was deleted.`);
      } }, 'Delete team'));
  }

  /* ---------- routing ---------- */
  async function route() {
    const hash = location.hash.slice(1), eq = hash.indexOf('=');
    const key = eq < 0 ? hash : hash.slice(0, eq), val = eq < 0 ? '' : hash.slice(eq + 1);
    try {
      if (key === 'verify' && val) return await verifyEmail(val);
      if (key === 'reset' && val) return resetView(val);
      if (!S.me) await loadMe();
      if (S.me) {
        if (key === 'team' && val) S.teamId = val;
        return await openDashboard();
      }
      if (key === 'signup') return signUpView();
      if (key === 'forgot') return forgotView();
      return signInView();
    } catch (e) {
      show(h('div', { class: 'center' }, h('div', {}, h('p', {}, e.message), h('button', { class: 'btn', type: 'button', onclick: route }, 'Try again'))));
    }
  }
  window.addEventListener('hashchange', route);
  route();
})();
