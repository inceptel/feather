import { ralphBoundaryFromLine } from './ralph.js';

// The caller supplies a bounded, complete-line transcript tail. Process health
// is separate: no boundary is not proof that an agent is still working.
export function recoverChatBoundary(entry, lines, agent) {
  const state = entry?.ralph;
  if (entry?.mode !== 'ralph' || state?.enabled !== true || state.status !== 'working') return null;
  const tail = typeof lines === 'string' ? lines.split('\n') : lines;
  if (!Array.isArray(tail)) return null;
  for (let index = tail.length - 1; index >= 0; index--) {
    const boundary = ralphBoundaryFromLine(tail[index], agent);
    if (!boundary) continue;
    // A newer user/continuation turn invalidates an older completion. Do not
    // replay it merely because the latest turn has not completed yet.
    if (boundary.type === 'active') return null;
    if (!boundary.key || boundary.key === state.lastBoundaryKey) return null;
    return boundary;
  }
  return null;
}
