function classify(intent, observation) {
  if (observation.operation_state === "PENDING") throw new Error("route operation remains pending; retry reconciliation before any mutation");
  if (observation.current_target === intent.desired_target) return observation.operation_state === "APPLIED" && observation.operation_applied_at ? "DESIRED" : "DESIRED_BEFORE_MUTATION";
  if (observation.current_target === intent.expected_target) return observation.operation_state === "APPLIED" || observation.operation_applied_at ? "APPLIED_BUT_REVERTED" : "EXPECTED";
  return "UNEXPECTED_TARGET";
}

export function reconcileRouteOperation({intent, retry, observe, mutate, onDesired, onExpected, onUnexpected, afterMutation}) {
  const before = observe(intent);
  const initial = classify(intent, before);
  if (initial === "DESIRED") return retry ? onDesired(before) : onUnexpected(before, null, "DESIRED_BEFORE_MUTATION");
  if (initial !== "EXPECTED") return onUnexpected(before, null, initial);
  if (retry) return onExpected(before);

  let mutationError = null;
  try {
    mutate(intent);
  } catch (error) {
    mutationError = error;
  }
  if (afterMutation) afterMutation(intent, mutationError);

  const after = observe(intent);
  const result = classify(intent, after);
  if (result === "DESIRED") return onDesired(after, mutationError);
  if (result === "EXPECTED") return onExpected(after, mutationError);
  return onUnexpected(after, mutationError, result);
}
