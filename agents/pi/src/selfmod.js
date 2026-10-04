// Self-modification (pi spec: "Self-modification", phase 4). pi may edit
// agents/pi/ in its own git clone, commit, and relaunch its own process on that
// commit. The gates:
//
// - Only its own process: the launcher (launcher.js) is the parent of this
//   chat's main.js and nothing else. Code for a commit lives in the session
//   dir (<session>/code/<sha>/agents/pi). Feather's releases and `current`
//   link are never written, and nothing here runs refeather.
// - Only a commit whose tests pass: relaunch exports the commit, runs its
//   `npm test`, and refuses on failure. Commits that touch anything outside
//   agents/pi/, or its package.json or lockfile, are refused too: new
//   dependencies need a Feather deploy by a person.
// - Automatic rollback: the launcher starts the candidate; if it exits or
//   stays silent before it reports ready, the launcher goes back to the last
//   good code. A Feather deploy always wins: self-built code is used only
//   while its base is the shipped commit.
//
// After a relaunch or a rollback, main.js tells the chat what happened in one
// message (reportRelaunch). FEATHER_PI_SELFMOD=off leaves the tool out; the
// launcher then runs only the shipped code.
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-durable';

export const RELAUNCH_EXIT_CODE = 75;
export const READY_TIMEOUT_MS = 120_000;
export const TEST_TIMEOUT_MS = 600_000;
const SHA = /^[0-9a-f]{40}$/;

export function selfmodEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.FEATHER_PI_SELFMOD ?? '').trim());
}

/** The commit of shipped code at `piDir` (<release>/agents/pi): the release dir is named by its commit. */
export function shippedCommit(piDir, env = process.env) {
  if (SHA.test(env.FEATHER_PI_SHIPPED_SHA || '')) return env.FEATHER_PI_SHIPPED_SHA;
  const release = path.basename(path.resolve(piDir, '..', '..'));
  return SHA.test(release) ? release : null;
}

export const codeRoot = sessionDir => path.join(sessionDir, 'code');
const statePath = sessionDir => path.join(codeRoot(sessionDir), 'state.json');
export const readyPath = sessionDir => path.join(codeRoot(sessionDir), 'ready.json');
export const piDirFor = (sessionDir, sha) => path.join(codeRoot(sessionDir), sha, 'agents', 'pi');

/** {base, good, candidate, previous, bad: {sha: reason}, last: {kind, sha, to, reason, changes, at}} */
export function readState(sessionDir) {
  try { return { bad: {}, ...JSON.parse(fs.readFileSync(statePath(sessionDir), 'utf8')) }; } catch { return { bad: {} }; }
}

export function writeState(sessionDir, state) {
  fs.mkdirSync(codeRoot(sessionDir), { recursive: true, mode: 0o700 });
  const file = statePath(sessionDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const readReady = sessionDir => { try { return JSON.parse(fs.readFileSync(readyPath(sessionDir), 'utf8')); } catch { return null; } };

/** main.js calls this once it has opened its state and resumed. */
export function markReady(sessionDir, sha) {
  fs.mkdirSync(codeRoot(sessionDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(readyPath(sessionDir), JSON.stringify({ sha: sha || null, pid: process.pid, at: new Date().toISOString() }));
}

/**
 * The launcher loop. Runs main.js of the chosen code with `args`, relaunches
 * on RELAUNCH_EXIT_CODE, rolls back a candidate that fails to start, and
 * otherwise exits with the child's code. Returns that code.
 */
export async function runLauncher({ sessionDir, shippedPiDir, args, env = process.env, readyTimeoutMs = READY_TIMEOUT_MS, log = message => process.stderr.write(`${message}\n`) }) {
  const shipped = shippedCommit(shippedPiDir, env);
  for (;;) {
    let state = readState(sessionDir);
    // A Feather deploy wins over self-built code.
    if (state.base && state.base !== shipped) {
      if (state.good || state.candidate) log(`pi: Feather shipped new code; dropping self-built ${(state.candidate || state.good).slice(0, 8)}`);
      state = { bad: {}, base: shipped };
      writeState(sessionDir, state);
    }
    const sha = state.candidate || state.good || null;
    const piDir = sha ? piDirFor(sessionDir, sha) : shippedPiDir;
    const main = path.join(piDir, 'src', 'main.js');
    if (sha && !fs.existsSync(main)) {
      rollback(sessionDir, state, sha, 'its code is missing', log);
      continue;
    }
    try { fs.rmSync(readyPath(sessionDir), { force: true }); } catch {}
    const started = Date.now();
    // A candidate that reports ready becomes the good code at once, so status
    // is true while it runs and a later relaunch falls back to it.
    const promote = () => {
      const now = readState(sessionDir);
      if (sha && now.candidate === sha) writeState(sessionDir, { ...now, good: sha, candidate: null });
    };
    const code = await runChild(main, args, { ...env, FEATHER_PI_CODE_SHA: sha || shipped || '' }, sessionDir, readyTimeoutMs, log, promote);
    const ready = readReady(sessionDir);
    const wasReady = !!ready && (ready.sha || null) === (sha || shipped || null) && Date.parse(ready.at) >= started - 1000;
    state = readState(sessionDir);
    if (sha && !wasReady) {
      rollback(sessionDir, state, sha, code === 'timeout' ? `it did not report ready in ${Math.round(readyTimeoutMs / 1000)} s` : `it exited (${code}) before it was ready`, log);
      continue;
    }
    if (sha && sha === state.candidate) promote();
    if (code === RELAUNCH_EXIT_CODE) continue;
    return typeof code === 'number' ? code : 1;
  }
}

function rollback(sessionDir, state, sha, reason, log) {
  const wasCandidate = state.candidate === sha;
  const to = wasCandidate ? state.good || null : null;
  log(`pi: rolling back from ${sha.slice(0, 8)}: ${reason}`);
  writeState(sessionDir, {
    ...state,
    candidate: null,
    good: wasCandidate ? state.good || null : null,
    bad: { ...state.bad, [sha]: reason },
    last: { kind: 'rollback', sha, to: to || state.base || null, reason, at: new Date().toISOString() },
  });
}

// Runs one main.js; resolves its exit code, or 'timeout' when it never got ready.
function runChild(main, args, env, sessionDir, readyTimeoutMs, log, onReady) {
  return new Promise(resolve => {
    const child = spawnProcess(process.execPath, ['--no-warnings', main, ...args], { stdio: 'inherit', env });
    let timedOut = false;
    const started = Date.now();
    const watch = setInterval(() => {
      const ready = readReady(sessionDir);
      if (ready && (ready.sha || null) === (env.FEATHER_PI_CODE_SHA || null) && Date.parse(ready.at) >= started - 1000) {
        clearInterval(watch);
        onReady();
        return;
      }
      if (Date.now() - started > readyTimeoutMs) {
        clearInterval(watch);
        timedOut = true;
        log('pi: no ready signal; stopping this start');
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }
    }, 250);
    // The terminal's ^C goes to main.js (raw input); signals that end the
    // session pass through, and the launcher ends with the child.
    const forward = signal => () => child.kill(signal);
    const handlers = { SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP'), SIGINT: () => {} };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    child.on('exit', (code, signal) => {
      clearInterval(watch);
      for (const [name, handler] of Object.entries(handlers)) process.off(name, handler);
      resolve(timedOut ? 'timeout' : code ?? (signal === 'SIGTERM' || signal === 'SIGHUP' ? 0 : 1));
    });
  });
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}`.trim(), status: result.status, error: result.error };
};
const git = (dir, ...args) => run('git', ['-C', dir, ...args]);
const tail = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');

/** Hard-link a copy of node_modules (cheap; survives the release being pruned). */
function linkModules(fromPiDir, toPiDir) {
  const from = path.join(fromPiDir, 'node_modules');
  if (!fs.existsSync(from)) throw new Error(`no node_modules at ${from}`);
  const copy = run('cp', ['-al', from, path.join(toPiDir, 'node_modules')]);
  if (!copy.ok) throw new Error(`could not link node_modules: ${tail(copy.out, 5)}`);
  // Releases are read-only. The copied dirs must be writable, or the session
  // dir can never be deleted; the files stay shared and read-only.
  const writable = run('find', [path.join(toPiDir, 'node_modules'), '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']);
  if (!writable.ok) throw new Error(`could not make node_modules writable: ${tail(writable.out, 5)}`);
}

// The env for the candidate's tests: no Feather bridge, so tests cannot act on the chat.
function testEnv(env) {
  const clean = {};
  // NODE_TEST_CONTEXT (set inside a test run) would make the child's failures exit 0.
  for (const [key, value] of Object.entries(env)) if (!/^FEATHER_(BRIDGE|SESSION|API)|TOKEN|SECRET|KEY|^NODE_TEST_CONTEXT$/i.test(key)) clean[key] = value;
  return clean;
}

/**
 * The `self_update` tool. `sessionDir` is this chat's dir, `runningPiDir` the
 * agents/pi dir of the running code, `repo` the Feather git repo to clone from,
 * and `exit(code)` ends the process for the launcher.
 */
export function createSelfUpdateTool({ sessionDir, shippedPiDir, runningPiDir, repo, env = process.env, exit = code => setTimeout(() => process.exit(code), 100), testTimeoutMs = TEST_TIMEOUT_MS }) {
  const shipped = shippedCommit(shippedPiDir, env);
  const running = () => env.FEATHER_PI_CODE_SHA || shipped;
  const clone = path.join(sessionDir, 'selfmod');
  const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

  function worktree() {
    if (!shipped) return reply('Self-update is not available: this pi does not run from a Feather release.', true);
    if (!fs.existsSync(path.join(clone, '.git'))) {
      if (!repo || !fs.existsSync(repo)) return reply(`Self-update is not available: no Feather git repo (${repo || 'unset'}).`, true);
      const made = run('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, clone]);
      if (!made.ok) return reply(`git clone failed: ${tail(made.out, 5)}`, true);
      const checkout = git(clone, 'checkout', '--quiet', '-B', 'pi-self', running());
      if (!checkout.ok) return reply(`git checkout ${running().slice(0, 8)} failed: ${tail(checkout.out, 5)}`, true);
      try { linkModules(runningPiDir, path.join(clone, 'agents', 'pi')); } catch (error) { return reply(error.message, true); }
    }
    const head = git(clone, 'rev-parse', 'HEAD').out;
    return reply([
      `Your own code is in ${path.join(clone, 'agents', 'pi')} (git branch pi-self, HEAD ${head.slice(0, 8)}; running ${running().slice(0, 8)}).`,
      'Edit only agents/pi/ (not its package.json or lockfile), run `npm test` there, and commit. Then call self_update with action "relaunch".',
      'Relaunch restarts only this chat\'s pi process on that commit; the turn resumes after it. It never deploys Feather.',
    ].join('\n'));
  }

  async function relaunch(commit) {
    if (!shipped) return reply('Self-update is not available: this pi does not run from a Feather release.', true);
    if (!fs.existsSync(path.join(clone, '.git'))) return reply('Call self_update with action "worktree" first.', true);
    const resolved = git(clone, 'rev-parse', '--verify', `${commit || 'HEAD'}^{commit}`);
    if (!resolved.ok) return reply(`Unknown commit ${commit}.`, true);
    const sha = resolved.out;
    if (sha === running()) return reply(`Already running ${sha.slice(0, 8)}.`);
    const state = readState(sessionDir);
    if (state.bad[sha]) return reply(`${sha.slice(0, 8)} failed before: ${state.bad[sha]}. Fix it in a new commit.`, true);
    const changed = git(clone, 'diff', '--name-only', running(), sha);
    if (!changed.ok) return reply(`git diff failed: ${tail(changed.out, 5)}`, true);
    const files = changed.out.split('\n').filter(Boolean);
    const outside = files.filter(file => !file.startsWith('agents/pi/'));
    if (outside.length) return reply(`Refused: the commit changes files outside agents/pi/: ${outside.slice(0, 10).join(', ')}.`, true);
    const deps = files.filter(file => /^agents\/pi\/(package\.json|package-lock\.json)$/.test(file));
    if (deps.length) return reply(`Refused: the commit changes ${deps.join(' and ')}. New dependencies need a Feather deploy by a person.`, true);
    if (!files.length) return reply(`${sha.slice(0, 8)} has no changes to agents/pi/ from the running code.`, true);

    // Export the commit and test it there.
    const target = piDirFor(sessionDir, sha);
    fs.mkdirSync(codeRoot(sessionDir), { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(codeRoot(sessionDir), '.staging-'));
    try {
      const archive = run('bash', ['-c', 'git -C "$1" archive "$2" agents/pi | tar -x -C "$3"', 'archive', clone, sha, staging]);
      if (!archive.ok) return reply(`Export failed: ${tail(archive.out, 5)}`, true);
      linkModules(runningPiDir, path.join(staging, 'agents', 'pi'));
      const tests = run('npm', ['test', '--silent'], { cwd: path.join(staging, 'agents', 'pi'), env: testEnv(env), timeout: testTimeoutMs });
      if (!tests.ok) return reply(`Refused: npm test failed${tests.error ? ` (${tests.error.code || tests.error.message})` : ''}.\n${tail(tests.out)}`, true);
      fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true });
      fs.renameSync(staging, path.dirname(path.dirname(target)));
    } catch (error) {
      return reply(`Relaunch failed: ${error.message}`, true);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const log = git(clone, 'log', '--oneline', '--no-decorate', `${running()}..${sha}`, '--', 'agents/pi').out;
    const stat = git(clone, 'diff', '--shortstat', running(), sha).out;
    const keep = new Set([sha, state.good, running()].filter(Boolean));
    for (const dir of fs.readdirSync(codeRoot(sessionDir))) if (SHA.test(dir) && !keep.has(dir)) fs.rmSync(path.join(codeRoot(sessionDir), dir), { recursive: true, force: true });
    writeState(sessionDir, {
      ...state,
      base: shipped,
      candidate: sha,
      previous: running(),
      last: { kind: 'relaunch', sha, from: running(), changes: [log, stat].filter(Boolean).join('\n').slice(0, 4000), at: new Date().toISOString() },
    });
    // The process ends inside this call; the launcher starts the new code and
    // the turn resumes there. The new process reports the change in the chat.
    exit(RELAUNCH_EXIT_CODE);
    return new Promise(() => {});
  }

  function status() {
    const state = readState(sessionDir);
    return reply(JSON.stringify({ running: running(), shipped, good: state.good || null, candidate: state.candidate || null, last: state.last || null, failed: state.bad }, null, 2));
  }

  return defineTool({
    name: 'self_update',
    description: 'Change your own code (agents/pi in the Feather repo) and restart on it. "worktree" gives you your own git clone at the running commit; edit agents/pi there, run its tests, commit. "relaunch" tests that commit and restarts only your process on it: your turn resumes, and a start that fails rolls back by itself. "status" shows what runs. Only agents/pi may change, never its dependencies. Never deploy Feather (no refeather).',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('worktree'), Type.Literal('relaunch'), Type.Literal('status')]),
      commit: Type.Optional(Type.String({ description: 'For relaunch: a commit in your clone; default HEAD' })),
    }),
    async execute({ action, commit }, api, context) {
      // Only the chat itself restarts its process, never a subagent.
      if (api && await api.commit(async tx => !!(await tx.conversation(api.conversationId))?.owner, context)) return reply('A subagent cannot use self_update.', true);
      if (action === 'worktree') return worktree();
      if (action === 'relaunch') return relaunch(commit);
      return status();
    },
  });
}

/** The message main.js posts after a relaunch or rollback, or null. */
export function relaunchReport(sessionDir, runningSha) {
  const { last } = readState(sessionDir);
  if (!last) return null;
  const short = sha => (sha ? sha.slice(0, 8) : 'the shipped code');
  if (last.kind === 'relaunch' && last.sha === runningSha) {
    return { requestId: `relaunch:${last.sha}:${last.at}`, text: `[self_update] Relaunched on ${short(last.sha)} (was ${short(last.from)}). Changes:\n${last.changes || '(none listed)'}\nTell the user what changed.` };
  }
  if (last.kind === 'rollback') {
    return { requestId: `rollback:${last.sha}:${last.at}`, text: `[self_update] ${short(last.sha)} failed to start (${last.reason}). Rolled back to ${short(last.to)}. Tell the user, and fix it before another relaunch.` };
  }
  return null;
}

export const defaultRepo = (env = process.env) => env.FEATHER_PI_REPO || path.join(os.homedir(), 'feather');
