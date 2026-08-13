import { expect, it, vi } from 'vitest'

import { createSaveCoordinator } from '../../src/desktop/studio-save-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
}

it('ignores an older save response after a newer save starts', async () => {
  const onState = vi.fn()
  const coordinator = createSaveCoordinator(onState)
  const first = deferred<string>()
  const second = deferred<string>()
  const firstResult = coordinator.run('atlas:identity', () => first.promise)
  const secondResult = coordinator.run('atlas:identity', () => second.promise)
  second.resolve('newest')
  first.resolve('stale')
  await expect(secondResult).resolves.toEqual({ current: true, value: 'newest' })
  await expect(firstResult).resolves.toEqual({ current: false, value: 'stale' })
})

it('retains the failed operation for retry', async () => {
  const coordinator = createSaveCoordinator(vi.fn())
  const operation = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce('saved')
  await expect(coordinator.run('atlas:soul', operation)).rejects.toThrow('Offline')
  await expect(coordinator.retry('atlas:soul')).resolves.toMatchObject({ current: true, value: 'saved' })
})
