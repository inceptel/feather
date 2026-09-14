#!/usr/bin/env node
// Deliberately no discovery fallback: never write to another Feather instance.
import fs from 'node:fs';
const [action = 'read', ...args] = process.argv.slice(2);
try {
  if (!process.env.FEATHER_BRIDGE_URL || !process.env.FEATHER_BRIDGE_TOKEN || !process.env.FEATHER_SESSION_ID) {
    throw new Error('Run inside a Feather CR session with its bridge capability.');
  }
  let input = {};
  if (args[0] === '--file') input = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  else if (args[0] === '--stdin') input = JSON.parse(fs.readFileSync(0, 'utf8'));
  else if (args.length) input = JSON.parse(args.join(' '));
  const url = new URL(process.env.FEATHER_BRIDGE_URL);
  url.pathname = `/api/internal/sessions/${encodeURIComponent(process.env.FEATHER_SESSION_ID)}/inbox`;
  const response = await fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Feather-Bridge-Token': process.env.FEATHER_BRIDGE_TOKEN,
  }, body: JSON.stringify({ ...input, action }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`feather-inbox: ${error.message}\n`); process.exitCode = 1; }
