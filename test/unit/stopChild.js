// Stop a spawned server and wait for it to be gone. A child that already
// exited (it crashed, or a signal killed it: exitCode stays null then) returns
// at once; waiting for its 'exit' event would hang and hide the crash.
export async function stopChild(child, { graceMs = 2000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(force)
}
