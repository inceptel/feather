import { createJsonState, isJsonRecord } from './json-state.js'

export function createChatPins({ file, root }) {
  const state = createJsonState({ file, root, document: 'chat preferences', defaultValue: {},
    validate: value => isJsonRecord(value) && Object.values(value).every(entry =>
      isJsonRecord(entry) && (entry.pinned === undefined || typeof entry.pinned === 'boolean')
      && (entry.archived === undefined || typeof entry.archived === 'boolean')
      && (entry.title === undefined || typeof entry.title === 'string')),
  })
  return {
    // Project existing entrances without moving files, rewriting transcripts,
    // launching agents, or writing on GET (including read-only canaries).
    snapshot(rooms = []) {
      const preferences = state.read()
      const pins = new Map()
      for (const room of rooms) {
        const session = room.sessions?.find(s => s.id === room.leaderSessionId)
          || room.sessions?.find(s => !s.isWorker && s.id !== room.pulse?.sessionId)
        if (session) pins.set(session.id, { id: session.id, title: room.name, legacy: true })
      }
      for (const [id, entry] of Object.entries(preferences)) {
        if (entry.pinned === false || entry.archived) pins.delete(id)
        else if (entry.pinned) pins.set(id, { id, ...(entry.title ? { title: entry.title } : {}) })
      }
      return { initialized: true, pins: [...pins.values()], archived: Object.keys(preferences).filter(id => preferences[id].archived) }
    },
    set(id, input) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(id)) throw new Error('Invalid chat ID')
      if (!isJsonRecord(input) || !['pinned', 'archived'].some(key => typeof input[key] === 'boolean')) throw new Error('Provide pinned or archived as a boolean')
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw new Error('Invalid chat title')
      state.update(current => ({ ...current, [id]: { ...current[id],
        ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}),
        ...(typeof input.archived === 'boolean' ? { archived: input.archived } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      } }))
    },
  }
}
