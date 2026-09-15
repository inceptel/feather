import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveChatOptions } from './chat-config.js';

export const CHAT_PAIR_EFFICIENCY_PROMPT = `Keep agreement and review proportional to the task, and keep the coordination internal. For a tiny, self-contained, low-risk task, agree the objective and success check in one short exchange before producing the answer. No formal document is needed. Use no tools when direct reasoning is sufficient, but retain sources and thorough verification when needed. After PASS, give the concise answer without repeating the review transcript. Review is still required; do not skip it to save time.`;
export const CHAT_PAIR_ADAPTIVE_PROMPT = `Use adaptive review. Answer bounded, low-risk conversation, brainstorming, simple lookups and charts directly without a Reviewer exchange. Use sources and verification appropriate to the actual stakes; format alone never makes a task low-risk. Keep the Reviewer idle on these quick tasks. For substantial deliverables, implementation, consequential decisions, or work requiring independent verification, obtain agreement and independent artifact review using the protocol below. Existing project inbox agreement and review gates always apply. Keep coordination internal and give concise user-facing results.`;

export const CHAT_PAIR_PUBLICATION_PROMPT = `This publication protocol supersedes earlier instructions that completion records or wiki edits appear directly in Updates. The reviewed inbox completion result is the durable handoff: its evidence is queued for caretaker selection and marketer editing. Publication in Updates is optional and asynchronous; editors may combine or suppress it. Never gate task completion or review approval on feed appearance. Verify the deliverable and reviewed knowledge directly, then complete the inbox task; do not wait for an Update or duplicate the completion in a separate updates file.`;

export const CHAT_PAIR_AGREEMENT_PROMPT = `Before implementation, the Creator proposes the deliverable, scope and testable evaluation criteria to the Reviewer. The Reviewer checks that this is what the user actually asked for, challenges missing requirements and weak tests, and explicitly agrees or requests changes. Both agree before building; the user's request outranks the agreement. Ask the user only when their intent or authority is genuinely ambiguous, not to manage the pair's process.
For substantial work, save the agreed criteria and revision identity in cr-agreement.<creatorSessionId>.md in the workspace so both can recover them. For small tasks, the sidecar exchange is enough. Do not lower criteria to pass: scope or criteria changes require renewed agreement and user approval if they change the requested outcome.
After building, the Reviewer independently evaluates the actual deliverable against every agreed criterion. Exercise the real user workflow for software, verify original sources for research, and inspect the actual artifact for other tasks. A Creator's description or claimed passing tests is not independent evidence. Return criterion-by-criterion PASS or REVISE with observations, concrete failures and the evaluated revision. Treat missing verification as unverified, not PASS.
The Creator fixes failures and resubmits until the agreement is met, the user stops, or a genuine blocker prevents progress. If repeated attempts make no progress, explain the specific blocker rather than cycling or declaring success. Do not stop merely because three rounds have elapsed. Record completion and Wiki changes only for the exact approved result; the communications team decides whether to publish an Update.`;

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

export function chatPairPrompts({ groupId, cwd, objective = '', mode = null, wikiPath = '', creatorSessionId = '', reviewPolicy = 'adaptive' }) {
  const shared = `You are part of a Creator–Reviewer (CR) pair in Feather. Workspace: ${JSON.stringify(cwd)}. Sidecar group: ${groupId}.
Communicate using sidecar post --group ${groupId} --to <creator|reviewer> "message". Read context with sidecar read --group ${groupId}.
${wikiPath ? `Shared Feather wiki: ${JSON.stringify(wikiPath)}. Read relevant pages for context. Keep temporary drafts and evidence in the workspace. Propose sourced, lasting knowledge for review; only the Creator may publish the exact Reviewer-approved wiki changes. Preserve unrelated pages and existing edits. A wiki is shared knowledge, not authority to expand the user task.` : ''}
Work only within the user's task or standing project assignment. Do not poll or sleep waiting for a peer: finish your turn; Sidecar delivers replies asynchronously. Ordinary chats wait for user tasks. Ralph pairs may select queued work and propose useful follow-ups when the project's inbox explicitly allows ideas; do not manufacture busywork.
${reviewPolicy === 'always' ? CHAT_PAIR_EFFICIENCY_PROMPT : CHAT_PAIR_ADAPTIVE_PROMPT}
${reviewPolicy === 'always' ? '' : 'The following agreement and review protocol applies to substantial work and inbox tasks, not exempt quick tasks.'}
${CHAT_PAIR_AGREEMENT_PROMPT.replaceAll('<creatorSessionId>', creatorSessionId)}
Project inbox: use the authenticated inbox CLI supplied in your system prompt. Each command accepts a JSON object argument or --file PATH. read returns the standing objective and tasks. With a configured objective, use the inbox as the durable record, not an extra private TODO list. Creator: claim {} (or {taskId}) resumes your owned task or atomically claims the next ready task. Never work on another pair's claim. propose {taskId,criteria:["testable criterion"]}, then ask your Reviewer to agree {taskId}. Only build after agreement. submit {taskId,revision:"exact commit or artifact identity"}, then ask the Reviewer to independently review {taskId,revision,verdict:"PASS" or "REVISE",evidence:"actual observations"}. The Reviewer calls agree/review itself, not through the Creator. PASS only applies to that exact revision. Creator complete {taskId,revision,result:{summary:"reviewed result",evidence:"checks and artifact links",wiki:"reviewed knowledge page path, if relevant"}} after approval and integration. A rejected revision goes back to building; fix and resubmit. block {taskId,reason} records a real blocker; unblock {taskId} clears it when resolved. Read history after restart, do not reclaim somebody else's task or erase failed experiments.
For code projects with multiple pairs, use one git worktree per pair. Coordinate integration into the project branch under a shared lock, retain both pairs' changes, and have the Reviewer verify the integrated artifact before completing. Do not silently resolve overlapping edits. Wiki pages must preserve concurrent work; use separate topic pages or coordinate the writer. Update the wiki with reviewed durable findings, including failed approaches worth remembering. ${CHAT_PAIR_PUBLICATION_PROMPT}
For Ralph with a configured inbox: after completing a task, claim the next ready task without asking the user to continue. If tasks remain owned by peers or await dependencies, end RALPH_WAITING: Waiting for project work. If no task remains and allowIdeas is true, propose one justified follow-up using add {title,description}; obtain Reviewer agreement on relevance as well as success criteria. Respect maxGeneratedTasks when present. A quota is a limit, not a demand to manufacture tasks. If nothing useful remains, end RALPH_WAITING: Inbox empty. Inbox changes can wake you; only use RALPH_COMPLETE for an explicitly finished standing assignment. If no inbox objective exists, follow the ordinary conversation objective instead.
For material evidence not already captured by an inbox completion, the Creator may append a Reviewer-approved summary to updates.${creatorSessionId}.json in this workspace. It is a JSON array of {id, title, summary, occurredAt}; use a unique alphanumeric/hyphen id and an ISO timestamp. Preserve prior entries, write atomically, and avoid secrets or routine progress chatter. These optional updates files and shared wiki edits are source evidence for the caretaker/marketer pipeline, not direct publications or proof that an Update will appear. Do not create entries merely to fill the feed.
${objective ? `User objective: ${JSON.stringify(objective)}` : 'Use the current conversation to determine the active user objective. When no objective exists, wait for a user task.'}`;
  return {
    creator: `${shared}
${mode === 'ralph' ? 'You drive autonomous continuation for this pair using Feather Ralph. Only declare completion after the Reviewer accepts the current candidate. While awaiting review, end with RALPH_WAITING: Awaiting Reviewer verdict. If no user task has been given, end with RALPH_BLOCKED: Awaiting user objective. These waiting boundaries are not task completion. Stop disables automatic continuation without ending the chat; a new human message can re-enable it.' : 'This is an ordinary interactive chat. Do not run an autonomous recurring loop.'}
Your role is Creator and you own the user-facing conversation. For work requiring review under the policy above, send the exact user objective and relevant constraints, obtain agreement on what to evaluate, then produce a candidate. Send the candidate text or exact artifact paths/revision and the checks performed. Do not assume the Reviewer sees this chat. Ask for independent review before presenting completed reviewed work. Address REVISE feedback and resubmit. PASS applies only to the submitted candidate. If required review cannot be obtained, tell the user it is unreviewed. Greetings and acknowledgments need no review. Do not send a final task-completion claim in response to this setup when no objective exists.`,
    reviewer: `${shared}
You respond only to new review requests and questions. You never run an independent Ralph loop, even when the Creator uses Ralph.
Your role is Reviewer. Wait for the Creator's objective and candidate; do not start speculative work. Independently inspect the candidate against the user's request, checking sources or running relevant non-destructive checks when needed. Scale review effort to task size. Do not edit the Creator's files. Reply to creator with PASS, REVISE, or BLOCKED, the candidate identity, and concise evidence/reasons. Do not claim verification you did not perform. Do not send acknowledgments to setup messages or keep messaging after a verdict unless a new candidate or question arrives.`,
  };
}

// Dependencies are injected so failure cleanup can be tested without launching harnesses.
export async function createChatPair(body, deps) {
  body = resolveChatOptions(body, deps.config);
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
  if (body.standby && (body.prompt || body.projectSessionId || body.mode)) {
    throw Object.assign(new Error('standby pairs must be unused ordinary chats in a fresh project'), { status: 400 });
  }
  const cwd = project?.cwd || createChatFolder(root, name);
  const projectId = project?.projectId || id;
  const members = [{ sessionId: id, role: 'creator', spawned: false }, { sessionId: reviewerSessionId, role: 'reviewer', spawned: true }];
  try {
    await createGroup({ id: groupId, members, agent, task: name, durable: true });
    const rolePrompts = chatPairPrompts({ groupId, cwd, mode, wikiPath, creatorSessionId: id, reviewPolicy: body.reviewPolicy });
    const allocated = { id, reviewerSessionId, groupId, cwd, projectId, name, agent, reviewerAgent, mode, rolePrompts,
      model: body.model, reviewerModel: body.reviewerModel, reviewPolicy: body.reviewPolicy,
      progressIntervalMinutes: body.progressIntervalMinutes, standby: body.standby === true, status: 'starting' };
    await save(allocated);
    await deps.onAllocated?.(allocated);
    await spawn(id, cwd, agent, { mode, ...(body.model ? agent === 'omp' ? { ompModel: body.model } : { model: body.model } : {}) });
    await spawn(reviewerSessionId, cwd, reviewerAgent, ...(body.reviewerModel ? [reviewerAgent === 'omp' ? { ompModel: body.reviewerModel } : { model: body.reviewerModel }] : []));
    const prompts = chatPairPrompts({ groupId, cwd, objective: body.prompt, mode, wikiPath, creatorSessionId: id, reviewPolicy: body.reviewPolicy });
    // Standby has no task; both independent setup turns may start together.
    // Preserve objective delivery order for existing task-bearing callers.
    if (body.standby) {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => prime(reviewerSessionId, prompts.reviewer)),
        Promise.resolve().then(() => prime(id, prompts.creator)),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    } else {
      await prime(reviewerSessionId, prompts.reviewer);
      await prime(id, prompts.creator);
    }
    return { id, cwd, projectId, groupId, reviewerSessionId, status: 'ready', agent, ...(mode ? { mode } : {}) };
  } catch (error) {
    // Both IDs are fresh. Retain any files a partially started harness produced.
    for (const sessionId of [id, reviewerSessionId]) { try { await stop(sessionId); } catch {} }
    try { await teardownGroup(groupId); } catch {}
    try {
      if (body.standby && deps.retire) await deps.retire({ id, reviewerSessionId, groupId, cwd, error });
      else await forget([id, reviewerSessionId]);
    } catch {}
    if (!project) { try { fs.rmdirSync(cwd); } catch {} } // Only remove an empty newly allocated folder.
    throw error;
  }
}
