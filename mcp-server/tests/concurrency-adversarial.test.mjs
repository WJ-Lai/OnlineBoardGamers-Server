import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { SerialExecutor } from '../serial-executor.mjs'

test('overlapping MCP commands cannot interleave shared Pinia state', async () => {
  const queue = new SerialExecutor()
  const events = []
  const first = queue.run(async () => {
    events.push('game-1:load')
    await delay(25)
    events.push('game-1:save')
  })
  const second = queue.run(async () => {
    events.push('game-2:load')
    await delay(1)
    events.push('game-2:save')
  })

  await Promise.all([first, second])
  assert.deepEqual(events, [
    'game-1:load', 'game-1:save', 'game-2:load', 'game-2:save',
  ])
})

test('a failed command does not poison later commands', async () => {
  const queue = new SerialExecutor()
  await assert.rejects(queue.run(async () => { throw new Error('attacker input') }))
  assert.equal(await queue.run(async () => 'recovered'), 'recovered')
})
