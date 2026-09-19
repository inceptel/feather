interface PendingDelivery {
  payload: string
  messageId: string
}

interface ActiveDelivery<T> {
  promise: Promise<T>
}

export function createMessageDeliveryGate(createId: () => string = () => crypto.randomUUID()) {
  const active = new Map<string, ActiveDelivery<unknown>>()
  const pending = new Map<string, PendingDelivery>()

  function run<T>(scope: string, payload: string, deliver: (messageId: string) => Promise<T>, preferredId?: string): Promise<T> {
    const current = active.get(scope)
    if (current) return current.promise as Promise<T>

    const retry = pending.get(scope)
    const messageId = retry?.payload === payload ? retry.messageId : (preferredId || createId())
    pending.set(scope, { payload, messageId })

    const operation = Promise.resolve().then(() => deliver(messageId))
    const promise = operation.then(result => {
      if (pending.get(scope)?.messageId === messageId) pending.delete(scope)
      if (active.get(scope)?.promise === promise) active.delete(scope)
      return result
    }, error => {
      if (active.get(scope)?.promise === promise) active.delete(scope)
      throw error
    })
    active.set(scope, { promise })
    return promise
  }

  return { run }
}
