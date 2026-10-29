// Pause timer for the voice call: a pause shorter than the grace period resumes the same call,
// a longer one ends it. Clock and timers are injectable so the timing can be tested.
(function (root) {
  const PAUSE_GRACE_MS = 5 * 60 * 1000;

  function createPauseTimer({ graceMs = PAUSE_GRACE_MS, onExpire, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let pausedAt = null, timer = null;

    function expire() {
      timer = null; pausedAt = null;
      onExpire?.();
    }

    return {
      get paused() { return pausedAt != null; },
      // Milliseconds left before the call ends; 0 when not paused.
      remaining() { return pausedAt == null ? 0 : Math.max(0, graceMs - (now() - pausedAt)); },
      pause() {
        if (pausedAt != null) return false;
        pausedAt = now();
        timer = setTimer(expire, graceMs);
        return true;
      },
      // 'resumed' keeps the same call. 'expired' means the grace ran out (a throttled background
      // timer may not have fired yet), so the call has been ended. 'idle' means it was not paused.
      resume() {
        if (pausedAt == null) return 'idle';
        clearTimer(timer); timer = null;
        if (now() - pausedAt >= graceMs) { expire(); return 'expired'; }
        pausedAt = null;
        return 'resumed';
      },
      // Drop the pause without firing onExpire (the call was ended some other way).
      cancel() { clearTimer(timer); timer = null; pausedAt = null; },
    };
  }

  root.PAUSE_GRACE_MS = PAUSE_GRACE_MS;
  root.createPauseTimer = createPauseTimer;
})(globalThis);
