#!/usr/bin/env node
// Supplemental verifier for a proof launched with an older runner.
// Usage: node test/live/verify-cr-inbox-proof.mjs /tmp/feather-cr-proof-XXXXXX
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { once } from 'node:events';
import { run as runBrowserChecks } from './tic-tac-toe-check.mjs';

const SEEDED_TASK_IDS = new Set(['board', 'win-rules', 'reset', 'scores', 'responsive', 'keyboard']);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function commitFromRevision(revision) {
  return typeof revision === 'string' ? revision.match(/^(?:main@)?([0-9a-f]{40})$/i)?.[1] : undefined;
}
function assertIntegratedRevision(cwd, task) {
  assert.equal(task.review?.verdict, 'PASS', `${task.id}: final review did not pass`);
  assert.equal(task.review.revision, task.revision, `${task.id}: review does not match final revision`);
  const commit = commitFromRevision(task.revision);
  assert.ok(commit, `${task.id}: revision is not a full commit identity: ${task.revision}`);
  execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, stdio: 'ignore' });
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd, stdio: 'ignore' });
}

export async function verifyRetainedProof(root) {
  root = path.resolve(root);
  const receipt = readJson(path.join(root, 'receipt.json'));
  assert.equal(receipt.root, root, 'receipt root does not match requested retained run');
  assert.ok(receipt.completedAt, 'proof is still running or did not reach completion');
  assert.ok(!receipt.error, `original proof failed: ${receipt.error}`);
  assert.equal(receipt.pairs?.length, 2, 'proof must contain two CR pairs');
  const projectId = receipt.pairs[0].projectId;
  const cwd = receipt.pairs[0].cwd;
  assert.ok(receipt.pairs.every(pair => pair.projectId === projectId && pair.cwd === cwd), 'pairs do not share one project');
  const project = readJson(path.join(root, 'state', 'project-inboxes', `${projectId}.json`));
  assert.equal(project.tasks.length, 7, 'proof must finish six seeded tasks and one generated idea');
  assert.ok(project.tasks.every(task => task.status === 'done'), 'not every task is done');

  const seeded = project.tasks.filter(task => SEEDED_TASK_IDS.has(task.id));
  const generated = project.tasks.filter(task => !SEEDED_TASK_IDS.has(task.id));
  assert.equal(seeded.length, 6, 'one or more seeded tasks is missing');
  assert.ok(seeded.every(task => task.source === 'human'), 'all seeded tasks must retain human source');
  assert.equal(generated.length, 1, 'proof must contain exactly one generated task');
  assert.equal(generated[0].source, 'agent', 'the seventh task must be agent-generated');

  for (const task of project.tasks) {
    assertIntegratedRevision(cwd, task);
    const pair = receipt.pairs.find(pair => pair.id === task.owner);
    assert.ok(pair, `${task.id}: owner is not a registered pair`);
    const agreement = task.history.findIndex(event => event.action === 'agree');
    const submission = task.history.findIndex(event => event.action === 'submit');
    assert.ok(agreement >= 0 && agreement < submission, `${task.id}: no agreement before submission`);
    assert.equal(task.history[agreement].sessionId, pair.reviewerSessionId, `${task.id}: agreement was not independent`);
    const reviews = task.history.filter(event => event.action === 'review');
    assert.ok(reviews.length && reviews.every(event => event.sessionId === pair.reviewerSessionId), `${task.id}: review came from wrong role`);
    assert.equal(reviews.at(-1).verdict, 'PASS', `${task.id}: final historical review is not PASS`);
    assert.equal(reviews.at(-1).revision, task.revision, `${task.id}: historical approval does not match completion`);
  }
  const ideaAuthor = generated[0].history.find(event => event.action === 'add')?.sessionId;
  assert.ok(receipt.pairs.some(pair => pair.id === ideaAuthor), 'follow-up was not authored by one of the Creators');

  const wikiRoot = fs.realpathSync(path.join(root, 'home', 'wiki'));
  for (const task of project.tasks) {
    assert.ok(task.result?.wiki, `${task.id}: completion does not cite wiki knowledge`);
    const file = path.resolve(cwd, task.result.wiki);
    assert.ok(fs.existsSync(file), `${task.id}: cited wiki page does not exist: ${file}`);
    const realFile = fs.realpathSync(file);
    assert.ok(realFile.startsWith(wikiRoot + path.sep), `${task.id}: cited knowledge is outside the isolated wiki`);
    assert.ok(fs.statSync(realFile).isFile(), `${task.id}: cited wiki path is not a file`);
    assert.ok(fs.readFileSync(realFile, 'utf8').trim().length > 100, `${task.id}: cited wiki page is not substantive`);
  }

  const feed = readJson(path.join(root, 'feed.json'));
  assert.ok(project.tasks.every(task => (feed.items || []).some(item =>
    item.evidenceId === `inbox:${projectId}:${task.id}`)), 'feed is missing one or more task updates');
  assert.deepEqual(new Set(project.tasks.map(task => task.owner)), new Set(receipt.pairs.map(pair => pair.id)), 'both registered pairs must contribute');
  assert.ok(project.tasks.every(task => task.history.filter(event => event.action === 'claim').length === 1), 'duplicate task claims');
  assert.ok(project.tasks.find(task => task.id === 'win-rules').history.some(event => event.action === 'review' && event.verdict === 'REVISE'), 'seeded defect was not rejected');
  for (const check of ['restartOwnership', 'stop', 'humanResume', 'sevenCompleted']) {
    assert.equal(receipt.checks?.[check], true, `original proof check failed: ${check}`);
  }

  const app = express(); app.use(express.static(cwd));
  const site = app.listen(0, '127.0.0.1'); await once(site, 'listening');
  let browser;
  try {
    const output = path.join(root, 'supplemental-browser');
    browser = await runBrowserChecks(`http://127.0.0.1:${site.address().port}`, output);
    assert.equal(browser.passed, true, `supplemental browser checks failed; see ${path.join(output, 'report.json')}`);
  } finally {
    site.close(); site.closeAllConnections(); await once(site, 'close');
  }
  const result = { root, projectId, verifiedAt: new Date().toISOString(), passed: true,
    checks: { restartOwnership: true, stop: true, humanResume: true, sevenCompleted: true,
      twoPairsWorked: true, noDuplicateClaims: true, reviewerRejectedDefect: true,
      exactlyOneGeneratedIdea: true, independentAgreementAndReview: true,
      integratedRevisions: true, wikiEvidence: true, updates: true, browser: true },
    tasks: project.tasks.length, generatedTaskId: generated[0].id,
    revisionsVerified: project.tasks.length, wikiCitationsVerified: project.tasks.length,
    browserChecks: browser.tests.length };
  fs.writeFileSync(path.join(root, 'supplemental-receipt.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node test/live/verify-cr-inbox-proof.mjs RETAINED_ROOT');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await verifyRetainedProof(root), null, 2)); }
    catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
  }
}
