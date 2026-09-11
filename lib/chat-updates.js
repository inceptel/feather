import fs from 'node:fs';
import path from 'node:path';
import { listWikiPages } from './room-wiki.js';

// Explicit, reviewed summaries, not raw transcript messages. A chat's Creator
// owns this small JSON file alongside its other project artifacts.
export function chatUpdates(meta, wikiDir) {
  const items = [];
  for (const [sessionId, chat] of Object.entries(meta)) {
    if (chat.chatRole !== 'creator' || !chat.cwd) continue;
    try {
      const file = path.join(chat.cwd, `updates.${sessionId}.json`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const updates = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(updates)) continue;
      for (const update of updates.slice(-200)) {
        if (!update || typeof update.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(update.id)
          || typeof update.summary !== 'string' || !update.summary.trim()
          || !Number.isFinite(Date.parse(update.occurredAt))) continue;
        items.push({
          evidenceId: `chat:${sessionId}:${update.id}`, kind: 'update', sourceKind: 'chat',
          room: chat.title || 'Chat', title: String(update.title || chat.title || 'Chat update').slice(0, 160),
          summary: update.summary.slice(0, 9000), detail: null, occurredAt: new Date(update.occurredAt).toISOString(),
          sourceHref: `/#${encodeURIComponent(sessionId)}`, sourceState: 'available',
          status: 'update', needsReview: false, sessionId,
        });
      }
    } catch { /* A missing or half-written file is not a publication. */ }
  }
  for (const page of listWikiPages(wikiDir)) {
    items.push({
      evidenceId: `wiki:shared:${page.name}:${page.updatedAt}`, kind: 'update', sourceKind: 'wiki',
      room: 'Shared wiki', title: `Wiki · ${page.name}`, summary: `${page.name} was updated in the shared Wiki.`,
      detail: null, occurredAt: page.updatedAt, sourceHref: '/#wiki', sourceState: 'available',
      status: 'wiki updated', needsReview: false, sessionId: null,
    });
  }
  return items;
}
