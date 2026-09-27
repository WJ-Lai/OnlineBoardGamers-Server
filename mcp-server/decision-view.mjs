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
