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

interface ReconciliationMessage {
  uuid: string
  timestamp: string
  content?: Array<{ type: string, text?: string }>
  delivery?: string
}

function canonicalSubmittedText(message: ReconciliationMessage): string {
  const text = message.content?.find(block => block.type === 'text')?.text || ''
  return text.replace(/<\/?pasted_content\b[^>]*>/gi, '').trim()
}

export function reconcileOptimisticUserMessage<T extends ReconciliationMessage>(
  messages: T[],
  incoming: T,
  maxAgeMs = 30000,
): T[] | null {
  const incomingText = canonicalSubmittedText(incoming)
  const incomingTime = Date.parse(incoming.timestamp)
  if (!incomingText || !Number.isFinite(incomingTime)) return null

  let matchIndex = -1
  let matchAge = Infinity
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index]
    if (!candidate.uuid.startsWith('optimistic-')) continue
    if (canonicalSubmittedText(candidate) !== incomingText) continue
    const age = Math.abs(Date.parse(candidate.timestamp) - incomingTime)
    if (Number.isFinite(age) && age < maxAgeMs && age < matchAge) {
      matchIndex = index
      matchAge = age
    }
  }
  if (matchIndex < 0) return null

  const reconciled = [...messages]
  reconciled[matchIndex] = { ...incoming, delivery: 'delivered' }
  return reconciled
}
