/** A bounded pool of unused pairs. Persistence and request replay belong to the
 * caller. healthy/claim/retire are synchronous so reservation cannot interleave
 * with another request; claim must durably reveal both identities before return.
 */
export function createChatPool({ capacity = 1, create, healthy, claim, retire,
  initialEntries = [], backoffMs = 30_000, maxBackoffMs = 300_000, maxFailures = 3, onError = () => {} }) {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 4) throw new Error('invalid chat pool capacity');
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || !Number.isFinite(backoffMs) || backoffMs < 1
    || !Number.isFinite(maxBackoffMs) || maxBackoffMs < backoffMs) throw new Error('invalid chat pool retry policy');
  let ready = [...(typeof initialEntries === 'function' ? initialEntries() : initialEntries)];
  const seen = new Set();
  ready = ready.filter(entry => { if (!entry?.id || seen.has(entry.id)) return false; seen.add(entry.id); return true; });
  let filling = null;
  let closed = false;
  let retryTimer = null;
  let retryAt = 0;
  let failures = 0;
  let unavailable = false;

  function report(error) { try { onError(error); } catch {} }
  function discard(entry, reason) {
    try { retire(entry, reason); } catch (error) { report(error); }
  }
  while (ready.length > capacity) discard(ready.pop(), 'excess standby capacity');

  function backoff(error) {
    report(error);
    failures++;
    if (failures >= maxFailures) {
      unavailable = true;
      retryAt = 0;
      return;
    }
    const delay = Math.min(maxBackoffMs, backoffMs * (2 ** (failures - 1)));
    retryAt = Date.now() + delay;
    if (!closed && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; void refill(); }, delay);
      retryTimer.unref?.();
    }
  }

  function refill() {
    if (closed || unavailable || capacity === 0 || Date.now() < retryAt) return Promise.resolve();
    if (filling) return filling;
    // Start on a microtask so filling is assigned even when create throws.
    filling = Promise.resolve().then(async () => {
      while (!closed && ready.length < capacity) {
        let entry;
        try {
          entry = await create();
          if (!entry?.id || seen.has(entry.id)) {
            // A buggy creator must never cause retirement of an existing chat.
            entry = null;
            throw new Error('pool creation must return a fresh pair identity');
          }
          seen.add(entry.id);
          if (closed) { discard(entry, 'pool closed during startup'); break; }
          if (!healthy(entry)) throw new Error('standby harness unavailable after startup');
          ready.push(entry);
          failures = 0;
          retryAt = 0;
        } catch (error) {
          if (entry?.id) discard(entry, error.message);
          backoff(error);
          break;
        }
      }
    }).finally(() => { filling = null; });
    return filling;
  }

  function acquire() {
    if (closed) return null;
    while (ready.length) {
      const entry = ready.shift(); // Reserve before any callback.
      try {
        if (!healthy(entry)) { discard(entry, 'standby harness unavailable'); continue; }
        const result = claim(entry);
        if (result && typeof result.then === 'function') throw new Error('chat pool claim must be synchronous');
        void refill();
        return result ?? entry;
      } catch (error) {
        // Never return a possibly partially claimed conversation to the pool.
        discard(entry, error.message);
        report(error);
      }
    }
    void refill();
    return null;
  }

  function close() {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // Explicit operator recovery after fixing the engine; ordinary claims keep
  // falling back cold and cannot restart an unavailable pool's retry loop.
  function retry() {
    if (closed) return Promise.resolve();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    failures = 0;
    unavailable = false;
    retryAt = 0;
    return refill();
  }

  return { acquire, refill, retry, close, snapshot: () => ({ ready: ready.map(entry => ({ ...entry })),
    filling: !!filling, retryAt, failures, unavailable, closed }) };
}
