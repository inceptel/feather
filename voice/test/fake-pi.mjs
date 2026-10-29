#!/usr/bin/env node
// Fake `pi --mode rpc` for testing voice-web's worker error handling. The prompt text picks the script:
//   "REFUSE"  → assistant message with stopReason error (safeguard text), then agent_settled
//   "FLAKY"   → error, auto_retry_start, success text, auto_retry_end success, agent_settled
//   "GIVEUP"  → error, auto_retry_end success:false finalError, agent_settled
//   "EMPTYRETRY" → error, retry, an empty (tool-only) message, auto_retry_end success, agent_settled
//   "CONNREF" → retries give up with "connect ECONNREFUSED"
//   "ECHO"    → replies with the whole prompt text
//   other     → plain text reply
// FAKE_SETUP_MS delays new_session, to test stop and follow-up while a session is being set up.
import readline from 'node:readline';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
const msg = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...extra });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  const ok = data => out({ type: 'response', id: c.id, command: c.type, success: true, data });
  if (c.type === 'get_state') return ok({ sessionId: 's' + n, sessionFile: `/tmp/fake-${n}.jsonl`, model: { provider: 'fake', id: 'fake' } });
  if (c.type === 'new_session') { n++; return setTimeout(() => ok({ cancelled: false }), Number(process.env.FAKE_SETUP_MS) || 0); }
  if (c.type === 'switch_session' || c.type === 'set_session_name') return ok({ cancelled: false });
  if (c.type !== 'prompt') return ok({});
  ok({ disposition: 'started' });
  const m = c.message;
  setTimeout(() => {
    out({ type: 'agent_start' });
    if (/REFUSE/.test(m)) {
      const e = 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy. Opus 5.5 safeguards flagged this message [cyber]';
      out({ type: 'message_end', message: msg(e, { stopReason: 'error', errorMessage: e }) });
    } else if (/FLAKY/.test(m)) {
      out({ type: 'message_end', message: msg('529 overloaded', { stopReason: 'error', errorMessage: '529 overloaded' }) });
      out({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '529 overloaded' });
      out({ type: 'message_end', message: msg('Recovered answer.') });
      out({ type: 'auto_retry_end', success: true, attempt: 2 });
    } else if (/GIVEUP/.test(m)) {
      out({ type: 'message_end', message: msg('', { stopReason: 'error', errorMessage: '' }) });
      out({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded after 3 tries' });
    } else if (/EMPTYRETRY/.test(m)) {
      out({ type: 'message_end', message: msg('529 overloaded', { stopReason: 'error', errorMessage: '529 overloaded' }) });
      out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
      out({ type: 'auto_retry_end', success: true, attempt: 2 });
    } else if (/CONNREF/.test(m)) {
      out({ type: 'message_end', message: msg('', { stopReason: 'error', errorMessage: 'connect ECONNREFUSED 127.0.0.1:443' }) });
      out({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'connect ECONNREFUSED 127.0.0.1:443' });
    } else if (/ECHO/.test(m)) out({ type: 'message_end', message: msg(`ECHO: ${m}`) });
    else out({ type: 'message_end', message: msg('Plain answer.') });
    out({ type: 'agent_end' }); out({ type: 'agent_settled' });
  }, 50);
});
