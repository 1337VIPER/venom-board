// Per-project roles: a team admin can give a teammate a different role in one project, say an editor who may only
// view "Steam launch", or a viewer who may edit "Moodboard". Only editors and viewers can be given one; team leaders
// and admins always have their team role. Every check of what someone may do in a project goes through effective()
// (the REST API, live rooms, MCP tools and the integrations), so the override counts everywhere at once.
// Removing someone from the team removes theirs (the table's foreign key does it), and so does deleting the project.
const { okId, txt } = require('./sanitize');

const OVERRIDABLE = ['editor', 'viewer'];

function projectRoles({ db, route, fail, H, limit, needProject, getLive }) {
  const q = {
    team: db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?'),
    get: db.prepare('SELECT role FROM project_roles WHERE project_id = ? AND user_id = ?'),
    forTeam: db.prepare('SELECT project_id, user_id, role FROM project_roles WHERE team_id = ?'),
    forUser: db.prepare('SELECT project_id, role FROM project_roles WHERE team_id = ? AND user_id = ?'),
    set: db.prepare(`INSERT INTO project_roles (project_id, team_id, user_id, role, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, set_by = excluded.set_by, set_at = excluded.set_at`),
    clear: db.prepare('DELETE FROM project_roles WHERE project_id = ? AND user_id = ?'),
    clearMember: db.prepare('DELETE FROM project_roles WHERE team_id = ? AND user_id = ?'),
  };
  const HOUR = 3600000;

  // someone's role in a project: their team role, unless an admin gave them another one there (null if not in the team)
  function effective(projectId, teamId, userId, teamRole) {
    const role = teamRole === undefined ? (q.team.get(teamId, userId) || {}).role || null : teamRole;
    if (!OVERRIDABLE.includes(role)) return role;
    const o = q.get.get(projectId, userId);
    return o && OVERRIDABLE.includes(o.role) ? o.role : role;
  }

  // what the Team panel shows: each person's own role where an admin set one (for admins), and yours (for everyone)
  function teamInfo(teamId, userId, teamRole) {
    const admin = teamRole === 'admin' || teamRole === 'leader';
    const people = new Map(), mine = new Map();
    for (const r of admin ? q.forTeam.all(teamId) : q.forUser.all(teamId, userId).map(x => ({ ...x, user_id: userId }))) {
      if (admin) { if (!people.has(r.project_id)) people.set(r.project_id, {}); people.get(r.project_id)[r.user_id] = r.role; }
      if (r.user_id === userId) mine.set(r.project_id, r.role);
    }
    return projectId => ({
      myRole: OVERRIDABLE.includes(teamRole) && mine.has(projectId) ? mine.get(projectId) : teamRole,
      ...(admin ? { people: people.get(projectId) || {} } : {}),
    });
  }

  // a teammate's role went up to admin or leader: project roles no longer apply to them, so they're cleared
  const forgetMember = (teamId, userId) => q.clearMember.run(teamId, userId);

  route('PUT', '/api/projects/:id/people/:userId', async ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    const userId = ctx.params.userId, b = await H.readJson(ctx.req), role = b.role === null ? '' : txt(b.role, 10);
    const target = okId(userId) ? (q.team.get(p.team_id, userId) || {}).role : null;
    if (!target) fail(404, 'not_found', 'That person isn’t in this team.');
    if (!OVERRIDABLE.includes(target)) fail(400, 'admin', 'Team admins and the team leader can always edit every project.');
    if (role && !OVERRIDABLE.includes(role)) fail(400, 'role', 'Choose editor or viewer, or their team role.');
    if (!limit('project-role:' + ctx.user.id, 120, HOUR)) fail(429, 'rate', 'That’s a lot of changes. Try again in a while.');
    if (role) q.set.run(p.id, p.team_id, userId, role, ctx.user.id, Date.now()); else q.clear.run(p.id, userId);
    const now = effective(p.id, p.team_id, userId);
    getLive().projectRoleChanged(p.id, userId);  // their open copy of the board changes straight away
    getLive().teamChanged(p.team_id);
    return { role: role || null, effective: now };
  });

  return { effective, teamInfo, forgetMember };
}

module.exports = { projectRoles };
