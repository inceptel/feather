#!/usr/bin/env node
// Feather starts this in a pi chat's tmux pane, with main.js's arguments. It
// runs main.js of the shipped code, or of this chat's last good self-update,
// relaunches it on request (self_update), and rolls back a start that fails.
// See selfmod.js. It changes nothing else: same pane, same arguments, and it
// exits with main.js's exit code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runLauncher } from './selfmod.js';

const args = process.argv.slice(2);
const { values } = parseArgs({ args, options: { 'session-dir': { type: 'string' } }, strict: false });
const shippedPiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!values['session-dir']) {
  process.stderr.write('usage: launcher.js --session-id <id> --session-dir <dir> [main.js options]\n');
  process.exit(2);
}
const env = { ...process.env, FEATHER_PI_LAUNCHER: '1', FEATHER_PI_SHIPPED_DIR: shippedPiDir };
process.exitCode = await runLauncher({ sessionDir: path.resolve(values['session-dir']), shippedPiDir, args, env });
