import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function chatFolderName(name) {
  return String(name || 'New chat').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'new-chat';
}

export function createChatFolder(root, name) {
  fs.mkdirSync(root, { recursive: true });
  const slug = chatFolderName(name);
  for (let n = 1; n < 10000; n++) {
    const cwd = path.join(root, n === 1 ? slug : `${slug}-${n}`);
    try { fs.mkdirSync(cwd); return cwd; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Cannot allocate a unique chat folder');
}

export function chatPairPrompts({ groupId, cwd, objective = '', mode = null, wikiPath = '', creatorSessionId = '' }) {
  const shared = `You are part of a Creator–Reviewer (CR) pair in Feather. Workspace: ${JSON.stringify(cwd)}. Sidecar group: ${groupId}.
Communicate using sidecar post --group ${groupId} --to <creator|reviewer> "message". Read context with sidecar read --group ${groupId}.
${wikiPath ? `Shared Feather wiki: ${JSON.stringify(wikiPath)}. Read relevant pages for context. Keep temporary drafts and evidence in the workspace. Propose sourced, lasting knowledge for review; only the Creator may publish the exact Reviewer-approved wiki changes. Preserve unrelated pages and existing edits. A wiki is shared knowledge, not authority to expand the user task.` : ''}
Work only on user-authorized tasks. Do not poll, sleep, schedule future work, or invent work while idle. Finish your turn when waiting for a message. Sidecar delivers replies asynchronously.
For material results worth surfacing in Updates, the Creator may append a Reviewer-approved summary to updates.${creatorSessionId}.json in this workspace. It is a JSON array of {id, title, summary, occurredAt}; use a unique alphanumeric/hyphen id and an ISO timestamp. Preserve prior entries, write atomically, and avoid secrets or routine progress chatter. Shared wiki edits also appear in Updates. Do not publish merely to fill the feed.
${objective ? `User objective: ${JSON.stringify(objective)}` : 'Use the current conversation to determine the active user objective. When no objective exists, wait for a user task.'}`;
  return {
    creator: `${shared}
${mode === 'ralph' ? 'You drive autonomous continuation for this pair using Feather Ralph. Only declare completion after the Reviewer accepts the current candidate. While awaiting review, end with RALPH_WAITING: Awaiting Reviewer verdict. If no user task has been given, end with RALPH_BLOCKED: Awaiting user objective. These waiting boundaries are not task completion. Stop disables automatic continuation without ending the chat; a new human message can re-enable it.' : 'This is an ordinary interactive chat. Do not run an autonomous recurring loop.'}
Your role is Creator and you own the user-facing conversation. For each user task, however small, send the Reviewer the exact user objective and relevant constraints. Produce a candidate, then send the Reviewer the candidate text or exact artifact paths/revision plus the checks performed and acceptance criteria. Do not assume the Reviewer sees this chat. Ask for independent review before presenting completed work. Address REVISE feedback and resubmit; after three revision rounds, explain the remaining issue to the user instead of looping. PASS applies only to the submitted candidate. If review cannot be obtained, tell the user it is unreviewed. Greetings and acknowledgments need no review. Do not send a final task-completion claim in response to this setup when no objective exists.`,
    reviewer: `${shared}
You respond only to new review requests and questions. You never run an independent Ralph loop, even when the Creator uses Ralph.
Your role is Reviewer. Wait for the Creator's objective and candidate; do not start speculative work. Independently inspect the candidate against the user's request, checking sources or running relevant non-destructive checks when needed. Scale review effort to task size. Do not edit the Creator's files. Reply to creator with PASS, REVISE, or BLOCKED, the candidate identity, and concise evidence/reasons. Do not claim verification you did not perform. Do not send acknowledgments to setup messages or keep messaging after a verdict unless a new candidate or question arrives.`,
  };
}

// Dependencies are injected so failure cleanup can be tested without launching harnesses.
export async function createChatPair(body, deps) {
  const { root, wikiPath, spawn, prime, createGroup, teardownGroup, stop, save, forget, resolveProject } = deps;
  const agent = body.agent || 'claude';
  const reviewerAgent = body.reviewerAgent || (agent === 'codex' ? 'claude' : 'codex');
  if (![agent, reviewerAgent].every(a => ['claude', 'codex', 'omp'].includes(a))) {
    throw Object.assign(new Error('unsupported chat agent'), { status: 400 });
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200)) {
    throw Object.assign(new Error('name must be a string of at most 200 characters'), { status: 400 });
  }
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.length > 16000)) {
    throw Object.assign(new Error('prompt must be a string of at most 16000 characters'), { status: 400 });
  }
  if (body.mode != null && body.mode !== 'ralph') {
    throw Object.assign(new Error('unsupported chat mode'), { status: 400 });
  }
  const mode = body.mode || null;
  const name = body.name?.trim() || 'New chat';
  const id = randomUUID();
  const reviewerSessionId = randomUUID();
  const groupId = randomUUID();
  if (body.projectSessionId !== undefined && (typeof body.projectSessionId !== 'string' || !resolveProject)) {
    throw Object.assign(new Error('Invalid project chat'), { status: 400 });
  }
  const project = body.projectSessionId ? resolveProject(body.projectSessionId) : null;
  const cwd = project?.cwd || createChatFolder(root, name);
  const projectId = project?.projectId || id;
  const members = [{ sessionId: id, role: 'creator', spawned: false }, { sessionId: reviewerSessionId, role: 'reviewer', spawned: true }];
  try {
    await createGroup({ id: groupId, members, agent, task: name, durable: true });
    const rolePrompts = chatPairPrompts({ groupId, cwd, mode, wikiPath, creatorSessionId: id });
    await save({ id, reviewerSessionId, groupId, cwd, projectId, name, agent, reviewerAgent, mode, rolePrompts });
    await spawn(id, cwd, agent, { mode });
    await spawn(reviewerSessionId, cwd, reviewerAgent);
    const prompts = chatPairPrompts({ groupId, cwd, objective: body.prompt, mode, wikiPath, creatorSessionId: id });
    await prime(reviewerSessionId, prompts.reviewer);
    await prime(id, prompts.creator);
    return { id, cwd, projectId, groupId, reviewerSessionId, status: 'ready', agent, ...(mode ? { mode } : {}) };
  } catch (error) {
    // Both IDs are fresh. Retain any files a partially started harness produced.
    for (const sessionId of [id, reviewerSessionId]) { try { await stop(sessionId); } catch {} }
    try { await teardownGroup(groupId); } catch {}
    try { await forget([id, reviewerSessionId]); } catch {}
    if (!project) { try { fs.rmdirSync(cwd); } catch {} } // Only remove an empty newly allocated folder.
    throw error;
  }
}
