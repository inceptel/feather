// Attaching a Reviewer to a running solo chat, with every side effect injected
// so the race windows (stop or delete during spawn, priming, or announcement)
// can be exercised without launching harnesses.
const httpError = (status, message) => Object.assign(new Error(message), { status });

export const REVIEWER_DETACH_NOTE = 'Reviewer detached. Ignore the Creator–Reviewer instructions; there is no reviewer to consult.';

// Delivery evidence from the guarded send helper. `submitted` means the text
// was pasted and Enter was sent; `observed` means the pane visibly changed.
// A submission is evidence of delivery; an observation is stronger evidence.
export function deliveryEvidence(result) {
  return { submitted: result?.submitted === true, observed: result?.observed === true, cancelled: result?.cancelled === true, dormant: result?.dormant === true };
}

// deps:
//   allocate(attempt)            -> records the pending attempt and the reviewer's identity durably; throws on conflict
//   alive(attempt)               -> true while the pending record still names this attempt and the chat has not moved on
//   createGroup(group)           -> sidecar group
//   spawn(reviewerSessionId)     -> starts the reviewer harness
//   prime(reviewerSessionId, maySend) -> guarded send of the reviewer setup prompt; returns the send result
//   commit(attempt, delivery)    -> stores the pair on the creator if still alive; returns true when committed
//   announce(attempt, maySend)   -> guarded send of the pair instructions to the creator; returns the send result
//   cleanup(attempt)             -> tears the attempt down (harness, capability, group, pending record)
//   detach(reviewerSessionId)    -> detaches a committed reviewer with that identity
export async function attachReviewer(attempt, deps) {
  const { allocate, alive, createGroup, spawn, prime, commit, announce, cleanup, detach } = deps;
  await allocate(attempt);
  const maySend = () => alive(attempt);
  let reviewerDelivery;
  try {
    await createGroup(attempt);
    if (!alive(attempt)) throw httpError(409, 'Chat changed while the reviewer was starting');
    await spawn(attempt);
    if (!alive(attempt)) throw httpError(409, 'Chat changed while the reviewer was starting');
    reviewerDelivery = deliveryEvidence(await prime(attempt, maySend));
    // Never claim a ready reviewer on a cancelled or unverified setup turn.
    if (reviewerDelivery.cancelled && !reviewerDelivery.submitted) throw httpError(409, 'Chat changed while the reviewer was starting');
    if (!reviewerDelivery.submitted) throw httpError(503, 'Reviewer priming not verified');
    if (!commit(attempt, reviewerDelivery)) throw httpError(409, 'Chat changed while the reviewer was starting');
  } catch (error) {
    try { await cleanup(attempt); } catch {}
    throw error;
  }
  let creatorDelivery;
  try { creatorDelivery = deliveryEvidence(await announce(attempt)); }
  catch (error) { creatorDelivery = { submitted: false, observed: false, cancelled: false, dormant: false, error: error.message }; }
  if (!creatorDelivery.submitted) {
    try { await detach(attempt.reviewerSessionId); } catch {}
    throw httpError(503, 'Reviewer attached but could not be announced; it was detached again');
  }
  return { attached: true, reviewerSessionId: attempt.reviewerSessionId, groupId: attempt.groupId,
    delivery: { reviewer: reviewerDelivery, creator: creatorDelivery } };
}
