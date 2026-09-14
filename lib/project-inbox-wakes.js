// Notifications continue existing work; they never override an explicit Stop.
// Recheck at the waiting boundary too, since work may arrive during a turn.
export function projectInboxWakeIds(project, meta, { human = false, action, includeWorking = false } = {}) {
  if (action && !['configure', 'add', 'complete', 'unblock'].includes(action)) return [];
  if (!project.config?.objective) return [];
  const done = new Set(project.tasks.filter(task => task.status === 'done').map(task => task.id));
  const ready = project.tasks.some(task => task.status === 'queued' && task.dependsOn.every(id => done.has(id)));
  return Object.entries(meta).filter(([id, chat]) => {
    if (chat.chatProjectId !== project.projectId || chat.chatRole !== 'creator' || chat.mode !== 'ralph') return false;
    const state = chat.ralph || {};
    if (['stopped', 'error', 'scheduled'].includes(state.status) || (state.status === 'working' && !includeWorking)) return false;
    const owned = project.tasks.find(task => task.owner === id && task.status !== 'done');
    const unblocked = human && action === 'unblock' && owned?.status === 'agreeing';
    if (state.status === 'blocked' && !(human && (!owned || unblocked))) return false;
    if (!state.enabled && !human) return false;
    return unblocked || (!owned && ready);
  }).map(([id]) => id);
}
