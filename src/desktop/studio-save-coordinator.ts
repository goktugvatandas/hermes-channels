export interface SaveState {
  phase: 'idle' | 'saving' | 'saved' | 'error'
  error: string | null
}

export type StudioSave = <T>(key: string, operation: () => Promise<T>) => Promise<{ current: boolean; value: T }>

export function createSaveCoordinator(onState: (state: SaveState) => void) {
  const versions = new Map<string, number>()
  const retries = new Map<string, () => Promise<unknown>>()
  const failed = new Map<string, string>()
  let active = 0

  async function run<T>(key: string, operation: () => Promise<T>): Promise<{ current: boolean; value: T }> {
    const version = (versions.get(key) || 0) + 1
    versions.set(key, version)
    retries.set(key, operation)
    active += 1
    onState({ phase: 'saving', error: null })
    try {
      const value = await operation()
      if (versions.get(key) === version) failed.delete(key)
      return { current: versions.get(key) === version, value }
    } catch (error) {
      if (versions.get(key) === version) failed.set(key, error instanceof Error ? error.message : 'Save failed')
      throw error
    } finally {
      active -= 1
      if (active > 0) onState({ phase: 'saving', error: null })
      else if (failed.size) onState({ phase: 'error', error: [...failed.values()][0] })
      else onState({ phase: 'saved', error: null })
    }
  }

  function retry<T>(key: string) {
    const operation = retries.get(key)
    if (!operation) return Promise.reject(new Error(`No failed save for ${key}`))
    return run(key, operation as () => Promise<T>)
  }

  return { run, retry }
}
