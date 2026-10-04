// Code mode (spec: pi-optchat-agent.md, Shape). The model gets one tool,
// `codemode`, and writes JavaScript that calls the real tools as
// `await tools.<name>(args)` inside @earendil-works/pi-codemode's QuickJS
// sandbox. The sandbox can reach nothing but those tools; only the script's
// output and return value enter the model context.
//
// Nested calls run the same pi-durable tool registrations the plain path
// offers, with the outer call's api (env, cwd) and a context that aborts when
// the script ends. Their arguments are checked against the tool's schema, as
// the Harness does for direct calls. The codemode call itself is not replayed
// after a crash (replay "unsafe"), because its script may have written files.
//
// FEATHER_PI_CODEMODE=off offers the tools directly instead (the fallback).
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { withAbortSignal } from '@earendil-works/chord/context';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { CodemodeSandbox, renderDeclarations } from '@earendil-works/pi-codemode';

export const CODEMODE_TIMEOUT_MS = 300_000;
export const CODEMODE_MEMORY_BYTES = 256 * 1024 * 1024;
export const CODEMODE_RESULT_CHARS = 50_000;
export const NESTED_OUTPUT_CHARS = 100_000;

export function codemodeEnabled(env = process.env) {
  return !/^(0|off|false|no|plain)$/i.test(String(env.FEATHER_PI_CODEMODE ?? '').trim());
}

/** Keep the head and tail of a long text. */
export function capMiddle(text, cap) {
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 60) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

const textOf = content => (Array.isArray(content) ? content : [])
  .map(block => (block?.type === 'text' ? block.text : block?.type === 'image' ? '(image omitted)' : ''))
  .filter(Boolean)
  .join('\n');

const notes = diagnostics => diagnostics
  .filter(diagnostic => diagnostic?.message)
  .map(diagnostic => `[${diagnostic.severity || 'info'}: ${diagnostic.message}]`)
  .join('\n');

function firstError(schema, args) {
  for (const error of Value.Errors(schema, args)) return `${error.instancePath || '(arguments)'} ${error.message}`;
  return 'does not match the schema';
}

/** One registration as a sandbox tool, bound to the outer call's api and context. */
function nestedTool(registration, api, context) {
  return {
    name: registration.name,
    description: registration.description,
    inputSchema: registration.parameters,
    outputSchema: { type: 'string' },
    async execute(rawArgs, { signal }) {
      const args = registration.prepareArguments ? registration.prepareArguments(rawArgs) : rawArgs;
      if (!Value.Check(registration.parameters, args)) {
        throw new Error(`${registration.name}: invalid arguments: ${firstError(registration.parameters, args)}`);
      }
      let output = '';
      const diagnostics = [];
      // The outer api (its methods bound to it), with output, diagnostics
      // and details kept per call.
      const own = {
        output(chunk) {
          output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (output.length > 2 * NESTED_OUTPUT_CHARS) output = output.slice(-NESTED_OUTPUT_CHARS);
        },
        diagnostic(diagnostic) { diagnostics.push(diagnostic); },
        async details() {},
      };
      const nestedApi = new Proxy(api, {
        get(target, key) {
          if (Object.hasOwn(own, key)) return own[key];
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let result;
      try {
        result = await registration.execute(args, nestedApi, withAbortSignal(signal, context));
      } catch (error) {
        const tail = capMiddle(output, NESTED_OUTPUT_CHARS);
        throw new Error([`${registration.name}: ${error?.message || error}`, tail, notes(diagnostics)].filter(Boolean).join('\n'));
      }
      const body = result?.content ? textOf(result.content) : capMiddle(output, NESTED_OUTPUT_CHARS);
      const all = [...diagnostics, ...(result?.diagnostics || [])];
      const full = [body, notes(all)].filter(Boolean).join('\n');
      if (result?.isError) throw new Error(`${registration.name}: ${full || 'failed'}`);
      return full;
    },
  };
}

const INTRO = `Run JavaScript in a sandbox. It is the body of an async function: use top-level await and return. Call tools as \`await tools.<name>(args)\`; each one returns a string and throws an Error when it fails (catch it to go on). Show results with text(value) or console.log(value), or return a value. Only that output reaches you, so filter and summarize inside the script, and do several steps in one script when you can. There is no fetch, require, process or timer in the sandbox: use the tools. A script stops after ${CODEMODE_TIMEOUT_MS / 1000} s.`;

/** The `codemode` tool over `registrations`. */
export function createCodemodeTool(registrations, { timeoutMs = CODEMODE_TIMEOUT_MS, memoryLimitBytes = CODEMODE_MEMORY_BYTES } = {}) {
  const declarations = renderDeclarations({
    tools: registrations.map(registration => ({
      name: registration.name,
      description: registration.description,
      inputSchema: registration.parameters,
      outputSchema: { type: 'string' },
      execute: () => undefined,
    })),
  });
  return defineTool({
    name: 'codemode',
    description: `${INTRO}\n\n${declarations}`,
    parameters: Type.Object({ code: Type.String({ description: 'JavaScript: the body of an async function' }) }),
    async execute({ code }, api, context) {
      const sandbox = new CodemodeSandbox({
        tools: registrations.map(registration => nestedTool(registration, api, context)),
        timeoutMs,
        memoryLimitBytes,
      });
      let result;
      try {
        result = await sandbox.execute(code, { signal: context?.abortSignal });
      } finally {
        await sandbox.close().catch(() => {});
      }
      const content = [];
      let texts = [];
      const flush = () => { if (texts.length) content.push({ type: 'text', text: texts.join('\n') }); texts = []; };
      for (const item of result.output) {
        if (item.type === 'text') texts.push(item.text);
        else { flush(); content.push(item); }
      }
      if (result.ok && result.value !== undefined) texts.push(`return: ${typeof result.value === 'string' ? result.value : JSON.stringify(result.value)}`);
      if (!result.ok) texts.push(`${result.error.kind} error: ${result.error.stack || result.error.message}`);
      flush();
      for (const block of content) if (block.type === 'text') block.text = capMiddle(block.text, CODEMODE_RESULT_CHARS);
      if (!content.length) content.push({ type: 'text', text: '(no output)' });
      const calls = result.calls.map(call => ({ name: call.name, status: call.status, ms: Math.round(call.durationMs) }));
      return { content, isError: !result.ok, details: { calls } };
    },
  });
}

/** An extension that offers only `codemode`, with `registrations` inside it. */
export function createCodemodeExtension(registrations, options) {
  return defineExtension({ name: 'codemode', tools: [createCodemodeTool(registrations, options)] });
}
