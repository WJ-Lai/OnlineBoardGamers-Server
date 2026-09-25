import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadPersonalStore,
  setupBrowserEnv,
} from '../browser-env.mjs'
import { FCMAdapter } from '../fcm-adapter.mjs'

function snapshot(overrides = {}) {
  return {
    id: 91,
    gameName: 'Authoritative Engine Contract',
    startingOptions: {},
    startingOptionsRaw: '{}',
    startingMap: '',
    playerNames: ['human', 'agent-red', 'agent-blue'],
    displayNames: ['Human', 'Red Bot', 'Blue Bot'],
    currentPlayers: ['human', 'agent-red', 'agent-blue'],
    latestUpdate: 17,
    gameCreationTimestamp: 123,
    chatData: '',
    blob: 'persisted-state',
    moveData: '',
    ...overrides,
  }
}

async function adapterWithFakeEngine() {
  await setupBrowserEnv()
  await loadPersonalStore()
  const store = {
    gameflow: { phase: 3, turn: 2 },
    players: [
      { name: 'human', displayName: 'Human' },
      { name: 'agent-red', displayName: 'Red Bot' },
      { name: 'agent-blue', displayName: 'Blue Bot' },
    ],
  }
  let initCalls = 0
  const api = {
    username: 'must-not-be-used',
    getGameData() {
      throw new Error('loadSnapshot must not perform HTTP')
    },
  }
  const adapter = new FCMAdapter(api)
  adapter.ready = true
  adapter.activate = () => {
    throw new Error('loadSnapshot must not activate a credential-bearing client')
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    model: { initGame: async () => { initCalls += 1 } },
  }
  return { adapter, initCalls: () => initCalls }
}

test('loadSnapshot loads a server-provided actor without HTTP credentials', async () => {
  const { adapter, initCalls } = await adapterWithFakeEngine()

  const loaded = await adapter.loadSnapshot(snapshot(), {
    actorName: 'agent-red',
    actorSeat: 1,
  })

  assert.equal(initCalls(), 1)
  assert.equal(loaded.mySeat, 1)
  assert.equal(adapter.playerIndex, 1)
  assert.equal(adapter.actorName, 'agent-red')
  assert.equal(adapter.currentVersion, '17')
})

test('loadSnapshot rejects a forged seat/name pair before engine initialization', async () => {
  const { adapter, initCalls } = await adapterWithFakeEngine()

  await assert.rejects(
    () => adapter.loadSnapshot(snapshot(), {
      actorName: 'agent-red',
      actorSeat: 2,
    }),
    (error) => error.code === 'ACTOR_MISMATCH',
  )
  assert.equal(initCalls(), 0)
})

test('loadSnapshot rejects actors who are not game members', async () => {
  const { adapter, initCalls } = await adapterWithFakeEngine()

  await assert.rejects(
    () => adapter.loadSnapshot(snapshot(), { actorName: 'intruder' }),
    (error) => error.code === 'NOT_A_PLAYER',
  )
  assert.equal(initCalls(), 0)
})
