import assert from 'node:assert/strict'
import test from 'node:test'

import { FCMActionLayer } from '../action-layer.mjs'
import { FCMSystemError } from '../errors.mjs'
import { FCMAdapter, PHASE_NAMES } from '../fcm-adapter.mjs'
import { commandFingerprint, TOOLS, toMcpError } from '../server.mjs'

test('MCP tools never accept credentials or caller-selected seats', () => {
  for (const tool of TOOLS) {
    const json = JSON.stringify(tool.inputSchema)
    assert.doesNotMatch(json, /username|password|playerIndex/)
    assert.ok(tool.outputSchema)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean')
  }
})

test('write contract requires a version and explicit producer field', () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'fcm_execute_action')
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.required, ['gameID', 'expectedVersion', 'idempotencyKey', 'action'])
  assert.match(tool.inputSchema.properties.idempotencyKey.pattern, /\{12\}/)
  assert.equal(tool.inputSchema.properties.action.properties.producer.type, 'integer')
  assert.equal(tool.annotations.readOnlyHint, false)
})

test('Phase 2 exposes create, join, and wait tools with correct safety hints', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))
  assert.equal(byName.get('fcm_create_game')?.annotations.readOnlyHint, false)
  assert.equal(byName.get('fcm_join_game')?.annotations.idempotentHint, true)
  assert.equal(byName.get('fcm_wait_for_change')?.annotations.readOnlyHint, true)
  const createSchema = byName.get('fcm_create_game')?.inputSchema
  assert.deepEqual(createSchema.required, ['gameName'])
  assert.equal(createSchema.properties.maxPlayers.maximum, 6)
  assert.equal(createSchema.properties.invitedUsernames.maxItems, 5)
})

test('action layer rejects seat spoofing before touching the rules engine', async () => {
  const adapter = { playerIndex: 1 }
  const layer = new FCMActionLayer({
    getStore: () => ({ gameflow: { phase: 5 } }),
    modules: {},
    adapter,
  })
  await assert.rejects(
    () => layer.execute({ type: 'hire', employee: 2 }, { playerIndex: 0, dryRun: true }),
    (error) => error.code === 'ACTOR_MISMATCH',
  )
})

test('produce executes the selected normal producer exactly once', () => {
  let calls = 0
  let selected = 0
  const store = { context: {} }
  const layer = new FCMActionLayer({
    getStore: () => store,
    modules: {
      reference: {},
      controller: {
        clickedProducer: (producer) => {
          selected += 1
          store.context.producer = producer
        },
        addProducedItemToPlayer: () => { calls += 1 },
      },
    },
    adapter: { playerIndex: 0 },
  })
  const applied = layer._apply({ type: 'produce', producer: 12, item: 4, amount: 1 }, 0)
  assert.equal(selected, 1)
  assert.equal(calls, 1)
  assert.equal(applied.item, 4)
})

test('sync conflicts remain machine-readable MCP errors', () => {
  const error = new FCMSystemError('version changed', 'STALE_STATE', 'reload')
  assert.deepEqual(toMcpError(error), {
    error: { code: 'STALE_STATE', message: 'version changed', nextAction: 'reload' },
  })
})

test('captured server sync errors cannot be reported as successful writes', () => {
  const layer = new FCMActionLayer({
    getStore: () => ({}),
    modules: {},
    adapter: { playerIndex: 0 },
  })
  globalThis.__fcmLastWriteResult = {
    ok: false,
    status: 200,
    body: { syncError: true },
  }
  assert.throws(
    () => layer._assertLastWriteSucceeded(),
    (error) => error.code === 'STALE_STATE',
  )
})

test('command fingerprint is stable across object key order and changes with intent', () => {
  const first = commandFingerprint({
    gameID: 7,
    expectedVersion: '12',
    action: { type: 'hire', employee: 3 },
  })
  const reordered = commandFingerprint({
    action: { employee: 3, type: 'hire' },
    expectedVersion: '12',
    gameID: 7,
  })
  const different = commandFingerprint({
    gameID: 7,
    expectedVersion: '12',
    action: { type: 'hire', employee: 4 },
  })
  assert.equal(first, reordered)
  assert.notEqual(first, different)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('second restaurant setup round exposes the same placement action as round one', () => {
  const store = {
    gameflow: { phase: 1, turnOrder: [0] },
    context: { rotation: 2 },
    players: [{ restaurants: [] }],
  }
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    rules: { givePossibleStartingRestaurantsPosition: () => [12, 18] },
    controller: { isSimulPhase: () => false },
  }
  const legal = adapter.getLegalActions(0)
  assert.equal(PHASE_NAMES[1], 'Setup - Restaurants Round 2')
  assert.deepEqual(legal.actions[0], {
    type: 'place_restaurant',
    rotation: 2,
    legalSquares: [12, 18],
    hint: '选择餐厅位置（可选点位见 legalSquares）',
  })
})

test('payday and cleanup expose only state-valid base-game decisions', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 7, turnOrder: [0] },
    context: { preMoveData: [[null, []]] },
    players: [{ money: 5, resources: [3], employees: [10], beach: [], marketers: [] }],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => true },
    player: { hasFridge: () => true },
    rules: {
      fireableEmployees: () => [10],
      canAffordPayDay: () => false,
      canPayWithFood: () => true,
      numPayNeeded: () => 2,
      canPayWithMoney: () => false,
      salary: () => 10,
    },
  }
  let legal = adapter.getLegalActions(0)
  assert.deepEqual(legal.actions.map((action) => action.type), ['resolve_payday'])
  assert.deepEqual(legal.actions[0].fireableEmployees, [10])
  assert.deepEqual(legal.actions[0].payableResources, [3])

  store.gameflow.phase = 9
  store.players[0].resources = Array(11).fill(4)
  adapter.modules.rules.kimchiFridgeCollision = () => false
  legal = adapter.getLegalActions(0)
  assert.deepEqual(legal.actions.map((action) => action.type), ['resolve_cleanup'])
  assert.equal(legal.actions[0].minimumDiscardCount, 1)
})

test('simultaneous phases do not reopen a seat that already submitted', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  adapter.modules = {
    storeMod: { useModelStore: () => ({
      gameflow: { phase: 2, turnOrder: [1] },
      context: {},
      players: [{}, {}],
    }) },
    controller: { isSimulPhase: () => true },
  }

  const legal = adapter.getLegalActions(0)
  assert.equal(legal.isSimulPhase, true)
  assert.equal(legal.yourTurn, false)
  assert.match(legal.note, /不是座位 0 的回合/)
})

test('working day never exposes restructuring-only employee placement', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  adapter.modules = {
    storeMod: { useModelStore: () => ({
      gameflow: { phase: 5, subphase: 1, turnOrder: [0] },
      context: {},
      players: [{ employees: [], beach: [17] }],
      availableEmployees: { 17: 2 },
    }) },
    controller: { isSimulPhase: () => false },
    reference: {},
    rules: {
      getRemainingRecruitingPoints: () => 1,
      canRecruitEmployee: () => true,
    },
  }

  const legal = adapter.getLegalActions(0)
  assert.equal(legal.yourTurn, true)
  assert.equal(legal.actions.some((action) => action.type === 'place_employees'), false)
})

test('marketing exposes complete atomic campaign choices instead of a placeholder', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 5, subphase: 3, turnOrder: [0] },
    context: { justMarketed: [] },
    availableMarketingCampaigns: [1, 11, 17],
    availableMilestones: [],
    players: [{ employees: [20], milestones: [] }],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    reference: {
      MARKETERS: [20], MASS_MARKETEER: 99,
      MARKETING_CAMPAIGNS: [null, { type: 0 }, ...Array(9), { type: 3 }],
      ROTATABLE_CAMPAIGNS: [11], BILLBOARD: 3,
      FIRST_BILLBOARD: 40, FIRST_BRAND_DIRECTOR_USED: 41, RADIO: 0,
    },
    player: { hasMilestone: () => false },
    rules: {
      possibleMarketingCampaigns: () => [1, 11, 17],
      givePossiblePositionsForMarketingCampaign: (_marketer, campaign, rotated) => (
        campaign === 1 ? [10] : rotated ? [21] : [20]
      ),
      housesAffectedByMarketingCampaign: ({ index }) => index === 20 ? [7, 8] : [],
      giveMaxDurationForMarketer: () => 2,
    },
  }
  const legal = adapter.getLegalActions(0)
  const marketing = legal.actions.find((action) => action.type === 'marketing')
  assert.deepEqual(marketing.goods, [0, 1, 2, 3, 4])
  assert.equal(marketing.options[0].marketer, 20)
  assert.deepEqual(marketing.options[0].campaigns.map((campaign) => campaign.campaign), [1, 11])
  assert.deepEqual(marketing.options[0].campaigns[1].placements, [
    {
      rotated: false,
      legalSquares: [20],
      houseImpacts: [{ index: 20, houses: [7, 8] }],
    },
    {
      rotated: true,
      legalSquares: [21],
      houseImpacts: [{ index: 21, houses: [] }],
    },
  ])
})

test('houses subphase exposes exact house placements and garden edges', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 5, subphase: 5, turnOrder: [0] },
    context: { justBuilt: [] },
    players: [{ employees: [30] }],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    reference: { NEW_BUSINESS_DEVELOPER: 30 },
    rules: {
      availableHouses: () => [7],
      availableGardens: () => 1,
      givePossiblePositionsForBlock: (width, height) => width === 2 ? [100] : [200],
      givePossibleHousesForGarden: () => [4],
    },
    map: {
      findIndexForHouse: () => 80,
      findFreeEdgesForHouse: () => [1, 3],
      giveIndexForEdge: (edge) => 80 + edge,
    },
  }
  const houses = adapter.getLegalActions(0).actions.find((action) => action.type === 'build_house')
  assert.equal(houses.remainingBuilds, 1)
  assert.deepEqual(houses.houses, [{
    house: 7,
    placements: [
      { rotation: 0, legalSquares: [100] },
      { rotation: 1, legalSquares: [200] },
    ],
  }])
  assert.deepEqual(houses.gardens, [{
    house: 4,
    houseIndex: 80,
    edges: [{ edge: 1, index: 81 }, { edge: 3, index: 83 }],
  }])
})

test('new restaurant subphase exposes manager-scoped create and move options', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 5, subphase: 6, turnOrder: [0] },
    context: { justOpened: [] },
    players: [{ employees: [2, 3], restaurants: [{ index: 50 }] }],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    reference: { LOCAL_MANAGER: 2, REGIONAL_MANAGER: 3, CAN_BUILD_RESTAURANT: [2, 3] },
    rules: {
      givePossiblePositionsForNewRestaurant: (rotation, ranged) => [rotation + (ranged ? 100 : 200)],
    },
  }
  const action = adapter.getLegalActions(0).actions.find(
    (candidate) => candidate.type === 'open_restaurant',
  )
  assert.deepEqual(action.managers.map((manager) => manager.manager), [2, 3])
  assert.deepEqual(action.managers[0].actions.map((item) => item.type), ['create'])
  assert.deepEqual(action.managers[1].actions.map((item) => item.type), ['create', 'move'])
  assert.deepEqual(action.managers[1].actions[1].restaurants, [50])
  assert.deepEqual(action.managers[0].actions[0].placements[2], {
    rotation: 2, legalSquares: [102],
  })
})

test('order-of-business advertises only implemented empty turn-order slots', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 4, turnOrder: [0, 1], newTurnOrder: [-1, 1, -1] },
    players: [{}, {}, {}],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    rules: {},
    reference: {},
  }
  const legal = adapter.getLegalActions(0)
  assert.deepEqual(legal.actions, [{ type: 'choose_turn_order', positions: [0, 2] }])
})

test('production separates route collectors from direct producers', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 0
  const store = {
    gameflow: { phase: 5, subphase: 4, turnOrder: [0] },
    context: { remainingProducers: [12, 20] },
    players: [{ employees: [12, 20] }],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    reference: {
      PRODUCERS: [12, 20], ZEPPELIN_PILOT: 30,
      EMPLOYEES_STR: [],
    },
    rules: {
      givePossibleFoodDrinksChoice: (producer) => producer === 12 ? [4] : [],
      givePossibleStartsFromRestaurants: () => [10, 11],
      givePossibleStartsFromRestaurantsForZeppelin: () => [2],
    },
  }
  const actions = adapter.getLegalActions(0).actions
  assert.deepEqual(actions.find((action) => action.type === 'produce').producers, [
    { id: 12, name: '12', goods: [4], mode: 'produce' },
  ])
  assert.deepEqual(actions.find((action) => action.type === 'collect_drinks').collectors, [
    { id: 20, name: '20', startMode: 'square', starts: [10, 11] },
  ])
})

test('pizza milestone exposes only road-adjacent radio positions for its owner', () => {
  const adapter = new FCMAdapter({})
  adapter.playerIndex = 1
  const store = {
    gameflow: { phase: 11, turnOrder: [1] },
    firstPizzas: [3, 9, 1],
    players: [{}, {}],
  }
  adapter.modules = {
    storeMod: { useModelStore: () => store },
    controller: { isSimulPhase: () => false },
    reference: {},
    rules: {
      firstRadioCampaign: () => 1,
      givePossiblePositionsForRadioPizzaBomb: () => [10, 11],
    },
    map: { adjacentToRoad: (index) => index === 11 },
  }
  assert.deepEqual(adapter.getLegalActions(1).actions, [{
    type: 'place_pizza_radio', campaign: 1, house: 9, legalSquares: [11], canSkip: false,
  }])
})
