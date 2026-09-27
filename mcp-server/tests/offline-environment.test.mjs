import assert from 'node:assert/strict'
import test from 'node:test'

import { OfflineEnvironment } from '../offline-environment.mjs'

function snapshot() {
  return {
    id: 7,
    phase: 3,
    turn: 2,
    latestUpdate: '40',
    gameData: 'official-blob',
    startingMap: [],
    startingOptions: [],
    playerNames: ['a', 'b'],
    currentPlayers: ['a', 'b'],
  }
}

test('offline environment observes each seat and clones without shared mutable state', async () => {
  const calls = []
  const runtime = {
    async inspect(command) {
      calls.push(structuredClone(command))
      return { state: { mySeat: command.actor.seat }, legalActions: { actions: [] } }
    },
  }
  const source = snapshot()
  const env = new OfflineEnvironment({ runtime, snapshot: source })
  const branch = env.clone()
  const branchSnapshot = branch.snapshot()
  branchSnapshot.currentPlayers.pop()

  assert.equal((await env.observe(1)).state.mySeat, 1)
  assert.deepEqual(env.snapshot().currentPlayers, ['a', 'b'])
  assert.deepEqual(source.currentPlayers, ['a', 'b'])
  assert.equal(calls[0].actor.name, 'b')
})

test('offline environment buffers simultaneous moves then installs the official canonical save', async () => {
  let call = 0
  const runtime = {
    async executeBatch(command) {
      call += 1
      if (call === 1) {
        assert.deepEqual(command.transportContext.pendingPlayerNames, ['a', 'b'])
        return {
          canonicalSave: null,
          simultaneousSubmission: {
            moves: [['a', [3, 4], '1', [[1], [], 0]], ['b', [-1], '', []]],
            playersToMove: ['b'],
          },
        }
      }
      assert.equal(command.transportContext.existingMoves[0][0], 'a')
      assert.deepEqual(command.transportContext.pendingPlayerNames, ['b'])
      return {
        simultaneousSubmission: { moves: [], playersToMove: [] },
        canonicalSave: {
          gameData: 'resolved-blob', phase: 4, turn: 2, nextPlayer: ['a'], status: 'ACTIVE',
        },
      }
    },
  }
  const env = new OfflineEnvironment({ runtime, snapshot: snapshot() })

  const first = await env.step(0, [{ type: 'place_employees', slots: [0], employees: [1] }])
  assert.equal(first.after.latestUpdate, '41')
  assert.deepEqual(first.after.currentPlayers, ['b'])
  assert.equal(first.after.gameData, 'official-blob')

  const second = await env.step(1, [{ type: 'place_employees', slots: [0], employees: [1] }])
  assert.equal(second.after.latestUpdate, '42')
  assert.equal(second.after.gameData, 'resolved-blob')
  assert.equal(second.after.phase, 4)
  assert.deepEqual(second.after.currentPlayers, ['a'])
})

test('offline environment rejects expansions and invalid seats before engine execution', async () => {
  assert.throws(
    () => new OfflineEnvironment({ snapshot: { ...snapshot(), startingOptions: ['coffee'] } }),
    (error) => error.code === 'INVALID_OFFLINE_ENVIRONMENT',
  )
  const env = new OfflineEnvironment({ runtime: { inspect() {} }, snapshot: snapshot() })
  await assert.rejects(
    () => env.observe(3),
    (error) => error.code === 'INVALID_OFFLINE_ENVIRONMENT',
  )
})

test('seed reset produces deterministic official state and can take the first legal step', async () => {
  const first = OfflineEnvironment.fromSeed({ seed: 'offline:7', playerNames: ['a', 'b'] })
  const second = OfflineEnvironment.fromSeed({ seed: 'offline:7', playerNames: ['a', 'b'] })
  const firstView = await first.observe(0)
  const secondView = await second.observe(0)
  assert.deepEqual(firstView.state.board, secondView.state.board)
  assert.deepEqual(firstView.state.turnOrder, secondView.state.turnOrder)

  const seat = firstView.state.turnOrder[0]
  const view = seat === 0 ? firstView : await first.observe(seat)
  const placement = view.legalActions.actions.find((action) => action.type === 'place_restaurant')
  assert.ok(placement?.legalSquares?.length)
  const transition = await first.step(seat, [
    {
      type: 'place_restaurant',
      index: placement.legalSquares[0],
      rotation: placement.rotation,
    },
    { type: 'end_turn' },
  ])
  assert.notEqual(transition.after.gameData, '')
  assert.equal(transition.after.latestUpdate, '1')
})
