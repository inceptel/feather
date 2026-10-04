// Terminal input for the pi agent's tmux pane.
//
// Feather sends a message with `tmux paste-buffer -p` and then Enter. With
// bracketed paste on, the pasted text arrives between ESC[200~ and ESC[201~, so
// newlines inside a paste stay part of one message. Enter outside a paste
// submits. Ctrl-C interrupts. Launch-time Enter presses on an empty line do
// nothing.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function createInputParser({ onSubmit, onInterrupt, onEcho = () => {} }) {
  let buffer = '';
  let pending = ''; // incomplete escape sequence carried between chunks
  let pasting = false;

  function submit() {
    const text = buffer.replace(/\r\n?/g, '\n').trim();
    buffer = '';
    onEcho('\r\n');
    if (text) onSubmit(text);
  }

  function feed(chunk) {
    let data = pending + String(chunk);
    pending = '';
    let index = 0;
    while (index < data.length) {
      if (pasting) {
        const end = data.indexOf(PASTE_END, index);
        if (end < 0) {
          // Keep a possible partial end marker for the next chunk.
          const tail = partialSuffix(data, PASTE_END);
          buffer += data.slice(index, data.length - tail);
          onEcho(data.slice(index, data.length - tail).replace(/\r?\n|\r/g, '\r\n'));
          pending = data.slice(data.length - tail);
          return;
        }
        const pasted = data.slice(index, end);
        buffer += pasted;
        onEcho(pasted.replace(/\r?\n|\r/g, '\r\n'));
        pasting = false;
        index = end + PASTE_END.length;
        continue;
      }
      const char = data[index];
      if (char === '\x1b') {
        const rest = data.slice(index);
        if (rest.startsWith(PASTE_START)) { pasting = true; index += PASTE_START.length; continue; }
        if (PASTE_START.startsWith(rest)) { pending = rest; return; }
        // Other escape sequences (arrows, focus events) are ignored.
        const match = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(rest);
        index += match ? Math.max(1, match[0].length) : 1;
        continue;
      }
      if (char === '\r' || char === '\n') { submit(); index += 1; continue; }
      if (char === '\x03') { buffer = ''; onEcho('^C\r\n'); onInterrupt(); index += 1; continue; }
      if (char === '\x7f' || char === '\b') {
        if (buffer) { buffer = buffer.slice(0, -1); onEcho('\b \b'); }
        index += 1;
        continue;
      }
      if (char < ' ' && char !== '\t') { index += 1; continue; }
      buffer += char;
      onEcho(char);
      index += 1;
    }
  }

  return { feed, get buffer() { return buffer; } };
}

function partialSuffix(data, marker) {
  for (let length = Math.min(marker.length - 1, data.length); length > 0; length -= 1) {
    if (marker.startsWith(data.slice(data.length - length))) return length;
  }
  return 0;
}
