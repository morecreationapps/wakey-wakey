let owner: string | null = null;
let generation = 0;
export function activateNotificationOwner(id: string) {
  owner = id;
  return ++generation;
}
export function clearNotificationOwner(id?: string) {
  if (!id || owner === id) {
    owner = null;
    ++generation;
  }
}
export function notificationScope() {
  return { owner, generation };
}
export function notificationScopeCurrent(
  scope: ReturnType<typeof notificationScope>,
) {
  return (
    !!scope.owner && scope.owner === owner && scope.generation === generation
  );
}
