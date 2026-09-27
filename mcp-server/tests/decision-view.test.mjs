import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEconomicPlayers } from '../decision-view.mjs'


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
