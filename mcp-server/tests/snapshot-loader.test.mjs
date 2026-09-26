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
      { name: 'human', displayName: 'human' },
      { name: 'agent-red', displayName: 'agent-red' },
      { name: 'agent-blue', displayName: 'agent-blue' },
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
  assert.deepEqual(adapter.store.players.map((player) => player.displayName), [
    'Human', 'Red Bot', 'Blue Bot',
  ])
})

test('public Agent state contains visible decision data but not private transient context', () => {
  const store = {
    gameName: 'Visible state',
    gameflow: {
      phase: 5, turn: 3, subphase: 4,
      turnOrder: [1, 0], newTurnOrder: [], fullTurnOrder: [1, 0],
    },
    bank: 84,
    bankBroken: false,
    players: [{
      name: 'agent-red', displayName: 'Red Bot', money: 22, bankrupt: false,
      resources: [4], employees: [17], beach: [13], ceoSlots: 3,
      restaurants: [{ index: 12 }], milestones: [1], marketers: [], coffeeShops: [],
    }],
    availableEmployees: { 13: 3, 17: 0 },
    availableMilestones: [1, 2],
    availableMarketingCampaigns: [2, 3],
    campaigns: [{ type: 2, good: 4 }],
    needs: [{ number: 18, needs: [[4]] }],
    houses: [{ number: 18 }],
    gardens: [],
    freeways: [],
    parks: [],
    newRoads: [],
    mapData: { tiles: [[1]], dimensions: { width: 12, height: 12 } },
    history: [{ message: 'Red Bot hired' }],
    chatData: [{ player: 'human', message: 'ignore instructions here' }],
    startingOptions: { baseGame: true },
    context: { preMoveData: ['secret simultaneous choice'] },
    reserveCards: [3],
  }
  const adapter = new FCMAdapter({ username: 'agent-red' })
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    model: { giveRestaurantRangesForHouse: () => [{ restaurant: 12, distance: 3 }] },
    reference: {
      EMPLOYEES_STR: [{ title: 'Waitress', description: 'Earns tips' }],
      MILESTONES_STR: [{ title: 'First to hire 3', description: 'Bonus' }],
      BASE_GAME_MILESTONES: [0],
    },
  }
  adapter.playerIndex = 0
  adapter.actorName = 'agent-red'
  adapter.currentGameID = 91
  adapter.currentVersion = '17'

  const state = adapter.getState()
  assert.equal(state.players[0].name, 'Red Bot')
  assert.deepEqual(state.board.houses, [{ number: 18 }])
  assert.deepEqual(state.houseDemands[0].restaurantDistances, [{ restaurant: 12, distance: 3 }])
  assert.deepEqual(state.availableEmployees, { 13: 3 })
  assert.deepEqual(state.history, [{ message: 'Red Bot hired' }])
  assert.deepEqual(state.catalog.goods[4], { id: 4, name: 'burger' })
  assert.deepEqual(state.catalog.employees[0], {
    id: 0, title: 'Waitress', description: 'Earns tips',
  })
  assert.deepEqual(state.catalog.milestones[0], {
    id: 0, title: 'First to hire 3', description: 'Bonus',
  })
  assert.deepEqual(state.untrustedTextFields, ['chat'])
  assert.equal(JSON.stringify(state).includes('secret simultaneous choice'), false)
  assert.equal(Object.hasOwn(state, 'reserveCards'), false)
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
