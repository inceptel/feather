const COMPLAINT_LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (?:\[id:([A-Za-z0-9_-]{1,128})\] )?Complaint from #([A-Za-z0-9._-]{1,64}): (.+)$/

export function parseFrictionNotes(raw) {
  const complaints = []
  let legacyIndex = 0
  for (const line of String(raw || '').split('\n')) {
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
    })
  }
  return complaints
}
