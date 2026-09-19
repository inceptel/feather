#!/usr/bin/env node
// Never discover a server or fetch a fresh generation for a delayed start.
import fs from 'node:fs';
const [action = 'read', ...args] = process.argv.slice(2);
try {
  if (!process.env.FEATHER_BRIDGE_URL || !process.env.FEATHER_BRIDGE_TOKEN || !process.env.FEATHER_SESSION_ID) throw new Error('Run inside a Feather Creator session with its bridge capability.');
  if (!['read', 'start', 'progress', 'stop'].includes(action)) throw new Error('Expected read, start, progress, or stop.');
  let input = {};
  if (args[0] === '--file') input = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  else if (args[0] === '--stdin') input = JSON.parse(fs.readFileSync(0, 'utf8'));
  else if (args.length) input = JSON.parse(args.join(' '));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object.');
  if (['start', 'progress'].includes(action) && !Number.isSafeInteger(input.generation)) throw new Error('Supply the generation observed with read for this human instruction.');
  const url = new URL(process.env.FEATHER_BRIDGE_URL);
  url.pathname = `/api/internal/sessions/${encodeURIComponent(process.env.FEATHER_SESSION_ID)}/workflow`;
  url.search = ''; url.hash = '';
  const response = await fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Feather-Bridge-Token': process.env.FEATHER_BRIDGE_TOKEN,
  }, body: JSON.stringify({ ...input, action }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`feather-workflow: ${error.message}\n`); process.exitCode = 1; }
