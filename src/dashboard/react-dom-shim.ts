export function flushSync<T>(callback: () => T): T {
  return callback()
}
