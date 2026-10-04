// Subagents (optchat-spec §9; pi spec phase 4: durable sub-conversations in
// pi's own harness, in place of tmux sidecars). Built on the pi-durable
// background pattern (README "Subagents", example 23).
//
// - spawn(tasks) starts one subagent per task, in parallel, and answers their
//   ids at once. Each subagent is a child conversation owned by an anchor: a
//   background task of the chat, so the chat's turns and idle waits pass it
//   by, and a killed process resumes it like everything else.
// - A subagent's first message is the view of the spawning run, then its
//   task. Its system prompt is SUBAGENT, VIEW_DOC and the user's
//   instructions. It has the chat's model, cwd and tools, with zoom and date,
//   but no spawn or tell, and no memory view of its own. Its tool calls stay
//   in its own conversation, never in the chat's memory log.
// - When all subagents of one spawn finish, a background reporter task posts
//   their reports to the chat as ONE message, "[id] report" each. It steers a
//   running turn (between tool calls) or starts a new one. Request ids make
//   each delivery happen once, across restarts.
// - tell(id, message) reaches a running subagent between its tool calls.
//
// FEATHER_PI_SUBAGENTS=off leaves both tools out.
import { Type } from 'typebox';
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, LiveDoc } from '@earendil-works/pi-durable';
import { SUBAGENT, VIEW_DOC } from './optchat/prompts.js';

export const MAX_TASKS = 8;
const START_WAIT_MS = 2000;

export function subagentsEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.FEATHER_PI_SUBAGENTS ?? '').trim());
}

/** The chat's subagents: id → {conversationId, task}, and one reporter per spawn. */
export const Subagents = defineDoc({
  kind: 'feather.pi.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, agents: {}, reporters: [] }),
});

const finish = status => (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: status === 'completed' ? { status, result: null } : { status } }), context);

// Owns a spawn's subagents and finishes at once.
const Anchor = defineTask({
  name: 'feather.pi.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: { done: finish('completed') },
  abort: finish('aborted'),
});

const textOf = content => (typeof content === 'string' ? content : (content || []).filter(block => block?.type === 'text').map(block => block.text).join(''));

/** The first message of a subagent: the view, then its task. */
export function firstMessage(view, task) {
  return view ? `${view}\n\nYour task:\n${task}` : task;
}

// Delivers a spawn's tasks, waits for every answer, then reports them all to
// the chat as one message.
const Reporter = defineTask({
  name: 'feather.pi.subagent-reporter',
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    async deliver(reporter, runtime, context) {
      const { view, items } = reporter.input;
      const settled = await Promise.all(items.map(async item => {
        const child = await runtime.conversation(item.conversationId, context);
        const submission = await child.submit({ type: 'input', content: firstMessage(view, item.task), requestId: `spawn:${reporter.id}:${item.id}` }, context);
        return submission.wait(context);
      }));
      await runtime.commit(async tx => {
        const parts = [];
        for (let k = 0; k < items.length; k++) {
          const result = settled[k];
          let text;
          if (result.status === 'unanswered') text = `(no report: ${result.reason || 'stopped'})`;
          else if (result.type !== 'input' || result.answer === undefined) text = '(no report)';
          else text = textOf((await tx.entry(AssistantEntry, result.answer))?.model?.[0]?.content).trim() || '(empty report)';
          parts.push(`[${items[k].id}] ${text}`);
        }
        return { status: 'running', checkpoint: { phase: 'report', report: parts.join('\n\n') } };
      }, context);
    },
    async report(reporter, runtime, context) {
      const chat = await runtime.conversation(runtime.conversationId, context);
      await chat.submit({ type: 'input', content: reporter.state.checkpoint.report, whenBusy: 'steer', requestId: `spawn-report:${reporter.id}` }, context);
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    },
  },
  abort: finish('aborted'),
});

const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

/** True when the calling conversation is itself a subagent. */
async function isSubagent(api, context) {
  return api.commit(async tx => !!(await tx.conversation(api.conversationId))?.owner, context);
}

/**
 * spawn and tell. `remove()` lists the extensions a subagent must not have;
 * `view()` gives the view of the current run (undefined with memory off).
 */
export function createSubagentTools({ remove = () => [], view = () => undefined } = {}) {
  const spawn = defineTool({
    name: 'spawn',
    description: `Start one subagent per task, in parallel (at most ${MAX_TASKS}). Answers their ids at once. Each subagent gets the view and its task, with your tools and folder; give each task every detail it needs. When all of them finish, their reports reach you as one message, "[id] report" each. Never wait or poll for it.`,
    parameters: Type.Object({ tasks: Type.Array(Type.String({ description: 'One complete task' }), { minItems: 1, maxItems: MAX_TASKS }) }),
    // A rerun after a crash could start the subagents twice.
    replay: 'unsafe',
    async execute({ tasks }, api, context) {
      if (await isSubagent(api, context)) return reply('A subagent cannot spawn subagents. Do the work yourself.', true);
      const agent = await api.agent(context);
      const instructions = [SUBAGENT, VIEW_DOC, agent.instructions].filter(Boolean).join('\n\n');
      const ids = await api.commit(async tx => {
        const state = await tx.doc(Subagents, api.conversationId);
        const background = { ownership: { kind: 'conversation' }, background: true };
        const anchor = await tx.createTask(Anchor, null, background);
        const items = [];
        for (const task of tasks) {
          const id = `s${state.next++}`;
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          await configure(tx, child.id, { extensions: { remove: remove() }, instructions });
          state.agents[id] = { conversationId: child.id, task: task.slice(0, 500) };
          items.push({ id, conversationId: child.id, task });
        }
        state.reporters.push(await tx.createTask(Reporter, { view: view() || '', items }, background));
        return items.map(item => item.id);
      }, context);
      return { content: [{ type: 'text', text: `Started ${ids.map(id => `[${id}]`).join(' ')}. Their reports reach you as one message when all finish.` }], details: { ids } };
    },
  });

  const tell = defineTool({
    name: 'tell',
    description: 'Send a message to a running subagent; it reads it between its tool calls.',
    parameters: Type.Object({
      id: Type.String({ description: 'Subagent id, such as s1' }),
      message: Type.String(),
    }),
    replay: 'unsafe',
    async execute({ id, message }, api, context) {
      if (await isSubagent(api, context)) return reply('A subagent cannot message other subagents.', true);
      const key = String(id).replace(/^\[|\]$/g, '');
      const state = await api.snapshot(Subagents, api.conversationId, context);
      const agent = state && Object.hasOwn(state.agents, key) ? state.agents[key] : undefined;
      if (!agent) return reply(`No subagent ${key}.`, true);
      // Right after spawn, the reporter may not have started the run yet.
      let running = false;
      for (let waited = 0; ; waited += 50) {
        running = !!(await api.snapshot(LiveDoc, agent.conversationId, context))?.run;
        if (running || waited >= START_WAIT_MS) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!running) return reply(`[${key}] has finished; its report is in the chat or on its way. Spawn a new subagent for more work.`, true);
      const child = await api.conversation(agent.conversationId, context);
      await child.submit({ type: 'input', content: message, whenBusy: 'steer' }, context);
      return reply(`Sent to [${key}].`);
    },
  });
  return [spawn, tell];
}

/** The task definitions; installed so a restart resumes pending reporters. */
export const subagentTasks = [Anchor, Reporter];

/** Plain mode: an extension that offers spawn and tell directly. */
export function createSubagentExtension({ remove = () => [], view } = {}) {
  let extension;
  extension = defineExtension({ name: 'subagent', tasks: subagentTasks, tools: createSubagentTools({ remove: () => [...remove(), extension], view }) });
  return extension;
}

/** Code mode: spawn and tell live in codemode; this carries their tasks. */
export function createSubagentTaskExtension() {
  return defineExtension({ name: 'subagent-tasks', tasks: subagentTasks });
}
