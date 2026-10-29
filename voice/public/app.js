// Voice page client: WebRTC to OpenAI Realtime; tool calls become parallel Feather tasks on the server.
const $ = id => document.getElementById(id);
const log = $('log'), talk = $('talk'), statusEl = $('status'), poolEl = $('pool'), hint = $('hint'), tasksEl = $('tasks');

let pc = null, dc = null, micStream = null, audioCtx = null, levelTimer = null, wakeLock = null;
let responding = false, muted = false, speakerOff = false;
const pendingReports = [];           // results waiting for the voice model to be free
const partial = { you: new Map(), ai: new Map() }; // item_id -> element
const tasks = new Map();             // id -> latest task view from the server

function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = 'pill ' + cls; }
function scroll() { log.scrollTop = log.scrollHeight; }

function addMsg(kind, text, opts = {}) {
  $('empty')?.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + kind + (opts.partial ? ' partial' : '');
  if (kind === 'fx') {
    const who = document.createElement('div'); who.className = 'who'; who.textContent = opts.who || 'Feather';
    el.append(who, document.createTextNode(text));
  } else el.textContent = text;
  log.append(el); scroll();
  return el;
}

// ---------- debug ----------
// Tool calls are always recorded; the Debug button shows them in the log. Each one is also
// appended to the server's toolcalls.jsonl so wrong calls can be reviewed later.

let lastHeard = '';                  // the user's latest words, to pair with the calls they caused
function dbg(title, data, bad = false) {
  const el = addMsg('dbg', '');
  if (bad) el.classList.add('bad');
  const b = document.createElement('b'); b.textContent = title; el.append(b);
  if (data !== undefined) { const pre = document.createElement('pre'); pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 1); el.append(pre); }
  return el;
}
function logCall(entry) { fetch('api/debug/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) }).catch(() => {}); }

function setDebug(on) {
  document.body.classList.toggle('debug', on);
  $('debugBtn').classList.toggle('on', on);
  try { localStorage.setItem('voiceDebug', on ? '1' : ''); } catch {}
  if (on) scroll();
}
try { setDebug(!!localStorage.getItem('voiceDebug')); } catch {}
$('debugBtn').onclick = () => setDebug(!document.body.classList.contains('debug'));

$('toolsBtn').onclick = async () => {
  const body = $('toolsBody'); $('toolsDlg').showModal();
  try {
    const d = await (await fetch('api/debug')).json();
    body.replaceChildren();
    const add = (tag, text) => { const e = document.createElement(tag); e.textContent = text; body.append(e); return e; };
    add('p', `${d.model} · voice ${d.voice} · workers ${d.agent}`);
    for (const t of d.tools) {
      add('h3', t.name);
      add('p', t.description);
      const props = Object.entries(t.parameters?.properties || {});
      if (props.length) {
        const ul = add('ul', '');
        for (const [k, v] of props) {
          const li = document.createElement('li'); const c = document.createElement('code');
          c.textContent = k + (t.parameters.required?.includes(k) ? '' : '?'); li.append(c, ` (${v.type}) ${v.description || ''}`); ul.append(li);
        }
      }
    }
    add('h3', 'instructions');
    add('pre', d.instructions);
  } catch (e) { body.textContent = 'Could not load: ' + e.message; }
};
$('toolsClose').onclick = () => $('toolsDlg').close();

// ---------- server events (Feather tasks) ----------

function renderPool(p) {
  if (!p.ready) { poolEl.textContent = 'Feather starting'; poolEl.className = 'pill bad'; return; }
  const running = [...tasks.values()].filter(t => t.status === 'running').length;
  const queued = [...tasks.values()].filter(t => t.status === 'queued').length;
  if (running || queued) { poolEl.textContent = `Feather ${running} working${queued ? ` · ${queued} queued` : ''}`; poolEl.className = 'pill busy'; }
  else { poolEl.textContent = 'Feather ready'; poolEl.className = 'pill live'; }
}
let lastPool = { ready: 0 };

function card(t) {
  let el = $('task-' + t.id);
  if (!el) {
    el = document.createElement('div'); el.className = 'task'; el.id = 'task-' + t.id;
    el.innerHTML = '<div class="head"><span class="dot"></span><span class="num"></span><span class="req"></span><span class="secs"></span><button class="stop">Stop</button></div><div class="body"><div class="tools"></div><div class="text"></div></div>';
    el.querySelector('.head').onclick = e => { if (!e.target.classList.contains('stop')) el.classList.toggle('open'); };
    el.querySelector('.stop').onclick = () => post('api/stop', { task_id: t.id }).catch(err => addMsg('sys', err.message));
    tasksEl.append(el);
  }
  el.classList.toggle('queued', t.status === 'queued');
  el.querySelector('.num').textContent = '#' + t.id;
  el.querySelector('.req').textContent = t.request;
  if (t.chat && !el.querySelector('.open-chat')) {
    const a = document.createElement('a'); a.className = 'open-chat'; a.textContent = 'Open chat'; a.target = '_blank';
    a.href = '/#' + encodeURIComponent(t.chat); el.querySelector('.body').prepend(a);
  }
  return el;
}

function upsert(t) {
  tasks.set(t.id, { ...(tasks.get(t.id) || {}), ...t });
  const cur = tasks.get(t.id);
  if (cur.status === 'running' || cur.status === 'queued') {
    const el = card(cur);
    if (t.tools) el.querySelector('.tools').replaceChildren(...t.tools.map(x => { const d = document.createElement('div'); d.textContent = '› ' + x; return d; }));
    if (t.text != null) el.querySelector('.text').textContent = t.text;
    if (cur.status === 'running') cur.since = Date.now() - (cur.seconds || 0) * 1000;
  } else $('task-' + t.id)?.remove();
  renderPool(lastPool);
}

setInterval(() => {
  for (const t of tasks.values()) if (t.status === 'running' && t.since) {
    const el = $('task-' + t.id); if (el) el.querySelector('.secs').textContent = Math.round((Date.now() - t.since) / 1000) + 's';
  }
}, 1000);

function connectEvents() {
  const es = new EventSource('api/events');
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    switch (ev.type) {
      case 'hello':
        tasksEl.innerHTML = ''; tasks.clear();
        lastPool = ev; (ev.tasks || []).forEach(upsert); renderPool(ev); break;
      case 'workers': lastPool = ev; renderPool(ev); break;
      case 'task_queued': case 'task_start': upsert(ev); break;
      case 'task_text_reset': { const el = $('task-' + ev.id); if (el) el.querySelector('.text').textContent = ''; break; }
      case 'task_delta': { const el = $('task-' + ev.id); if (el) el.querySelector('.text').textContent += ev.delta; break; }
      case 'task_tool': {
        const el = $('task-' + ev.id); if (!el) break;
        const d = document.createElement('div'); d.textContent = '› ' + ev.label; el.querySelector('.tools').append(d); break;
      }
      case 'task_note': addMsg('sys', `#${ev.id}: ${ev.text}`); break;
      case 'task_done':
        upsert(ev);
        addMsg('fx', ev.report || (ev.status === 'stopped' ? '(stopped)' : '(no reply)'), { who: `Feather #${ev.id} · ${ev.seconds}s${ev.tools?.length ? ` · ${ev.tools.length} tools` : ''}` });
        reportToVoice(ev);
        break;
    }
  };
  es.onerror = () => { poolEl.textContent = 'Feather …'; poolEl.className = 'pill'; };
}

function reportToVoice(t) {
  if (!dc || dc.readyState !== 'open') return;
  const open = [...tasks.values()].filter(x => x.status === 'running' || x.status === 'queued').length;
  const what = t.kind === 'chat' ? `reply from his chat, after he sent ${t.request.slice(0, 200)}` : `task: ${t.request.slice(0, 200)}`;
  const which = open ? ` ${open} other task(s) still open, so say which one this is.` : ' Do not mention the task number.';
  if (t.status === 'error') {
    const why = t.error?.code === 'refused' ? 'The model refused it.' : `It failed (${t.error?.code || 'backend'}).`;
    pendingReports.push(`Feather #${t.id} FAILED (${what}). ${why} Detail: ${(t.error?.message || t.report || '').slice(0, 400)}\n\nTell him in one short sentence that it did not work. Do not present it as a result.${which}`);
  } else {
    const body = t.status === 'stopped' ? (t.report || 'Stopped before finishing.') : (t.report || 'Done, no text.');
    pendingReports.push(`Feather #${t.id} ${t.status === 'stopped' ? 'stopped' : 'done'} (${what}). Result:\n${body.slice(0, 4000)}\n\n${t.kind === 'chat' ? 'Say the gist in one or two sentences. If it asks him something, ask him that.' : 'Say the gist in one sentence.'}${which}`);
  }
  flushReports();
}

function flushReports() {
  if (responding || !pendingReports.length || !dc || dc.readyState !== 'open') return;
  const text = pendingReports.splice(0).join('\n\n---\n\n');
  rt({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  rt({ type: 'response.create' });
}

// ---------- picked chat ----------
// The chat the voice talks to. Picked by tap (or by voice via pick_chat); message_chat and read_chat
// use it when no chat is named. The last few picks stay as one-tap chips.

let picked = null, recentPicks = [];
try { picked = JSON.parse(localStorage.getItem('voicePicked') || 'null'); recentPicks = JSON.parse(localStorage.getItem('voicePicks') || '[]'); } catch {}
const pickedNote = () => picked ? `Picked chat: "${picked.title}" (chat ${picked.id.slice(0, 8)}). Message_chat and read_chat go there unless he names another chat.` : 'No chat is picked now. Ask which chat if he does not name one.';

function setPicked(c, { tell = true } = {}) {
  const same = picked?.id === c?.id;
  picked = c ? { id: c.id, title: c.title } : null;
  if (picked) recentPicks = [picked, ...recentPicks.filter(x => x.id !== picked.id)].slice(0, 4);
  try { localStorage.setItem('voicePicked', JSON.stringify(picked)); localStorage.setItem('voicePicks', JSON.stringify(recentPicks)); } catch {}
  renderPicked();
  if (!same && tell && dc?.readyState === 'open') rt({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: pickedNote() }] } });
  if (!same && c && dc?.readyState === 'open') addMsg('sys', 'talking to ' + picked.title);
}

function renderPicked() {
  const btn = $('pickBtn');
  btn.classList.toggle('none', !picked);
  btn.querySelector('.name').textContent = picked ? picked.title : 'no chat · tap to pick';
  $('unpick').hidden = !picked;
  $('recentPicks').replaceChildren(...recentPicks.filter(x => x.id !== picked?.id).slice(0, 3).map(x => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = x.title; b.title = 'Talk to ' + x.title;
    b.onclick = () => setPicked(x);
    return b;
  }));
}

const ago = m => m == null ? '' : m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
let chatSeq = 0;
async function loadChats(q) {
  const list = $('chatList'), seq = ++chatSeq;
  if (!list.children.length || q) list.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: q ? 'Searching…' : 'Loading…' }));
  let chats;
  try { const r = await fetch('api/chats?q=' + encodeURIComponent(q)); chats = (await r.json()).chats; if (!r.ok || !chats) throw new Error(); }
  catch { if (seq === chatSeq) list.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Could not load chats.' })); return; }
  if (seq !== chatSeq) return; // a newer search won
  if (!chats.length) { list.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: `No chat matches "${q}".` })); return; }
  list.replaceChildren(...chats.map(c => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'row' + (c.live ? ' live' : '') + (c.id === picked?.id ? ' cur' : '');
    const dot = document.createElement('span'); dot.className = 'live-dot'; dot.title = 'open now';
    const t = document.createElement('span'); t.className = 't'; t.textContent = c.title;
    const a = document.createElement('span'); a.className = 'ago'; a.textContent = ago(c.minutes_since_activity);
    b.append(dot, t, a);
    b.onclick = () => { setPicked(c); $('chatDlg').close(); };
    return b;
  }));
}

let chatTimer = null;
$('pickBtn').onclick = () => { $('chatQ').value = ''; $('chatDlg').showModal(); loadChats(''); };
$('chatQ').oninput = () => { clearTimeout(chatTimer); chatTimer = setTimeout(() => loadChats($('chatQ').value.trim()), 250); };
$('chatClose').onclick = () => $('chatDlg').close();
$('chatDlg').onclick = e => { if (e.target === $('chatDlg')) $('chatDlg').close(); };
$('unpick').onclick = () => setPicked(null);
renderPicked();

// ---------- tools ----------

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : j.error?.message || j.say || r.statusText);
  return j;
}

// All tools run on the server (POST api/tool). The result is typed: { ok, say, ... } or { ok: false, say, error: { code, ... } }.
// The call id lets the server treat a retried call as the same operation.
async function runTool(name, args, callId) {
  try {
    const r = await post('api/tool', { name, args, call_id: callId, picked: picked?.id });
    if (name === 'pick_chat' && r.ok && r.picked) setPicked(r.picked, { tell: false });
    return r;
  }
  catch (e) { return { ok: false, say: 'The voice server did not answer.', error: { code: 'backend', message: e.message, retryable: true } }; }
}

async function handleFunctionCalls(output) {
  const calls = (output || []).filter(o => o.type === 'function_call');
  if (!calls.length) return false;
  // Parallel calls in one response all start at once.
  const results = await Promise.all(calls.map(async c => {
    let args = {};
    try { args = JSON.parse(c.arguments || '{}'); } catch {}
    const t0 = performance.now();
    const result = await runTool(c.name, args, c.call_id);
    const ms = Math.round(performance.now() - t0);
    dbg(`⚙ ${c.name} · ${ms} ms${calls.length > 1 ? ` · 1 of ${calls.length}` : ''}`, `args   ${JSON.stringify(args)}\nresult ${JSON.stringify(result).slice(0, 1500)}`, result?.ok === false);
    logCall({ heard: lastHeard, tool: c.name, args, result, ms, parallel: calls.length });
    return result;
  }));
  calls.forEach((c, i) => rt({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(results[i]) } }));
  // If it already said its "On it" while starting or stopping tasks, don't make it speak twice.
  const spoke = output.some(o => o.type === 'message' && o.content?.some(c => c.transcript || c.text));
  if (spoke && results.every(r => r?.ok !== false) && calls.every(c => !['feather_status', 'find_chat', 'read_chat', 'create_chat', 'waiting_chats'].includes(c.name))) return false;
  rt({ type: 'response.create' });
  return true;
}

// ---------- realtime ----------

function rt(ev) { if (dc?.readyState === 'open') dc.send(JSON.stringify(ev)); }

function onRealtime(ev) {
  switch (ev.type) {
    case 'session.created': setStatus('live', 'live'); break;
    case 'input_audio_buffer.speech_started': {
      // Hold the user's place now: the transcript comes later, often after the reply has started.
      setStatus('listening', 'live');
      if (ev.item_id && !partial.you.has(ev.item_id)) {
        const el = addMsg('you', '…', { partial: true }); el.dataset.empty = '1';
        partial.you.set(ev.item_id, el);
      }
      break;
    }
    case 'input_audio_buffer.speech_stopped': setStatus('thinking', 'live'); if (early?.streaming) handOver(); break;
    case 'conversation.item.input_audio_transcription.delta': {
      let el = partial.you.get(ev.item_id);
      if (!el) { el = addMsg('you', '', { partial: true }); partial.you.set(ev.item_id, el); }
      if (el.dataset.empty) { el.textContent = ''; delete el.dataset.empty; }
      el.textContent += ev.delta; break;
    }
    case 'conversation.item.input_audio_transcription.completed': {
      let el = partial.you.get(ev.item_id);
      const t = (ev.transcript || '').trim();
      if (!el && t) el = addMsg('you', t);
      if (el) { if (t) el.textContent = t; else el.remove(); el.classList.remove('partial'); }
      if (t) { lastHeard = t; logCall({ heard: t }); }
      partial.you.delete(ev.item_id); break;
    }
    case 'conversation.item.input_audio_transcription.failed':
      partial.you.get(ev.item_id)?.remove(); partial.you.delete(ev.item_id); break;
    case 'response.created': responding = true; break;
    case 'response.output_audio_transcript.delta': case 'response.output_text.delta': {
      let el = partial.ai.get(ev.item_id);
      if (!el) { el = addMsg('ai', '', { partial: true }); partial.ai.set(ev.item_id, el); }
      el.textContent += ev.delta; scroll(); setStatus('speaking', 'live'); break;
    }
    case 'response.output_audio_transcript.done': case 'response.output_text.done': {
      const el = partial.ai.get(ev.item_id);
      if (el) { el.classList.remove('partial'); if (ev.transcript || ev.text) el.textContent = ev.transcript || ev.text; }
      partial.ai.delete(ev.item_id); break;
    }
    case 'response.done': {
      responding = false;
      setStatus('live', 'live');
      const r = ev.response || {};
      if (r.status === 'failed') addMsg('sys', 'voice error: ' + JSON.stringify(r.status_details?.error || r.status_details));
      else if (r.status !== 'completed') dbg(`response ${r.status}`, r.status_details?.reason || r.status_details);
      if (!(r.output || []).some(o => o.type === 'function_call') && r.status === 'completed') dbg('no tool call');
      handleFunctionCalls(r.output).then(called => { if (!called) flushReports(); });
      break;
    }
    case 'error':
      addMsg('sys', 'voice error: ' + (ev.error?.message || JSON.stringify(ev.error)));
      break;
  }
}

async function start() {
  talk.classList.add('connecting'); talk.textContent = '…'; setStatus('connecting');
  const audioEl = $('remote');
  audioEl.play().catch(() => {}); // unlock playback inside the tap (iOS)
  try { audioCtx = new AudioContext(); audioCtx.resume().catch(() => {}); } catch {} // made inside the tap so iOS lets it run
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // iOS can suspend the context when the mic turns on; wake it again or nothing is recorded.
    if (audioCtx && audioCtx.state !== 'running') await Promise.race([audioCtx.resume().catch(() => {}), new Promise(r => setTimeout(r, 300))]);
    meter(); earlyRecord(); // you can talk from the tap: words said while connecting are sent once the call is up
    tapAt = performance.now();
    const key = await getKey();
    pc = new RTCPeerConnection();
    pc.ontrack = e => { audioEl.srcObject = e.streams[0]; audioEl.muted = speakerOff; audioEl.play().catch(() => {}); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc?.connectionState)) { addMsg('sys', 'call ended (' + pc.connectionState + ')'); stop(); }
    };
    // The call gets its own copy of the mic, silent until the early audio is sent, so nothing is heard twice.
    sendTrack = micStream.getAudioTracks()[0].clone(); sendTrack.enabled = false;
    pc.addTrack(sendTrack, micStream);
    dc = pc.createDataChannel('oai-events');
    dc.onmessage = e => onRealtime(JSON.parse(e.data));
    dc.onopen = () => {
      // A new call still knows what Feather is doing and what it last found.
      const recent = [...tasks.values()].slice(-5).map(t => `#${t.id} (${t.status}): ${t.request.slice(0, 150)}${t.report ? ' → ' + t.report.slice(0, 300) : ''}`);
      if (picked) rt({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: pickedNote() }] } });
      if (recent.length) rt({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Context, recent Feather tasks:\n' + recent.join('\n') }] } });
      flushEarly();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${key.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!r.ok) throw new Error('OpenAI said ' + r.status + ': ' + (await r.text()).slice(0, 200));
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    talk.classList.remove('connecting'); talk.classList.add('on'); talk.textContent = 'Live'; talk.title = 'Call is live'; talk.setAttribute('aria-disabled', 'true');
    $('mute').disabled = false; $('speaker').disabled = false; $('endCall').hidden = false; applyMic();
    hint.textContent = `${key.model} via ${key.source === 'codex' ? 'Codex login' : 'API key'} · speak any time, interrupt freely`;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (e) {
    addMsg('sys', 'could not start: ' + e.message);
    stop();
  }
}

function stop() {
  clearInterval(levelTimer); levelTimer = null;
  try { dc?.close(); } catch {} try { pc?.close(); } catch {}
  micStream?.getTracks().forEach(t => t.stop());
  try { audioCtx?.close(); } catch {}
  try { wakeLock?.release(); } catch {}
  try { sendTrack?.stop(); } catch {}
  early?.node.disconnect(); early = null;
  pc = dc = micStream = audioCtx = wakeLock = sendTrack = null;
  prefetchKey();
  responding = false; muted = false; speakerOff = false;
  talk.classList.remove('on', 'connecting'); talk.textContent = 'Talk'; talk.title = ''; talk.removeAttribute('aria-disabled'); talk.style.removeProperty('--lvl');
  renderMute(); renderSpeaker(); applySpeaker();
  $('mute').disabled = true; $('speaker').disabled = true; $('endCall').hidden = true;
  setStatus('ready'); hint.textContent = '';
}

function meter() {
  try {
    audioCtx ||= new AudioContext();
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    audioCtx.createMediaStreamSource(micStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    levelTimer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      talk.style.setProperty('--lvl', muted ? 0 : Math.min(1, peak / 50).toFixed(2));
    }, 60);
  } catch {}
}

// ---------- early audio ----------
// Connecting takes a second or two. The mic opens on the tap and records into memory. When the
// data channel opens, that audio goes to the model as input_audio_buffer.append (PCM16, 24 kHz),
// and new audio keeps going the same way while he is still talking. At the first pause the live
// WebRTC track takes over, so the switch never cuts a word.

let sendTrack = null, early = null, tapAt = 0;
function earlyRecord() {
  if (!audioCtx) return;
  const src = audioCtx.createMediaStreamSource(micStream);
  const node = audioCtx.createScriptProcessor(1024, 1, 1);
  early = { node, chunks: [], rate: audioCtx.sampleRate, streaming: false, quiet: 0, sent: 0, ctx: audioCtx.state };
  node.onaudioprocess = e => {
    const e2 = early; if (e2?.node !== node) return;
    const x = new Float32Array(e.inputBuffer.getChannelData(0));
    if (!e2.streaming) return e2.chunks.push(x);
    if (!muted) { const pcm = to24k([x], e2.rate); e2.sent += pcm.length; rt({ type: 'input_audio_buffer.append', audio: b64(pcm) }); }
    let sum = 0; for (const v of x) sum += v * v;
    e2.quiet = Math.sqrt(sum / x.length) < 0.01 ? e2.quiet + x.length / e2.rate : 0;
    if (e2.quiet >= 0.35) handOver();
  };
  const sink = audioCtx.createGain(); sink.gain.value = 0; // the node must reach the output to run
  src.connect(node); node.connect(sink); sink.connect(audioCtx.destination);
}

// Data channel open: send what was said while connecting, then stream until a pause.
function flushEarly() {
  const e = early;
  if (!e) return applyMic();
  const pcm = to24k(e.chunks, e.rate); e.chunks = [];
  const stats = { connect_ms: Math.round(performance.now() - tapAt), recorded_s: +(pcm.length / 24000).toFixed(2), rate: e.rate, ctx_at_start: e.ctx, ctx_now: audioCtx?.state, ua: navigator.userAgent.slice(0, 120) };
  logCall({ early: stats });
  // The recorder got nothing (the phone kept the audio context asleep): use the live mic at once.
  if (pcm.length < 2400 && stats.connect_ms > 400) { early = null; e.node.disconnect(); dbg('early audio · recorder got nothing, live mic now'); return applyMic(); }
  setTimeout(() => { if (early === e) handOver(); }, 15000); // never keep the live mic off for long
  if (!muted) for (let i = 0; i < pcm.length; i += 24000) rt({ type: 'input_audio_buffer.append', audio: b64(pcm.subarray(i, i + 24000)) });
  e.sent = pcm.length; e.streaming = true;
}

function handOver() {
  const e = early; early = null;
  if (!e) return;
  e.node.disconnect();
  dbg(`early audio · ${(e.sent / 24000).toFixed(1)} s sent before the live mic took over`);
  logCall({ early_handover: { sent_s: +(e.sent / 24000).toFixed(2), live_track: sendTrack?.readyState } });
  applyMic();
}

function to24k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const out = new Int16Array(Math.floor(n * 24000 / rate));
  for (let i = 0; i < out.length; i++) {
    const x = i * rate / 24000, j = Math.floor(x), f = x - j;
    const v = (all[j] || 0) * (1 - f) + (all[j + 1] ?? all[j] ?? 0) * f;
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}
function b64(int16) {
  const u8 = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// A call key is made ahead of time, so the tap goes straight to connecting.
let keyAhead = null;
function prefetchKey() { keyAhead = post('api/session').catch(() => null); }
async function getKey() {
  const k = await keyAhead; keyAhead = null;
  if (k?.value && (!k.expires_at || k.expires_at * 1000 > Date.now() + 20_000)) return k;
  return post('api/session');
}
prefetchKey();

// ---------- mic and speaker ----------
// Mute turns off only your mic. Speaker turns off only the assistant's voice. End call hangs up.

function applyMic() {
  micStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  if (sendTrack && !early) sendTrack.enabled = !muted;
}
function applySpeaker() { $('remote').muted = speakerOff; }

function renderMute() {
  const b = $('mute');
  b.classList.toggle('active', muted); b.setAttribute('aria-pressed', muted);
  b.querySelector('.label').textContent = muted ? 'Muted' : 'Mute';
  b.title = muted ? 'Mic is off. Tap to unmute' : 'Mute your mic';
}

function renderSpeaker() {
  const b = $('speaker');
  b.classList.toggle('active', !speakerOff); b.setAttribute('aria-pressed', !speakerOff);
  b.querySelector('.label').textContent = speakerOff ? 'Speaker off' : 'Speaker on';
  b.title = speakerOff ? 'Assistant voice is off. Tap to turn it on' : "Turn the assistant's voice off";
}

function liveHint() {
  return [muted && 'mic muted', speakerOff && 'speaker off'].filter(Boolean).join(' · ');
}

// ---------- controls ----------

talk.onclick = () => {
  if (!pc && !talk.classList.contains('connecting')) return start();
  if (talk.classList.contains('connecting')) return stop(); // cancel a stuck connect
  // While live, this button only shows status and mic level; End call hangs up.
};
$('endCall').onclick = () => stop();
$('mute').onclick = () => {
  muted = !muted; applyMic(); renderMute();
  hint.textContent = liveHint();
};
$('speaker').onclick = () => {
  speakerOff = !speakerOff; applySpeaker(); renderSpeaker();
  hint.textContent = liveHint();
};
$('typeForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('typeBox').value.trim(); if (!text) return;
  $('typeBox').value = '';
  addMsg('you', text); lastHeard = text; logCall({ heard: text, typed: true });
  if (dc?.readyState === 'connecting') await new Promise(r => dc.addEventListener('open', r, { once: true }));
  if (dc?.readyState === 'open') {
    rt({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    rt({ type: 'response.create' });
  } else {
    // No call running: typed text becomes a Feather task.
    try { const r = await post('api/ask', { request: text }); addMsg('sys', `#${r.task_id} ${r.status}`); } catch (err) { addMsg('sys', err.message); }
  }
};

connectEvents();
