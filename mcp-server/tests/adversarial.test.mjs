import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { FCMActionLayer } from '../action-layer.mjs'
import { buildAgentWriteHeaders } from '../browser-env.mjs'
import { LOCK_PATH, withDbWriteLock } from '../db-write-lock.mjs'

function removeTestLock() {
  try { fs.unlinkSync(LOCK_PATH) } catch {}
}

test('concurrent writes serialize without blocking the Node event loop', async (t) => {
  removeTestLock()
  t.after(removeTestLock)
  const events = []

  const first = withDbWriteLock(async () => {
    events.push('first:start')
    await delay(40)
    events.push('first:end')
  }, { timeoutMs: 500, stalenessMs: 5000 })

  await delay(5)
  const second = withDbWriteLock(async () => {
    events.push('second:start')
    events.push('second:end')
  }, { timeoutMs: 500, stalenessMs: 5000 })

  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
})

test('a lock holder never deletes a lock token that now belongs to someone else', async (t) => {
  removeTestLock()
  t.after(removeTestLock)

  await withDbWriteLock(async () => {
    fs.writeFileSync(LOCK_PATH, 'replacement-owner', 'utf8')
  })

  assert.equal(fs.readFileSync(LOCK_PATH, 'utf8'), 'replacement-owner')
})

test('HTTP 200 with a non-JSON body is a failed write, not success', () => {
  const layer = new FCMActionLayer({
    getStore: () => ({}),
    modules: {},
    adapter: { playerIndex: 0 },
  })
  globalThis.__fcmLastWriteResult = {
    ok: true,
    status: 200,
    body: null,
    parsed: false,
  }

  assert.throws(
    () => layer._assertLastWriteSucceeded(),
    (error) => error.code === 'INVALID_WRITE_RESPONSE',
  )
})

test('agent write metadata is injected without overwriting browser headers', () => {
  globalThis.__fcmIdempotencyKey = '8c95e40d-b3b2-4498-94dd-f1969a816901'
  globalThis.__fcmAgentAction = 'hire'
  globalThis.__fcmCommandHash = 'a'.repeat(64)
  const headers = buildAgentWriteHeaders({ 'X-CSRFToken': 'csrf' })
  assert.deepEqual(headers, {
    'X-CSRFToken': 'csrf',
    'X-OBG-Idempotency-Key': '8c95e40d-b3b2-4498-94dd-f1969a816901',
    'X-OBG-Agent-Action': 'hire',
    'X-OBG-Command-Hash': 'a'.repeat(64),
  })
  delete globalThis.__fcmIdempotencyKey
  delete globalThis.__fcmAgentAction
  delete globalThis.__fcmCommandHash
})

function actionLayerForValidation(store) {
  return new FCMActionLayer({
    getStore: () => store,
    modules: {
      rules: {},
      reference: { BLANK_EMPLOYEE_SPACE: -1 },
    },
    adapter: { playerIndex: 0 },
  })
}

test('employee placement rejects out-of-range and duplicate target slots', () => {
  const store = {
    gameflow: { phase: 3 },
    players: [{ beach: [2, 3], employees: [-1, -1] }],
  }
  const layer = actionLayerForValidation(store)
  const legal = { yourTurn: true, actions: [{ type: 'place_employees' }] }

  assert.equal(
    layer._checkLegal({ type: 'place_employees', employees: [2], slots: [99] }, legal, 0).ok,
    false,
  )
  assert.equal(
    layer._checkLegal({ type: 'place_employees', employees: [2, 3], slots: [0, 0] }, legal, 0).ok,
    false,
  )
})

test('second restaurant setup round is writable through the same rule gate', async () => {
  const store = {
    gameflow: { phase: 1 },
    context: { rotation: 0 },
    players: [{ restaurants: [] }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { rules: { givePossibleStartingRestaurantsPosition: () => [42] } },
    adapter: {
      playerIndex: 0,
      getLegalActions: () => ({
        yourTurn: true,
        currentPlayerIndex: 0,
        phaseName: 'Setup - Restaurants Round 2',
        actions: [{ type: 'place_restaurant', legalSquares: [42] }],
      }),
    },
  })
  const result = await layer.execute(
    { type: 'place_restaurant', index: 42 },
    { playerIndex: 0, dryRun: true },
  )
  assert.equal(result.legal, true)
})

test('payday plan rejects missing coverage and non-candidate employees', async () => {
  const store = {
    gameflow: { phase: 7 },
    context: { justFired: [], preMoveData: [[null, []]] },
    players: [{ money: 0, resources: [], employees: [10], beach: [], marketers: [] }],
  }
  const legal = {
    yourTurn: true,
    currentPlayerIndex: null,
    phaseName: 'Payday',
    actions: [{ type: 'resolve_payday', fireableEmployees: [10], payableResources: [] }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { rules: { fireableEmployees: () => [10], canAffordPayDay: () => false } },
    adapter: { playerIndex: 0, getLegalActions: () => legal },
  })
  const empty = await layer.execute(
    { type: 'resolve_payday', fireEmployees: [], payWithResources: [] },
    { playerIndex: 0, dryRun: true },
  )
  assert.equal(empty.legal, false)
  const invalid = await layer.execute(
    { type: 'resolve_payday', fireEmployees: [99], payWithResources: [] },
    { playerIndex: 0, dryRun: true },
  )
  assert.equal(invalid.legal, false)
})

test('atomic payday plan uses the official player functions', () => {
  const calls = []
  const store = {
    gameflow: { phase: 7 },
    availableEmployees: { 10: 0 },
    context: { justFired: [], preMoveData: [[null, []]] },
    players: [{ resources: [3], employees: [10], beach: [], marketers: [] }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: {
      player: {
        fireEmployee: (_seat, employee) => calls.push(['fire', employee]),
        removeResourcesFromPlayer: (_seat, resource, count) => calls.push(['pay', resource, count]),
      },
      rules: {
        numPayNeeded: () => 1,
        canPayWithMoney: () => true,
      },
    },
    adapter: { playerIndex: 0 },
  })
  const applied = layer._apply({
    type: 'resolve_payday', fireEmployees: [10], payWithResources: [3],
  }, 0)
  assert.deepEqual(calls, [['fire', 10], ['pay', 3, 1]])
  assert.deepEqual(store.context.justFired, [10])
  assert.deepEqual(store.context.preMoveData[0][1], [3])
  assert.equal(store.availableEmployees[10], 1)
  assert.equal(applied.deferred, true)
})

test('payday plan rejects duplicate employees and resources beyond owned counts', () => {
  const layer = actionLayerForValidation({ gameflow: { phase: 7 } })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'resolve_payday',
      currentlyAffordable: false,
      fireableEmployees: [10],
      payableResources: [3],
    }],
  }
  assert.equal(layer._checkLegal({
    type: 'resolve_payday', fireEmployees: [10, 10], payWithResources: [],
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'resolve_payday', fireEmployees: [], payWithResources: [3, 3],
  }, legal, 0).ok, false)
})

test('payday plan rejects sacrificing more owned resources than the salary requires', () => {
  const store = {
    gameflow: { phase: 7 },
    context: { preMoveData: [[null, []]] },
    players: [{ resources: [3, 4] }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { rules: { numPayNeeded: () => 1 } },
    adapter: { playerIndex: 0 },
  })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'resolve_payday',
      currentlyAffordable: false,
      fireableEmployees: [],
      payableResources: [3, 4],
    }],
  }

  const verdict = layer._checkLegal({
    type: 'resolve_payday', fireEmployees: [], payWithResources: [3, 4],
  }, legal, 0)

  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /超过.*薪资/)
})

test('cleanup plan rejects insufficient or unavailable discards', async () => {
  const store = {
    gameflow: { phase: 9 },
    context: { justBinned: [] },
    players: [{ resources: Array(11).fill(4) }],
  }
  const legal = {
    yourTurn: true,
    currentPlayerIndex: null,
    phaseName: 'Clean Up',
    actions: [{ type: 'resolve_cleanup', resources: [4], minimumDiscardCount: 1 }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { rules: { kimchiFridgeCollision: () => false } },
    adapter: { playerIndex: 0, getLegalActions: () => legal },
  })
  const insufficient = await layer.execute(
    { type: 'resolve_cleanup', discardResources: [] },
    { playerIndex: 0, dryRun: true },
  )
  assert.equal(insufficient.legal, false)
  const invalid = await layer.execute(
    { type: 'resolve_cleanup', discardResources: [99] },
    { playerIndex: 0, dryRun: true },
  )
  assert.equal(invalid.legal, false)
})

test('atomic cleanup plan uses official bin and fridge-choice functions', () => {
  const calls = []
  const store = {
    gameflow: { phase: 9 },
    players: [{ resources: [4] }],
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: {
      controller: {
        binResource: (resource) => {
          calls.push(['bin', resource])
          store.players[0].resources.splice(store.players[0].resources.indexOf(resource), 1)
        },
        chooseFridgeType: (choice) => calls.push(['fridge', choice]),
      },
      rules: { kimchiFridgeCollision: () => false },
    },
    adapter: { playerIndex: 0 },
  })
  const applied = layer._apply({
    type: 'resolve_cleanup', discardResources: [4], fridgeChoice: 'kimchi',
  }, 0)
  assert.deepEqual(calls, [['fridge', 'kimchi'], ['bin', 4]])
  assert.equal(applied.deferred, true)
})

test('cleanup collision validates discards against the resources kept by the fridge choice', () => {
  const layer = new FCMActionLayer({
    getStore: () => ({ gameflow: { phase: 9 } }),
    modules: { reference: { KIMCHI: 8 } },
    adapter: { playerIndex: 0 },
  })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'resolve_cleanup',
      resources: [8, 8, 4, 4],
      hasFridge: true,
      requiresFridgeChoice: true,
      minimumDiscardCount: 0,
    }],
  }
  assert.equal(layer._checkLegal({
    type: 'resolve_cleanup', fridgeChoice: 'kimchi', discardResources: [4],
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'resolve_cleanup', fridgeChoice: 'rest', discardResources: [4],
  }, legal, 0).ok, true)
})

test('marketing rejects forged campaign, square, and duration', () => {
  const layer = actionLayerForValidation({ gameflow: { phase: 5, subphase: 3 } })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'marketing', goods: [0, 1, 2, 3, 4], options: [{
        marketer: 20,
        campaigns: [{
          campaign: 11,
          durationInfinite: false,
          maxDuration: 2,
          placements: [{ rotated: false, legalSquares: [40] }],
        }],
      }],
    }],
  }
  assert.equal(layer._checkLegal({
    type: 'marketing', marketer: 20, campaign: 99, good: 4,
    duration: 1, rotated: false, index: 40,
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'marketing', marketer: 20, campaign: 11, good: 4,
    duration: 1, rotated: false, index: 41,
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'marketing', marketer: 20, campaign: 11, good: 4,
    duration: 9, rotated: false, index: 40,
  }, legal, 0).ok, false)
})

test('atomic marketing follows the official controller interaction path', () => {
  const calls = []
  const layer = new FCMActionLayer({
    getStore: () => ({ gameflow: { phase: 5, subphase: 3 } }),
    modules: { controller: {
      selectMarketer: (value) => calls.push(['marketer', value]),
      chooseCampaign: (value) => calls.push(['campaign', value]),
      chooseGood: (value) => calls.push(['good', value]),
      chooseDuration: (value) => calls.push(['duration', value]),
      rotateCampaign: () => calls.push(['rotate']),
      placeMarketingCampaign: (value) => calls.push(['place', value]),
    } },
    adapter: { playerIndex: 0 },
  })
  const applied = layer._apply({
    type: 'marketing', marketer: 20, campaign: 11, good: 4,
    duration: 2, rotated: true, index: 40,
  }, 0)
  assert.deepEqual(calls, [
    ['marketer', 20], ['campaign', 11], ['good', 4],
    ['duration', 2], ['rotate'], ['place', 40],
  ])
  assert.equal(applied.campaign, 11)
})

test('house building rejects forged stock, position, rotation, and garden edge', () => {
  const layer = actionLayerForValidation({ gameflow: { phase: 5, subphase: 5 } })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'build_house',
      remainingBuilds: 1,
      houses: [{ house: 7, placements: [{ rotation: 0, legalSquares: [100] }] }],
      gardens: [{ house: 4, houseIndex: 80, edges: [{ edge: 1, index: 81 }] }],
    }],
  }
  assert.equal(layer._checkLegal({
    type: 'build_house', building: 'house', house: 8, rotation: 0, index: 100,
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'build_house', building: 'house', house: 7, rotation: 1, index: 100,
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'build_house', building: 'garden', house: 4, edge: 2, index: 82,
  }, legal, 0).ok, false)
})

test('atomic house and garden building use official controller functions', () => {
  const calls = []
  const store = { gameflow: { phase: 5, subphase: 5 }, context: { edges: [] } }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { controller: {
      selectHouseToBuild: (house) => calls.push(['select-house', house]),
      updateHousesHighlights: () => calls.push(['highlights']),
      clickedHouseSquare: (index) => calls.push(['place-house', index]),
      selectGardenToBuild: () => calls.push(['select-garden']),
      chooseHouseForGarden: (index) => {
        calls.push(['select-garden-house', index])
        store.context.edges = [1, 3]
      },
      chooseHouseEdge: (edge, index) => calls.push(['place-garden', edge, index]),
    } },
    adapter: { playerIndex: 0 },
  })
  layer._apply({
    type: 'build_house', building: 'house', house: 7, rotation: 1, index: 100,
  }, 0)
  assert.deepEqual(calls, [
    ['select-house', 7], ['highlights'], ['place-house', 100],
  ])
  assert.equal(store.context.rotation, 1)
  calls.length = 0
  layer._apply({
    type: 'build_house', building: 'garden', house: 4,
    houseIndex: 80, edge: 3, index: 83,
  }, 0)
  assert.deepEqual(calls, [
    ['select-garden'], ['select-garden-house', 80], ['place-garden', 3, -1],
  ])
})

test('new restaurant rejects forged manager, move source, rotation, and target', () => {
  const layer = actionLayerForValidation({ gameflow: { phase: 5, subphase: 6 } })
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'open_restaurant',
      managers: [{
        manager: 3,
        actions: [{
          type: 'move', restaurants: [50],
          placements: [{ rotation: 0, legalSquares: [100] }],
        }],
      }],
    }],
  }
  for (const spec of [
    { manager: 2, fromIndex: 50, rotation: 0, index: 100 },
    { manager: 3, fromIndex: 51, rotation: 0, index: 100 },
    { manager: 3, fromIndex: 50, rotation: 1, index: 100 },
    { manager: 3, fromIndex: 50, rotation: 0, index: 101 },
  ]) {
    assert.equal(layer._checkLegal({
      type: 'open_restaurant', restaurantAction: 'move', ...spec,
    }, legal, 0).ok, false)
  }
})

test('atomic restaurant create and move follow official controller functions', () => {
  const calls = []
  const store = {
    gameflow: { phase: 5, subphase: 6 },
    context: { rotation: 0 },
    highlights: { indexesToHighlightYellow: [100] },
  }
  const controller = {
    selectManager: (manager) => calls.push(['manager', manager]),
    chooseBuildAction: (action) => calls.push(['action', action]),
    removeRestaurantForMove: (index) => calls.push(['remove', index]),
    setNewRestaurantPlacementHighlights: () => calls.push(['highlights']),
    chooseRestaurantPositionForWorking: (index) => calls.push(['place', index]),
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: { controller, reference: { LOCAL_MANAGER: 2, REGIONAL_MANAGER: 3 } },
    adapter: { playerIndex: 0 },
  })
  layer._apply({
    type: 'open_restaurant', restaurantAction: 'create',
    manager: 2, rotation: 1, index: 100,
  }, 0)
  assert.deepEqual(calls, [
    ['manager', 2], ['highlights'], ['place', 100],
  ])
  assert.equal(store.context.rotation, 1)
  calls.length = 0
  layer._apply({
    type: 'open_restaurant', restaurantAction: 'move',
    manager: 3, fromIndex: 50, rotation: 0, index: 100,
  }, 0)
  assert.deepEqual(calls, [
    ['manager', 3], ['action', 'move'], ['remove', 50],
    ['highlights'], ['place', 100],
  ])
})

test('employee placement cannot clone more copies of an employee than the player owns', () => {
  const store = {
    gameflow: { phase: 3 },
    players: [{ beach: [2], employees: [-1, -1] }],
  }
  const layer = actionLayerForValidation(store)
  const legal = { yourTurn: true, actions: [{ type: 'place_employees' }] }
  const verdict = layer._checkLegal(
    { type: 'place_employees', employees: [2, 2], slots: [0, 1] }, legal, 0,
  )
  assert.equal(verdict.ok, false)
})

test('training rejects forged origin and forged training cost', () => {
  const store = { gameflow: { phase: 5, subphase: 2 } }
  const layer = actionLayerForValidation(store)
  const legal = {
    yourTurn: true,
    actions: [{
      type: 'train',
      available: [{ id: 2, origin: 0, upgrades: [{ id: 3, steps: 1 }] }],
    }],
  }

  assert.equal(
    layer._checkLegal(
      { type: 'train', employee: 2, toEmployee: 3, origin: 2, steps: 1 }, legal, 0,
    ).ok,
    false,
  )
  assert.equal(
    layer._checkLegal(
      { type: 'train', employee: 2, toEmployee: 3, origin: 0, steps: 99 }, legal, 0,
    ).ok,
    false,
  )
})

test('normal producers cannot create goods outside their official choices', () => {
  const store = { gameflow: { phase: 5, subphase: 4 } }
  const layer = actionLayerForValidation(store)
  const legal = {
    yourTurn: true,
    actions: [{ type: 'produce', producers: [{ id: 12, goods: [4], mode: 'produce' }] }],
  }
  assert.equal(layer._checkLegal({
    type: 'produce', producer: 12, item: 0, amount: 1,
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'produce', producer: 12, item: 4, amount: 1,
  }, legal, 0).ok, true)
})

test('drink collection rejects non-collector, empty route, and forged first step', () => {
  const store = {
    gameflow: { phase: 5, subphase: 4 },
    context: { producer: -1 },
    highlights: { indexesToHighlightYellow: [10], tilesToHighlight: [] },
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: {
      reference: { ZEPPELIN_PILOT: 30 },
      controller: {
        clickedProducer: (producer) => { store.context.producer = producer },
      },
    },
    adapter: { playerIndex: 0 },
  })
  const legal = {
    yourTurn: true,
    actions: [{ type: 'collect_drinks', collectors: [{ id: 20, startMode: 'square' }] }],
  }
  assert.equal(layer._checkLegal({
    type: 'collect_drinks', producer: 21, route: [10],
  }, legal, 0).ok, false)
  assert.equal(layer._checkLegal({
    type: 'collect_drinks', producer: 20, route: [],
  }, legal, 0).ok, false)
  assert.throws(
    () => layer._apply({ type: 'collect_drinks', producer: 20, route: [11] }, 0),
    (error) => error.code === 'ILLEGAL_ACTION',
  )
})

test('atomic drink collection replays a legal route through official controller functions', () => {
  const calls = []
  const store = {
    gameflow: { phase: 5, subphase: 4 },
    context: { producer: -1 },
    highlights: { indexesToHighlightYellow: [], tilesToHighlight: [] },
  }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: {
      reference: { ZEPPELIN_PILOT: 30 },
      controller: {
        clickedProducer: (producer) => {
          calls.push(['collector', producer])
          store.context.producer = producer
          store.highlights.indexesToHighlightYellow = [10]
        },
        selectNextPosition: (index) => {
          calls.push(['step', index])
          store.highlights.indexesToHighlightYellow = [20]
        },
        stopCollecting: () => {
          calls.push(['stop'])
          store.context.producer = -1
        },
      },
    },
    adapter: { playerIndex: 0 },
  })
  const applied = layer._apply({
    type: 'collect_drinks', producer: 20, route: [10, 20],
  }, 0)
  assert.deepEqual(calls, [['collector', 20], ['step', 10], ['step', 20], ['stop']])
  assert.deepEqual(applied.route, [10, 20])
})

test('pizza radio rejects a forged square and delegates save completion to the official controller', async () => {
  const completion = Promise.resolve('saved')
  const layer = new FCMActionLayer({
    getStore: () => ({ gameflow: { phase: 11 } }),
    modules: { controller: { choosePizzaBombMarketer: () => completion } },
    adapter: { playerIndex: 0 },
  })
  const legal = {
    yourTurn: true,
    actions: [{ type: 'place_pizza_radio', legalSquares: [11] }],
  }
  assert.equal(layer._checkLegal({
    type: 'place_pizza_radio', index: 12,
  }, legal, 0).ok, false)
  const applied = layer._apply({ type: 'place_pizza_radio', index: 11 }, 0)
  assert.equal(applied.selfPersisted, true)
  assert.equal(applied.completion, completion)
})
