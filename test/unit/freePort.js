import net from 'net'

// A port the kernel just confirmed free. Tests that spawn a server must use
// this instead of pid-derived numbers: node runs test files in parallel, and
// overlapping pid formulas collided often enough to fail unrelated suites.
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.unref()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(error => error ? reject(error) : resolve(port))
    })
  })
}
