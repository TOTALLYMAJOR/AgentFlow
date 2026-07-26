export interface WorkerResourceSnapshot {
  capacity: number;
  busy: number;
  reserved: number;
  available: number;
}

export function workerResourceSnapshot(
  capacity: number,
  busy: number,
  dispatchReservations: number,
): WorkerResourceSnapshot {
  const normalizedCapacity = Math.max(1, Math.floor(capacity));
  const normalizedBusy = Math.max(0, Math.floor(busy));
  const normalizedReservations = Math.max(
    0,
    Math.floor(dispatchReservations),
  );
  const reserved = normalizedBusy + normalizedReservations;
  return {
    capacity: normalizedCapacity,
    busy: normalizedBusy,
    reserved,
    available: Math.max(0, normalizedCapacity - reserved),
  };
}

export function selectBuildDispatchTurns(
  runningBuildIds: readonly string[],
  lastDispatchedBuildId: string | null,
  availableWorkers: number,
): string[] {
  const buildIds = [...new Set(runningBuildIds)].sort();
  if (buildIds.length === 0 || availableWorkers <= 0) {
    return [];
  }
  const previousIndex =
    lastDispatchedBuildId === null
      ? -1
      : buildIds.indexOf(lastDispatchedBuildId);
  const startIndex =
    previousIndex < 0 ? 0 : (previousIndex + 1) % buildIds.length;
  return Array.from(
    { length: Math.min(Math.floor(availableWorkers), buildIds.length) },
    (_, offset) => buildIds[(startIndex + offset) % buildIds.length],
  ).filter((buildId): buildId is string => buildId !== undefined);
}
