// Explicit opt-in: launches four real subscription-backed agent sessions.
// All writes, tmux sessions and restart tests belong to an isolated instance.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';
const repo = path.resolve(import.meta.dirname, '../..');
if (!process.argv.includes('--run')) throw new Error('Pass --run to launch the real-agent acceptance test.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-cr-proof-'));
fs.chmodSync(root, 0o700);
const home = path.join(root, 'home'), state = path.join(root, 'state'), bin = path.join(root, 'bin');
for (const dir of [home, state, bin, path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, 'wiki')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const originalHome = os.homedir();
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 1 }), { mode: 0o600 });
const priorClaudeSettings = JSON.parse(fs.readFileSync(path.join(originalHome, '.claude/settings.json'), 'utf8'));
fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
  skipDangerousModePermissionPrompt: priorClaudeSettings.skipDangerousModePermissionPrompt === true,
}), { mode: 0o600 });
const socket = 'cr-proof-' + path.basename(root);
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec /usr/bin/tmux -L '${socket}' "$@"\n`, { mode: 0o700 });
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n'${path.join(originalHome, '.local/bin/claude')}' "$@" 2>>'${path.join(root, 'claude-errors.log')}'\nresult=$?\n'${path.join(bin, 'tmux')}' capture-pane -p -S -100 > '${root}/claude-exit-'"$FEATHER_SESSION_ID"'.log' 2>/dev/null\nexit "$result"\n`, { mode: 0o700 });
const env = { ...process.env, HOME: home, FEATHER_STATE_DIR: state,
  FEATHER_WIKI_DIR: path.join(home, 'wiki'), FEATHER_ROOM_PULSES: '0', FEATHER_SCHEDULER: '0',
  FEATHER_OMP_AUTH_GATEWAY_URL: '', FEATHER_OMP_AUTH_GATEWAY_TOKEN_FILE: '',
  PATH: `${bin}:${path.join(repo, 'bin')}:${process.env.PATH}` };
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FEATHER_OPENAI_API_KEY', 'CLAUDECODE', 'CODEX_THREAD_ID']) delete env[key];
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
env.PORT = String(listener.address().port); listener.close(); await once(listener, 'close');
const base = `http://127.0.0.1:${env.PORT}`;
const receipt = { root, base, socket, startedAt: new Date().toISOString(), checks: {}, pairs: [] };
const save = () => fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
save(); console.log(JSON.stringify({ root, base, socket }));
let server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  const log = fs.openSync(path.join(root, 'server.log'), 'a', 0o600);
  server = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', log, log] }); fs.closeSync(log);
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null) throw new Error('Isolated server exited; see server.log');
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Isolated server did not become healthy');
}
async function stopServer() { if (server?.exitCode === null) { server.kill(); await once(server, 'exit'); } }
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${JSON.stringify(result)}`); return result;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function isIntegratedCommit(cwd, revision) {
  const match = typeof revision === 'string' && revision.match(/^(?:main@)?([0-9a-f]{40})$/i);
  if (!match) return false;
  const commit = match[1];
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, stdio: 'ignore' });
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}
try {
  // Keep credential copies inside the cleanup scope, even if one copy fails.
  for (const file of ['.claude/.credentials.json', '.codex/auth.json']) {
    fs.copyFileSync(path.join(originalHome, file), path.join(home, file));
    fs.chmodSync(path.join(home, file), 0o600);
  }
  await start();
  for (const name of ['Tic tac toe · pair A', 'Tic tac toe · pair B']) {
    const pair = await post('/api/chats', { name, mode: 'ralph', agent: 'claude', reviewerAgent: 'codex',
      ...(receipt.pairs[0] ? { projectSessionId: receipt.pairs[0].id } : {}) });
    receipt.pairs.push(pair); save();
  }
  const [a, b] = receipt.pairs, cwd = a.cwd;
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Feather CR proof'); git(cwd, 'config', 'user.email', 'cr-proof@localhost');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  fs.writeFileSync(path.join(cwd, 'winner.js'), `// Baseline fixture: task win-rules must submit this baseline for review before repair.\nexport function winner(board) {\n  for (const [a,b,c] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8]]) {\n    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];\n  }\n  return null;\n}\n`);
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'worktrees/\nnode_modules/\nevidence/\n.integration.lock\n');
  const brief = `Build a local HTML tic-tac-toe website. Stay within this project and its isolated wiki. Do not push, deploy, send external messages, or change Feather. Use real browser verification. Playwright is installed at ${path.join(repo, 'node_modules/@playwright/test')}; import it by absolute path if necessary. Use a local static server.\n\nDOM test contract: nine native buttons with data-cell="0" through "8" in row-major order, text empty/X/O; a role="status" element with aria-live="polite" announces turn and winner/draw; a button named New game; scoreboard elements data-score="X", "O", "draw" containing integer counts. index.html at project root. New game starts X and preserves match scores.\n\nThere are two independent CR pairs. Each Creator creates a separate git worktree on a branch cr-<creator-id>, outside the main checkout or under ignored worktrees/. Read the project inbox; use claim/propose/agree/submit/review/complete. Reviewers execute tests themselves, never approve from claims alone. Work only your claimed task. Sync your worktree with main before starting a task. Serialize integration with flock on ${path.join(cwd, '.integration.lock')}, cherry-pick your commits onto main, retain peers' changes, and review the integrated result before completing. If integrated code differs from submitted candidate, submit a new revision and get new review before completion.\n\nDo not alter winner.js except as part of win-rules. For win-rules, first submit the existing winner behavior as the baseline candidate, ask Reviewer to test ALL win lines, then repair and resubmit based on evidence. This is the intentional defect-detection test.\n\nAfter each approved task, save any lasting knowledge in an isolated wiki topic page under ${path.join(home, 'wiki')} with review evidence. Complete with artifact/test evidence and wiki path. Continue to next task without human prompts. After six user tasks are done, generate and complete exactly one useful improvement, agreed with your Reviewer. Do not predetermine the improvement. Once the seventh task is done, both pairs end RALPH_WAITING: Proof task inbox complete.\n`;
  fs.writeFileSync(path.join(cwd, 'PROJECT.md'), brief);
  git(cwd, 'add', 'package.json', 'winner.js', '.gitignore', 'PROJECT.md'); git(cwd, 'commit', '-m', 'Seed isolated CR acceptance project');
  await post(`/api/chats/${a.id}/inbox/config`, { objective: 'Build and verify the tic-tac-toe HTML site described in PROJECT.md. Finish six user tasks, then exactly one independently chosen useful follow-up. Local work only.', allowIdeas: true, maxGeneratedTasks: 1 });
  const tasks = [
    ['board', 'Playable board', 'Create index.html and game UI: X/O alternate, occupied squares reject moves. Use existing winner.js, do not fix it yet. Follow PROJECT.md DOM contract.', []],
    ['win-rules', 'Win and draw rules', 'Submit the current baseline winner behavior for Reviewer testing before changing it. Reviewer must exercise all eight winning lines and draws, catch defects, then review corrected revision. No moves after game over.', ['board']],
    ['reset', 'New game', 'New game clears all nine cells, resets turn to X and removes game-over lock. Preserve accumulated match scores.', ['win-rules']],
    ['scores', 'Scoreboard', 'Track X wins, O wins and draws across New game. Increment exactly once per finished game, including repeated clicks after game-over.', ['board']],
    ['responsive', 'Responsive layout', 'Polish layout at 390px phone and 1280px desktop with readable text, usable touch targets and no horizontal overflow.', ['board']],
    ['keyboard', 'Keyboard and announcements', 'Native keyboard controls support Enter and Space, visible focus, role=status aria-live=polite announces turn and result. Verify in browser.', ['reset', 'scores', 'responsive']],
  ];
  for (const [id, title, description, dependsOn] of tasks) await post(`/api/chats/${a.id}/inbox/tasks`, { id, title, description, dependsOn });
  for (const pair of [a, b]) await post(`/api/sessions/${pair.id}/send`, { text: `Start the standing project assignment. Read PROJECT.md and the project inbox with your authenticated CLI. Claim work, agree criteria with your Reviewer, build and iterate through the inbox. No need to ask me to continue. Project root: ${cwd}` });
  receipt.launchedAt = new Date().toISOString(); save();
  let restarted = false, stoppedAt = null, resumed = false;
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const project = await (await fetch(base + `/api/chats/${a.id}/inbox`)).json();
    const active = project.tasks.filter(task => task.owner && task.status !== 'done');
    if (!restarted && active.length) {
      const before = active.map(task => [task.id, task.owner]);
      await stopServer(); await start();
      const after = await (await fetch(base + `/api/chats/${a.id}/inbox`)).json();
      receipt.checks.restartOwnership = before.every(([id, owner]) => after.tasks.some(task => task.id === id && task.owner === owner));
      restarted = true; save();
    }
    if (restarted && !stoppedAt && project.tasks.some(task => task.status === 'done')) {
      await post(`/api/sessions/${b.id}/ralph`, { enabled: false });
      stoppedAt = Date.now(); receipt.stopAt = new Date().toISOString();
      receipt.stopIteration = JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')))[b.id].ralph.iteration;
      save();
    }
    if (stoppedAt && !resumed && Date.now() - stoppedAt >= 20_000) {
      const meta = JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')));
      receipt.checks.stop = meta[b.id].ralph.enabled === false && meta[b.id].ralph.iteration === receipt.stopIteration;
      await post(`/api/sessions/${b.id}/send`, { text: 'Resume the standing assignment. Read your inbox and sidecar feedback and continue.' });
      receipt.checks.humanResume = JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')))[b.id].ralph.enabled;
      resumed = true; save();
    }
    receipt.progress = project.tasks.map(({ id, owner, status, source }) => ({ id, owner, status, source }));
    save(); console.log(JSON.stringify({ at: new Date().toISOString(), progress: receipt.progress }));
    if (project.tasks.length === 7 && project.tasks.every(task => task.status === 'done')) {
      receipt.checks.sevenCompleted = true;
      const seededIds = new Set(tasks.map(([id]) => id));
      const seededTasks = project.tasks.filter(task => seededIds.has(task.id));
      const generatedTasks = project.tasks.filter(task => !seededIds.has(task.id));
      receipt.checks.taskSources = seededTasks.length === 6
        && seededTasks.every(task => task.source === 'human')
        && generatedTasks.length === 1
        && generatedTasks[0].source === 'agent';
      receipt.checks.twoPairsWorked = new Set(project.tasks.map(task => task.owner)).size === 2;
      receipt.checks.noDuplicateClaims = project.tasks.every(task => task.history.filter(event => event.action === 'claim').length === 1);
      receipt.checks.reviewerRejectedDefect = project.tasks.find(task => task.id === 'win-rules').history.some(event => event.action === 'review' && event.verdict === 'REVISE');
      receipt.checks.exactIntegratedRevisions = project.tasks.every(task =>
        task.review?.verdict === 'PASS'
        && task.review.revision === task.revision
        && isIntegratedCommit(cwd, task.revision));
      const feed = await (await fetch(base + '/api/feed')).json();
      fs.writeFileSync(path.join(root, 'feed.json'), JSON.stringify(feed, null, 2));
      const items = feed.items || [];
      receipt.checks.updates = project.tasks.every(task => items.some(item => item.evidenceId === `inbox:${a.projectId}:${task.id}`));
      const wikiRoot = fs.realpathSync(path.join(home, 'wiki'));
      receipt.checks.wikiEvidence = project.tasks.every(task => {
        if (!task.result?.wiki) return false;
        const file = path.resolve(cwd, task.result.wiki);
        if (!fs.existsSync(file)) return false;
        const realFile = fs.realpathSync(file);
        return realFile.startsWith(wikiRoot + path.sep) && fs.statSync(realFile).isFile()
          && fs.readFileSync(realFile, 'utf8').trim().length > 100;
      });
      const app = express(); app.use(express.static(cwd));
      const site = app.listen(0, '127.0.0.1'); await once(site, 'listening');
      try {
        const check = spawn(process.execPath, [path.join(repo, 'test/live/tic-tac-toe-check.mjs'),
          `http://127.0.0.1:${site.address().port}`, path.join(root, 'browser')], { cwd: repo, stdio: 'inherit' });
        const [code] = await once(check, 'exit'); receipt.checks.browser = code === 0;
      } finally { site.close(); site.closeAllConnections(); await once(site, 'close'); }
      receipt.completedAt = new Date().toISOString(); save(); break;
    }
    await delay(5000);
  }
  if (!receipt.checks.sevenCompleted) throw new Error('Live acceptance deadline reached without seven completed tasks.');
  const required = ['restartOwnership', 'stop', 'humanResume', 'sevenCompleted', 'taskSources',
    'twoPairsWorked', 'noDuplicateClaims', 'reviewerRejectedDefect', 'exactIntegratedRevisions',
    'wikiEvidence', 'updates', 'browser'];
  const failed = required.filter(check => receipt.checks[check] !== true);
  if (failed.length) throw new Error(`Live acceptance failed: ${failed.join(', ')}`);
} catch (error) { receipt.error = error.message; save(); console.error(error.message); process.exitCode = 1; }
finally {
  for (const pair of receipt.pairs) { try { await post(`/api/sessions/${pair.id}/ralph`, { enabled: false }); } catch {} }
  await stopServer();
  // Only this test's named tmux server; leave all production sessions untouched.
  try { execFileSync('/usr/bin/tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  for (const file of ['.claude/.credentials.json', '.codex/auth.json']) {
    try { fs.unlinkSync(path.join(home, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  receipt.stoppedAt = new Date().toISOString(); save();
  console.log(`Evidence retained: ${root}`);
}
