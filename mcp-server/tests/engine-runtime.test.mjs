import assert from 'node:assert/strict'
import test from 'node:test'

import { EngineRuntime } from '../engine-runtime.mjs'

function validSnapshot() {
  return {
    id: 12,
    gameData: 'blob',
    startingOptions: [],
    playerNames: ['human', 'agent'],
    latestUpdate: '44',
  }
}

test('inspect returns one versioned server-owned state/action envelope', async () => {
  const calls = []
  const adapter = {
    async loadSnapshot(snapshot, actor) { calls.push({ snapshot, actor }) },
    getState() { return { gameID: 12, version: '44', mySeat: 1 } },
    getLegalActions() { return { phase: 3, yourTurn: true, actions: [{ type: 'place_employees' }] } },
  }
  const runtime = new EngineRuntime({
    createAdapter: () => adapter,
    metadata: async () => ({ protocolVersion: 'test-v1', rulesetHash: 'a'.repeat(64) }),
  })

  const result = await runtime.inspect({
    snapshot: validSnapshot(),
    actor: { name: 'agent', seat: 1 },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].snapshot.blob, 'blob')
  assert.deepEqual(calls[0].actor, { actorName: 'agent', actorSeat: 1 })
  assert.equal(result.protocolVersion, 'test-v1')
  assert.equal(result.rulesetHash, 'a'.repeat(64))
  assert.equal(result.version, '44')
  assert.equal(result.state.mySeat, 1)
  assert.deepEqual(result.legalActions.actions, [{ type: 'place_employees' }])
})

test('inspect rejects caller-controlled actor fields outside the server identity envelope', async () => {
  const runtime = new EngineRuntime({
    createAdapter: () => { throw new Error('must not initialize engine') },
  })
  await assert.rejects(
    () => runtime.inspect({
      snapshot: validSnapshot(),
      actor: { name: 'agent', seat: 1, password: 'smuggled' },
    }),
    (error) => error.code === 'INVALID_ENGINE_COMMAND',
  )
})

test('executeBatch requires optimistic version match and a complete commit boundary', async () => {
  let created = 0
  const runtime = new EngineRuntime({
    createAdapter: () => {
      created += 1
      return {}
    },
  })
  await assert.rejects(
    () => runtime.executeBatch({
      snapshot: validSnapshot(), actor: { name: 'agent', seat: 1 },
      expectedVersion: '43', actions: [{ type: 'next_subphase' }],
    }),
    (error) => error.code === 'STALE_STATE',
  )
  assert.equal(created, 0)

  await assert.rejects(
    () => runtime.executeBatch({
      snapshot: validSnapshot(), actor: { name: 'agent', seat: 1 },
      expectedVersion: '44', actions: [{ type: 'hire', employee: 2 }],
    }),
    (error) => error.code === 'INCOMPLETE_COMMAND',
  )
  assert.equal(created, 0)
})

test('executeBatch applies a subphase transaction and returns a canonical save', async () => {
  const applied = []
  const adapter = {
    async loadSnapshot() {},
    async doAction(action, options) { applied.push({ action, options }); return { ok: true } },
    exportBlob(includeContext) {
      assert.equal(includeContext, false)
      return 'canonical-blob'
    },
    getState() {
      return {
        gameID: 12, version: '44', phase: 5, turn: 2, mySeat: 1,
        turnOrder: [1, 0], players: [{ name: 'human' }, { name: 'agent' }],
      }
    },
    getLegalActions() { return { yourTurn: true, isSimulPhase: false, actions: [] } },
  }
  const runtime = new EngineRuntime({
    createAdapter: () => adapter,
    metadata: async () => ({ protocolVersion: 'test-v1', rulesetHash: 'b'.repeat(64) }),
  })

  const result = await runtime.executeBatch({
    snapshot: validSnapshot(), actor: { name: 'agent', seat: 1 },
    expectedVersion: '44',
    actions: [{ type: 'hire', employee: 2 }, { type: 'next_subphase' }],
  })

  assert.equal(applied.length, 2)
  assert.equal(result.canonicalSave.gameData, 'canonical-blob')
  assert.equal(result.canonicalSave.phase, 5)
  assert.equal(result.canonicalSave.turn, 2)
  assert.deepEqual(result.canonicalSave.nextPlayer, ['agent'])
  assert.equal(result.state.version, '44')
  assert.deepEqual(result.actions, [{ type: 'hire', employee: 2 }, { type: 'next_subphase' }])
})
