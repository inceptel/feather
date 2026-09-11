export function resolveCodexWatchId(uuid, meta = {}) {
  for (const [featherId, entry] of Object.entries(meta)) {
    if (entry?.agent === 'codex' && entry.codexUuid === uuid) return featherId
  }
  return uuid
}

export function codexAdoptionPending(meta, featherId) {
  return meta?.[featherId]?.agent === 'codex' && !meta[featherId].codexUuid
}

export function codexHeadHasChatIdentity(head, id) {
  const marker = `[Feather chat identity: ${id}]`;
  for (const line of String(head).split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.type !== 'response_item' || record.payload?.role !== 'developer') continue;
      if (record.payload.content?.some(part => typeof part.text === 'string' && part.text.includes(marker))) return true;
    } catch { /* A partial final record is retried after more bytes arrive. */ }
  }
  return false;
}
