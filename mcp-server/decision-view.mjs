function unavailable(name) {
  const error = new Error(`official ${name} calculation is unavailable`)
  error.code = 'DECISION_VIEW_UNAVAILABLE'
  return error
}

function official(owner, name) {
  const value = owner?.[name]
  if (typeof value !== 'function') throw unavailable(name)
  return value
}

/**
 * Build deterministic economic features exclusively through the loaded official FCM modules.
 * This is a read-only projection; it must never become a second rules implementation.
 */
export function buildEconomicPlayers({ store, rules, player, controller, reference }) {
  const salary = official(rules, 'salary')
  const salaryEmployees = official(rules, 'employeesRequiringASalary')
  const recruiting = official(rules, 'getTotalRecruitingPoints')
  const recruitDiscount = official(rules, 'getTotalRecruitDiscountPoints')
  const training = official(rules, 'getTrainingPoints')
  const subSlots = official(rules, 'getSubSlotsForEmployee')
  const campaigns = official(rules, 'allowedCampaigns')
  const campaignDuration = official(rules, 'giveMaxDurationForMarketer')
  const possibleGoods = official(rules, 'givePossibleFoodDrinksChoice')
  const freeSlots = official(player, 'giveNbFreeSlots')
  const price = official(player, 'playersPrice')
  const discount = official(player, 'playerDiscount')
  const producers = official(controller, 'producersForWorkingDay')

  const blank = reference?.BLANK_EMPLOYEE_SPACE
  if (!Number.isInteger(blank)) throw unavailable('BLANK_EMPLOYEE_SPACE')
  const marketerTypes = new Set(reference?.MARKETERS ?? [])
  const builderTypes = new Set(reference?.CAN_BUILD_RESTAURANT ?? [])

  return (store?.players ?? []).map((playerObject, seat) => {
    const employees = [...(playerObject.employees ?? [])]
    const ceoSlots = playerObject.ceoSlots ?? 0
    while (employees.length < ceoSlots) employees.push(blank)
    const employeeOrNull = (employee) => employee === blank ? null : employee
    const active = employees.filter((employee) => employee !== blank)
    const production = producers(playerObject).map((employee) => {
      const goods = [...possibleGoods(employee)]
      return {
        employee,
        goods,
        mode: goods.length ? 'produce' : 'collect',
      }
    })
    const marketing = active
      .filter((employee) => marketerTypes.has(employee))
      .map((employee) => ({
        employee,
        campaignTypes: [...campaigns(employee)],
        maxDuration: campaignDuration(employee),
      }))
    const trainingCapacity = training(seat, [])

    return {
      seat,
      company: {
        ceoSlots,
        ceoReports: employees.slice(0, ceoSlots).map((employee, slot) => ({
          slot,
          employee: employeeOrNull(employee),
          managerSlots: employee === blank ? 0 : subSlots(employee),
        })),
        subordinateSlots: employees.slice(ceoSlots).map((employee, index) => ({
          slot: ceoSlots + index,
          employee: employeeOrNull(employee),
        })),
        activeEmployees: active.length,
        beachEmployees: (playerObject.beach ?? []).length,
      },
      freeSlots: freeSlots(seat),
      salary: {
        due: salary(seat),
        employeeIds: [...salaryEmployees(seat)],
      },
      price: {
        unit: price(seat),
        discount: discount(seat),
      },
      capacities: {
        recruiting: {
          total: recruiting(seat),
          salaryDiscountPoints: recruitDiscount(seat),
        },
        training: {
          total: trainingCapacity.total,
          level2: trainingCapacity.level2,
          level3: trainingCapacity.level3,
          unlimited: Boolean(trainingCapacity.unlimited),
        },
        production,
        marketing,
        restaurantBuilders: active.filter((employee) => builderTypes.has(employee)),
      },
    }
  })
}

/**
 * Describe public milestone races and per-house, current-inventory competition.
 *
 * The market view deliberately does not predict a winner. Dinner consumes inventory in house
 * number order, so only the isolated official projectDinner operation can authoritatively resolve
 * the whole phase. These features answer the narrower question: "who can serve this demand from
 * the public position right now?" Every rules-sensitive calculation is delegated to the loaded
 * official engine.
 */
export function buildStrategicThreats({ store, rules, player, model, reference }) {
  const priorityTiers = official(rules, 'selectNeedsPriority')
  const adjustDistances = official(rules, 'adjustDistanceForMilestones')
  const turnOrderPosition = official(rules, 'getPlaceInFullTurnOrderForPlayer')
  const restaurantRanges = official(model, 'giveRestaurantRangesForHouse')
  const hasGarden = official(model, 'hasGarden')
  const hasResources = official(player, 'playerHasResources')
  const price = official(player, 'playersPrice')
  const waitresses = official(player, 'numberOfWaitress')
  const musicians = official(player, 'numberOfMusicians')

  const milestoneIds = [...(store?.availableMilestones ?? [])]
  const milestoneSet = new Set(milestoneIds)
  const knownMilestones = new Set(reference?.BASE_GAME_MILESTONES ?? [])
  for (const id of milestoneIds) knownMilestones.add(id)
  for (const playerObject of store?.players ?? []) {
    for (const id of playerObject.milestones ?? []) knownMilestones.add(id)
  }

  const milestones = [...knownMilestones].sort((a, b) => a - b).map((id) => {
    const holders = (store?.players ?? [])
      .map((playerObject, seat) => (playerObject.milestones ?? []).includes(id) ? seat : null)
      .filter(Number.isInteger)
    const claimWindowOpen = milestoneSet.has(id)
    return {
      id,
      title: reference?.MILESTONES_STR?.[id]?.title ?? String(id),
      claimWindowOpen,
      holders,
      status: claimWindowOpen
        ? (holders.length ? 'shared-this-turn' : 'unclaimed')
        : (holders.length ? 'closed-claimed' : 'closed-unclaimed'),
      seatsStillEligible: claimWindowOpen
        ? (store?.players ?? []).map((_, seat) => seat).filter((seat) => !holders.includes(seat))
        : [],
    }
  })

  const houses = [...(store?.needs ?? [])]
    .sort((a, b) => a.number - b.number)
    .map((need) => {
      const advertisedGoods = (need.needs ?? [])
        .map((entry) => entry?.[0])
        .filter(Number.isInteger)
      const ranges = [...restaurantRanges(need.number)]
      const distances = adjustDistances(ranges, advertisedGoods.length)
      const tiers = priorityTiers(advertisedGoods, hasGarden(need.number)).map((goods) => {
        const suppliers = (store?.players ?? []).flatMap((_, seat) => {
          if (distances[seat] === -99 || !hasResources(seat, goods)) return []
          return [{
            seat,
            price: price(seat),
            distance: distances[seat],
            waitresses: waitresses(seat),
            musicians: musicians(seat),
            turnOrder: turnOrderPosition(seat),
          }]
        })
        return { goods: [...goods], suppliers }
      })
      const activeTierIndex = tiers.findIndex((tier) => tier.suppliers.length > 0)
      const activeSuppliers = activeTierIndex < 0 ? [] : tiers[activeTierIndex].suppliers
      return {
        house: need.number,
        advertisedGoods,
        activeTierIndex: activeTierIndex < 0 ? null : activeTierIndex,
        activeGoods: activeTierIndex < 0 ? [] : [...tiers[activeTierIndex].goods],
        eligibleSupplierSeats: activeSuppliers.map((supplier) => supplier.seat),
        contested: activeSuppliers.length > 1,
        tiers,
      }
    })

  const reachabilityHouses = [...new Set((store?.houses ?? []).map((house) => house.number))]
    .sort((a, b) => a - b)
    .map((house) => {
      const restaurantDistances = [...restaurantRanges(house)]
      return {
        house,
        restaurantDistances,
        reachableSeats: restaurantDistances
          .map((distance, seat) => distance === -99 ? null : seat)
          .filter(Number.isInteger),
      }
    })

  return {
    provenance: {
      milestones: 'observed-public-official-store',
      market: 'official-engine-derived-current-inventory-per-house',
      reachability: 'official-engine-derived-public-map-distance',
      exactDinnerResolution: 'projectDinner',
    },
    milestones,
    market: {
      scope: 'independent-per-house-before-sequential-inventory-consumption',
      houses,
    },
    reachability: {
      scope: 'all-built-houses-before-demand-and-inventory',
      houses: reachabilityHouses,
    },
  }
}
