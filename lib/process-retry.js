const DEFAULT_DELAYS_MS = [25, 100, 250]
const sleeper = new Int32Array(new SharedArrayBuffer(4))

export function isSpawnCapacityError(error) {
  return error?.code === 'EAGAIN'
    || (error?.errno === -11 && String(error?.syscall || '').startsWith('spawn '))
}

function blockFor(ms) {
  Atomics.wait(sleeper, 0, 0, ms)
}

export function retrySpawnCapacitySync(operation, { delaysMs = DEFAULT_DELAYS_MS, sleep = blockFor } = {}) {
  let attempt = 0
  while (true) {
    try {
      return operation()
    } catch (error) {
      if (!isSpawnCapacityError(error) || attempt >= delaysMs.length) throw error
      sleep(delaysMs[attempt++])
    }
  }
}
