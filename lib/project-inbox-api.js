// The server is the single writer. Agents and the UI use the same inbox;
// authenticated session identity, not request JSON, determines agent roles.
export function installProjectInboxRoutes(app, { store, readMeta, tokenValid, changed }) {
  function taskSummary(task) {
    const blockedReason = task.status === 'blocked'
      ? task.history.findLast(event => event.action === 'block')?.reason || null
      : null;
    return { id: task.id, title: task.title, owner: task.owner, status: task.status,
      revision: task.revision, source: task.source, blockedReason, updatedAt: task.history.at(-1)?.at || null };
  }
  function context(id, role = 'human') {
    const chat = readMeta()[id];
    if (!chat?.chatProjectId || chat.chatStandby || !['creator', 'reviewer'].includes(chat.chatRole)) throw Object.assign(new Error('CR project not found'), { status: 404 });
    // A solo chat has no Creator–Reviewer project: its agent works without
    // agreement or review gates, so the inbox protocol cannot apply to it.
    if (!chat.chatPair) throw Object.assign(new Error('This chat has no Reviewer, so it has no project inbox; attach a reviewer to use one'), { status: 409 });
    return { projectId: chat.chatProjectId, actor: { sessionId: id,
      creatorSessionId: chat.chatPair.creatorSessionId, role: role === 'human' ? role : chat.chatRole } };
  }
  const handle = fn => (req, res) => {
    try { res.json(fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Project inbox unavailable' }); }
  };
  app.get('/api/project-inboxes', handle(() => {
    const seen = new Set();
    const projects = [];
    for (const [sessionId, chat] of Object.entries(readMeta())) {
      if (chat.chatStandby || !chat.chatProjectId || chat.chatRole !== 'creator' || !chat.chatPair || seen.has(chat.chatProjectId)) continue;
      seen.add(chat.chatProjectId);
      const project = store.read(chat.chatProjectId);
      projects.push({ ...project, ...project.config, tasks: project.tasks.map(taskSummary),
        projectId: chat.chatProjectId, sessionId, title: chat.title || 'Project' });
    }
    return { projects };
  }));
  app.get('/api/chats/:id/inbox', handle(req => store.read(context(req.params.id).projectId)));
  app.get('/api/chats/:id/inbox/tasks/:taskId', handle(req => {
    const project = store.read(context(req.params.id).projectId);
    const task = project.tasks.find(item => item.id === req.params.taskId);
    if (!task) throw Object.assign(new Error('Unknown task'), { status: 404 });
    return task;
  }));
  app.post('/api/chats/:id/inbox/config', handle(req => {
    const { projectId, actor } = context(req.params.id);
    const result = store.configure(projectId, req.body, actor);
    changed(projectId, { human: true, action: 'configure' });
    return result;
  }));
  app.post('/api/chats/:id/inbox/tasks', handle(req => {
    const { projectId, actor } = context(req.params.id);
    const result = store.add(projectId, req.body, actor);
    changed(projectId, { human: true, action: 'add' });
    return result;
  }));
  app.post('/api/chats/:id/inbox/tasks/:taskId/unblock', handle(req => {
    const { projectId, actor } = context(req.params.id);
    const result = store.transition(projectId, req.params.taskId, 'unblock', req.body, actor);
    changed(projectId, { human: true, action: 'unblock' });
    return result;
  }));
  app.post('/api/internal/sessions/:id/inbox', handle(req => {
    if (!tokenValid(req.params.id, req.get('X-Feather-Bridge-Token'))) {
      throw Object.assign(new Error('Invalid session capability'), { status: 403 });
    }
    const { projectId, actor } = context(req.params.id, 'agent');
    const { action, taskId, ...input } = req.body || {};
    if (action === 'read') return store.read(projectId);
    let result;
    if (action === 'add') result = store.add(projectId, input, actor);
    else if (action === 'claim') result = store.claim(projectId, actor, { taskId });
    else result = store.transition(projectId, taskId, action, input, actor);
    changed(projectId, { action, actor });
    return { task: result };
  }));
}

export function projectInboxUpdates(store, meta) {
  const seen = new Set(), items = [];
  for (const chat of Object.values(meta)) {
    if (chat.chatStandby || !chat.chatProjectId || chat.chatRole !== 'creator' || seen.has(chat.chatProjectId)) continue;
    seen.add(chat.chatProjectId);
    for (const task of store.read(chat.chatProjectId).tasks) {
      if (task.status !== 'done' || !task.result?.summary) continue;
      const occurredAt = task.history.at(-1)?.at || task.updatedAt;
      items.push({ evidenceId: `inbox:${chat.chatProjectId}:${task.id}`, kind: 'update', sourceKind: 'chat',
        room: chat.title || 'Project', title: task.title, summary: task.result.summary,
        detail: task.result.evidence, occurredAt, sourceHref: `/#${encodeURIComponent(task.owner)}`,
        sourceState: 'available', status: 'reviewed', needsReview: false, sessionId: task.owner });
    }
  }
  return items;
}
