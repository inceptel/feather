const COMPLAINT_LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (?:\[id:([A-Za-z0-9_-]{1,128})\] )?Complaint from #([A-Za-z0-9._-]{1,64}): (.+)$/
const RESOLVED_LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \[resolved:([A-Za-z0-9_-]{1,128})\] ?(.*)$/

// Complaints are `- <date> <time> [id:<id>] Complaint from #<room>: ...` lines
// in ~/rooms/friction/notes.md. A later `- <date> <time> [resolved:<id>] <what
// changed>` line (written by `room resolve`) closes the complaint with that id.
export function parseFrictionNotes(raw) {
  const complaints = []
  const resolutions = new Map()
  let legacyIndex = 0
  for (const line of String(raw || '').split('\n')) {
    const resolved = line.match(RESOLVED_LINE)
    if (resolved) {
      const [, date, time, id, text] = resolved
      if (!resolutions.has(id)) resolutions.set(id, { resolvedAt: `${date}T${time}:00Z`, resolution: text.trim() || null })
      continue
    }
    const match = line.match(COMPLAINT_LINE)
    if (!match) continue
    const [, date, time, explicitId, source, body] = match
    const evidenceMarker = ' | Evidence: '
    const evidenceAt = body.indexOf(evidenceMarker)
    complaints.push({
      id: explicitId || `legacy-${legacyIndex++}`,
      hasStableId: Boolean(explicitId),
      timestamp: `${date}T${time}:00Z`,
      source,
      summary: evidenceAt >= 0 ? body.slice(0, evidenceAt) : body,
      evidence: evidenceAt >= 0 ? body.slice(evidenceAt + evidenceMarker.length) : null,
      resolvedAt: null,
      resolution: null,
    })
  }
  for (const complaint of complaints) {
    if (!complaint.hasStableId) continue
    const closed = resolutions.get(complaint.id)
    if (closed) Object.assign(complaint, closed)
  }
  return complaints
}

export function openFrictionComplaints(complaints) {
  return complaints.filter(complaint => !complaint.resolvedAt)
}
