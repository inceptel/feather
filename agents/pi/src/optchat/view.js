// The OptChat view (spec §5, §6): tree nodes ("parts") that tile the whole
// chat [0, T), oldest first, under a byte budget. It only ever appends at the
// end and merges the most due pair whose parent is built; it never splits.
import { bytes } from './store.js';

export const NODE = 512;
export const VIEW = 128_000;
export const PLACEHOLDER = '(not summarized yet: zoom it)';

export const startOf = part => part.i * 2 ** part.l;
export const endOf = part => (part.i + 1) * 2 ** part.l;
export const flat = text => text.replace(/\r?\n/g, ' ');

export function createView(store, { budget = VIEW } = {}) {
  let parts = [];
  const waiters = new Set();
  const built = (l, i) => store.node(l, i) !== undefined;
  const textOf = part => store.node(part.l, part.i)?.text ?? PLACEHOLDER;
  const sizeOf = part => bytes(textOf(part));

  function fit({ notify = true } = {}) {
    const T = store.messages.length;
    let size = 0;
    for (const part of parts) size += sizeOf(part);
    while (size > budget) {
      let best = -1;
      let bestDue = -Infinity;
      for (let k = 0; k + 1 < parts.length; k++) {
        const a = parts[k];
        const b = parts[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !built(a.l + 1, a.i / 2)) continue;
        const due = (T - startOf(a)) / 2 ** (a.l + 2); // OptMem's age rule
        if (due > bestDue) { bestDue = due; best = k; }
      }
      if (best < 0) break; // wait until a parent is built
      const [a, b] = parts.slice(best, best + 2);
      const parent = { l: a.l + 1, i: a.i / 2 };
      size += sizeOf(parent) - sizeOf(a) - sizeOf(b);
      parts.splice(best, 2, parent);
    }
    if (notify) wake();
    return size;
  }

  function wake() {
    for (const waiter of [...waiters]) waiter.check();
  }

  /** Every part that starts before message `k` is a built summary. */
  function settledBefore(k = Infinity) {
    for (const part of parts) {
      if (startOf(part) >= k) break;
      if (!built(part.l, part.i)) return false;
    }
    return true;
  }

  return {
    get parts() { return parts; },
    built,
    textOf,
    /** Re-fold from message 0 (spec §5.2: the view is not saved). */
    fold() {
      parts = [];
      for (let i = 0; i < store.messages.length; i++) {
        parts.push({ l: 0, i });
        fit({ notify: false });
      }
      wake();
    },
    append(i) {
      parts.push({ l: 0, i });
      fit();
    },
    fit,
    /** First message whose view line is not built yet (spec §4.1 `first`). */
    first() {
      for (const part of parts) if (!built(part.l, part.i)) return startOf(part);
      return store.messages.length;
    },
    settledBefore,
    /**
     * Resolve true once every part before message `k` is built; false when
     * `signal` aborts or after `timeoutMs`.
     */
    settle(k = Infinity, { signal, timeoutMs = Infinity } = {}) {
      if (settledBefore(k)) return Promise.resolve(true);
      return new Promise(resolve => {
        let timer;
        const waiter = {
          check: () => { if (settledBefore(k)) done(true); },
        };
        const onAbort = () => done(false);
        function done(value) {
          waiters.delete(waiter);
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        }
        if (signal?.aborted) return resolve(false);
        waiters.add(waiter);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (Number.isFinite(timeoutMs)) timer = setTimeout(() => done(false), timeoutMs);
      });
    },
    /** The parts that start before message `k`. */
    partsBefore(k = Infinity) {
      return parts.filter(part => startOf(part) < k);
    },
    /** `<chat>` with one `id+n|text` line per part before message `k`. */
    render(k = Infinity) {
      const lines = parts.filter(part => startOf(part) < k).map(part => `${startOf(part)}+${2 ** part.l}|${flat(textOf(part))}`);
      return `<chat>\n${lines.join('\n')}${lines.length ? '\n' : ''}</chat>`;
    },
    /** Bare lines for the compactor's context: text only, no ids (spec §4.2). */
    bare(k = Infinity) {
      const lines = parts.filter(part => startOf(part) < k).map(part => flat(textOf(part)));
      return `<chat>\n${lines.join('\n')}${lines.length ? '\n' : ''}</chat>`;
    },
    size() {
      let size = 0;
      for (const part of parts) size += sizeOf(part);
      return size;
    },
  };
}
