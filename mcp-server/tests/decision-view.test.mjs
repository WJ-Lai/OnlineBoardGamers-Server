import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEconomicPlayers, buildStrategicThreats } from '../decision-view.mjs'


test('economic view delegates prices, salary, slots and capacities to official functions', () => {
  const calls = []
  const store = {
    players: [{
      ceoSlots: 2,
      employees: [5, -1, 17, -1],
      beach: [13],
      marketers: [],
    }],
    context: { justTrained: [] },
  }
  const reference = {
    BLANK_EMPLOYEE_SPACE: -1,
    MANAGERS: [5],
    MARKETERS: [17],
    PRODUCERS: [13],
    CAN_BUILD_RESTAURANT: [21],
    TRAINABLE_BASE: [13],
    REQUIRE_SALARY: [17, 21],
    RECRUITING_GIRL: 17,
    RECRUITING_MANAGER: 18,
    HR_DIRECTOR: 19,
    TRAINER: 20,
    COACH: 21,
    GURU: 22,
  }
  const rules = {
    getSubSlotsForEmployee(employee) { calls.push(['subslots', employee]); return employee === 5 ? 2 : 0 },
    salary(seat) { calls.push(['salary', seat]); return 15 },
    employeesRequiringASalary(seat) { calls.push(['salaryEmployees', seat]); return [17, 13] },
    getTotalRecruitingPoints(seat) { calls.push(['recruiting', seat]); return 3 },
    getTotalRecruitDiscountPoints(seat) { calls.push(['recruitDiscount', seat]); return 2 },
    getTrainingPoints(seat, used) {
      calls.push(['training', seat, used])
      return { total: 4, level2: 1, level3: 0, unlimited: false }
    },
    allowedCampaigns(employee) { calls.push(['campaigns', employee]); return [3] },
    giveMaxDurationForMarketer(employee) { calls.push(['duration', employee]); return 2 },
    givePossibleFoodDrinksChoice(employee) { calls.push(['goods', employee]); return [0, 1, 2] },
  }
  const player = {
    giveNbFreeSlots(seat) { calls.push(['freeSlots', seat]); return 1 },
    playersPrice(seat) { calls.push(['price', seat]); return 9 },
    playerDiscount(seat) { calls.push(['discount', seat]); return 1 },
  }
  const controller = {
    producersForWorkingDay(playerObject) {
      calls.push(['producers', playerObject])
      return [13]
    },
  }

  const result = buildEconomicPlayers({ store, rules, player, controller, reference })

  assert.deepEqual(result, [{
    seat: 0,
    company: {
      ceoSlots: 2,
      ceoReports: [
        { slot: 0, employee: 5, managerSlots: 2 },
        { slot: 1, employee: null, managerSlots: 0 },
      ],
      subordinateSlots: [
        { slot: 2, employee: 17 },
        { slot: 3, employee: null },
      ],
      activeEmployees: 2,
      beachEmployees: 1,
    },
    freeSlots: 1,
    salary: { due: 15, employeeIds: [17, 13] },
    price: { unit: 9, discount: 1 },
    pipeline: {
      active: {
        management: 1, recruiting: 1, training: 0, marketing: 1,
        production: 0, restaurantBuilding: 0, trainable: 0, salaryLiable: 1,
      },
      beach: {
        management: 0, recruiting: 0, training: 0, marketing: 0,
        production: 1, restaurantBuilding: 0, trainable: 1, salaryLiable: 0,
      },
      owned: {
        management: 1, recruiting: 1, training: 0, marketing: 1,
        production: 1, restaurantBuilding: 0, trainable: 1, salaryLiable: 1,
      },
    },
    capacities: {
      recruiting: { total: 3, salaryDiscountPoints: 2 },
      training: { total: 4, level2: 1, level3: 0, unlimited: false },
      production: [{ employee: 13, goods: [0, 1, 2], mode: 'produce' }],
      marketing: [{ employee: 17, campaignTypes: [3], maxDuration: 2 }],
      restaurantBuilders: [],
    },
  }])
  assert.deepEqual(calls.find((entry) => entry[0] === 'training'), ['training', 0, []])
})

test('economic view fails closed instead of inventing missing official calculations', () => {
  assert.throws(
    () => buildEconomicPlayers({
      store: { players: [{ employees: [], beach: [], ceoSlots: 3, marketers: [] }] },
      rules: {}, player: {}, controller: {}, reference: { BLANK_EMPLOYEE_SPACE: -1 },
    }),
    (error) => error.code === 'DECISION_VIEW_UNAVAILABLE' && /salary/.test(error.message),
  )
})

test('strategic threats expose milestone windows and public house competition via official functions', () => {
  const calls = []
  const store = {
    availableMilestones: [0, 1],
    players: [
      { milestones: [0], resources: [4, 4] },
      { milestones: [], resources: [4] },
      { milestones: [2], resources: [] },
    ],
    needs: [
      { number: 18, needs: [[4, -1], [4, -1]] },
      { number: 3, needs: [[3, -1]] },
    ],
    houses: [{ number: 3 }, { number: 18 }],
  }
  const rules = {
    selectNeedsPriority(goods, garden) {
      calls.push(['tiers', goods, garden])
      return garden && goods.length > 1 ? [goods, goods.slice(0, 1)] : [goods]
    },
    adjustDistanceForMilestones(distances, count) {
      calls.push(['distances', distances, count])
      return distances.map((distance) => distance === -99 ? distance : distance - 1)
    },
    getPlaceInFullTurnOrderForPlayer: (seat) => [2, 0, 1].indexOf(seat),
  }
  const model = {
    giveRestaurantRangesForHouse(house) {
      calls.push(['ranges', house])
      return house === 18 ? [3, 2, -99] : [-99, 1, -99]
    },
    hasGarden: (house) => house === 18,
  }
  const map = {
    findAllHouses() { calls.push(['allHouses']); return [21, 3, 18] },
  }
  const player = {
    playerHasResources(seat, goods) {
      calls.push(['stock', seat, goods])
      const stock = [...store.players[seat].resources]
      return goods.every((good) => {
        const index = stock.indexOf(good)
        if (index < 0) return false
        stock.splice(index, 1)
        return true
      })
    },
    playersPrice: (seat) => 10 - seat,
    numberOfWaitress: (seat) => seat,
    numberOfMusicians: () => 0,
  }
  const reference = {
    BASE_GAME_MILESTONES: [0, 1, 2],
    MILESTONES_STR: [{ title: 'Hire 3' }, { title: 'Discard' }, { title: 'Waitress' }],
  }

  const before = structuredClone(store)
  const result = buildStrategicThreats({ store, rules, player, model, map, reference })

  assert.deepEqual(store, before)
  assert.deepEqual(result.milestones, [
    {
      id: 0, title: 'Hire 3', claimWindowOpen: true, holders: [0],
      status: 'shared-this-turn', seatsStillEligible: [1, 2],
    },
    {
      id: 1, title: 'Discard', claimWindowOpen: true, holders: [],
      status: 'unclaimed', seatsStillEligible: [0, 1, 2],
    },
    {
      id: 2, title: 'Waitress', claimWindowOpen: false, holders: [2],
      status: 'closed-claimed', seatsStillEligible: [],
    },
  ])
  assert.deepEqual(result.market.houses[0], {
    house: 3,
    advertisedGoods: [3],
    activeTierIndex: null,
    activeGoods: [],
    eligibleSupplierSeats: [],
    contested: false,
    tiers: [{ goods: [3], suppliers: [] }],
  })
  assert.equal(result.market.houses[1].house, 18)
  assert.equal(result.market.houses[1].activeTierIndex, 0)
  assert.deepEqual(result.market.houses[1].eligibleSupplierSeats, [0])
  assert.equal(result.market.houses[1].contested, false)
  assert.deepEqual(result.market.houses[1].tiers[1].suppliers.map((item) => item.seat), [0, 1])
  assert.deepEqual(result.reachability, {
    scope: 'all-map-houses-before-demand-and-inventory',
    houses: [
      { house: 3, restaurantDistances: [-99, 1, -99], reachableSeats: [1] },
      { house: 18, restaurantDistances: [3, 2, -99], reachableSeats: [0, 1] },
      { house: 21, restaurantDistances: [-99, 1, -99], reachableSeats: [1] },
    ],
  })
  assert.ok(calls.some((entry) => entry[0] === 'tiers'))
  assert.ok(calls.some((entry) => entry[0] === 'distances'))
  assert.ok(calls.some((entry) => entry[0] === 'allHouses'))
})

test('strategic threats fail closed when an authoritative market function is absent', () => {
  assert.throws(
    () => buildStrategicThreats({
      store: { players: [], needs: [], availableMilestones: [] },
      rules: {}, player: {}, model: {}, reference: {},
    }),
    (error) => error.code === 'DECISION_VIEW_UNAVAILABLE' && /selectNeedsPriority/.test(error.message),
  )
})
