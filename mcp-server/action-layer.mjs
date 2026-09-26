/**
 * FCM 动作层 —— 写操作（唯一入口）
 *
 * ★ 设计铁律（用户要求）：
 *   "AI 能做的操作必须和人一样，只能做规则里允许的操作，不能直接改代码"
 *
 * 三道闸门，物理上无法绕过：
 *   1. 白名单：只有本文件 switch 里列出的 action 类型能执行
 *   2. 合法性：每次执行前先跑 getLegalActions()，目标 action 不在返回列表里 → 直接拒绝
 *   3. 官方函数：所有状态改动都调用 FCMcontroller.js 的官方导出函数，
 *      不直接 push/splice/赋值 store 字段
 *
 * 落库路径与人类玩家完全一致：
 *   FCMcontroller.endPlayerTurn() → FCM_IO.saveGameNormal() → POST /FCM/processTurn/
 *
 * 本文件不含任何 blob 直写、不含任何绕过规则的分支。
 */

import { FCMActionError, FCMSystemError } from './errors.mjs'
import { setPersonalState } from './browser-env.mjs'
import { withDbWriteLock } from './db-write-lock.mjs'
import { ACTIONS } from './action-registry.mjs'

/**
 * 一个 action 的描述（由 server 层构造，传入）
 * @typedef {{
 *   type: string,          // 见 ACTIONS
 *   employee?: number,     // hire
 *   slots?: number[],      // place_employees: 目标槽位索引，与 employees 一一对应
 *   employees?: number[],  // place_employees: 要放置的员工 id（可含 BLANK=-1 补空）
 *   producer?: number,     // produce: 执行生产的员工 id
 *   item?: number,         // produce
 *   amount?: number,       // produce
 *   turnOrderPosition?: number,  // choose_turn_order
 * }} ActionSpec
 */

export { ACTIONS }

/** 支持写操作的阶段（其余阶段明确拒绝，而不是静默什么都不做） */
const WRITABLE_PHASES = new Set([
  0, // Setup - Restaurants
  1, // Setup - Restaurants, round 2
  2, // Setup - Reserve Cards
  3, // Setup - Turn Order (Restructuring)
  4, // Order of Business
  5, // Working 9:00-5:00
  7, // Payday
  9, // Clean Up
  11, // First Pizza Sold free radio
])

/** 合法的预备卡面值（-1 = 0元档，1=5，2=10，3=20） */
const RESERVE_CARD_VALUES = [-1, 1, 2, 3]

/**
 * 全部合法食物/饮料 id —— 与 FCMreference.js 的常量保持一致。
 * KIMCHI(8) 只有中国扩展的冰箱用，不是可生产品，故排除。
 */
const PRODUCIBLE_GOODS = [
  0, // LEMONADE
  1, // COKE
  2, // BEER
  3, // PIZZA
  4, // BURGER
  5, // COFFEE
  6, // NOODLES
  7, // SUSHI
  9, // DUMPLING
]

export class FCMActionLayer {
  /**
   * @param {object} deps
   * @param {() => object} deps.getStore  返回当前 pinia model store
   * @param {object} deps.modules         loadFCMModules() 的返回值
   * @param {object} deps.adapter         FCMAdapter 实例（用于 getLegalActions 交叉校验）
   */
  constructor({ getStore, modules, adapter }) {
    this._getStore = getStore
    this.modules = modules
    this.adapter = adapter
    this._getPlayerIndex = () => adapter?.playerIndex ?? null
    this.api = adapter?.api ?? null
  }

  get store() {
    return this._getStore()
  }

  /**
   * 执行一个动作
   *
   * @param {ActionSpec} spec
   * @param {object} opts
   * @param {number} opts.playerIndex  执行者座位号
   * @param {boolean} opts.dryRun      true = 只校验不落库（默认 false）
   * @param {boolean} opts.save        true = 执行后落库（默认 dryRun ? false : true）
   * @returns 执行结果摘要
   */
  async execute(spec, { playerIndex, dryRun = false, save = null } = {}) {
    const doSave = save === null ? !dryRun : save
    if (typeof playerIndex !== 'number') {
      throw new FCMActionError('必须提供 playerIndex')
    }
    if (!spec || typeof spec.type !== 'string') {
      throw new FCMActionError('必须提供 action.type')
    }
    if (playerIndex !== this.adapter.playerIndex) {
      throw new FCMActionError(
        `不能替座位 ${playerIndex} 操作；当前登录账号属于座位 ${this.adapter.playerIndex}`,
        'ACTOR_MISMATCH',
        '使用当前登录账号自己的座位，或为另一玩家启动独立 MCP 进程',
      )
    }

    // ── 闸门 1：必须是白名单里的 action 类型 ──────────────────────────
    if (!Object.values(ACTIONS).includes(spec.type)) {
      throw new FCMActionError(
        `非法操作类型 "${spec.type}"。允许的类型：${Object.values(ACTIONS).join(', ')}`,
      )
    }

    const phase = this.store.gameflow.phase
    if (!WRITABLE_PHASES.has(phase)) {
      throw new FCMActionError(`阶段 ${phase} 不支持写操作（只读阶段）`)
    }

    // ── 闸门 2：必须通过规则引擎的合法性校验 ─────────────────────────
    const legal = this.adapter.getLegalActions(playerIndex)
    const verdict = this._checkLegal(spec, legal, playerIndex)

    if (dryRun) {
      return {
        dryRun: true,
        action: spec,
        legal: verdict.ok,
        reason: verdict.reason,
        phase,
        phaseName: legal.phaseName,
        currentPlayerIndex: legal.currentPlayerIndex,
      }
    }

    if (!verdict.ok) {
      throw new FCMActionError(`规则引擎拒绝该操作：${verdict.reason}`)
    }

    // ── 闸门 3：全部走官方函数 ───────────────────────────────────────
    const before = this._snapshot()
    const applied = this._apply(spec, playerIndex)
    const completion = applied.completion
    delete applied.completion
    if (completion && typeof completion.then === 'function') {
      await completion
      this._assertLastWriteSucceeded()
    }
    const after = this._snapshot()

    let saveResult = null
    if (doSave && !applied.selfPersisted) {
      saveResult = await this._persist()
    }

    return {
      ok: true,
      action: spec,
      applied,
      before,
      after,
      saved: Boolean(doSave),
      saveResult,
      phase,
      phaseName: legal.phaseName,
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 合法性校验（对照 getLegalActions 的输出）
  // ────────────────────────────────────────────────────────────────
  _checkLegal(spec, legal, playerIndex) {
    const fail = (reason) => ({ ok: false, reason })

    if (!legal.yourTurn) {
      return fail(
        `不是座位 ${playerIndex} 的回合（当前该座位 ${legal.currentPlayerIndex} 行动）`,
      )
    }

    const types = legal.actions.map((a) => a.type)

    // produce / hire / place_employees 只在工作日合法；其余类型直接按列表判定
    if (!types.includes(spec.type)) {
      return fail(`当前阶段可用操作：${types.join(', ') || '(无)'}，不包含 "${spec.type}"`)
    }

    const rules = this.modules.rules
    const rf = this.modules.reference

    switch (spec.type) {
      case ACTIONS.PLACE_RESTAURANT: {
        // 与 MapHighlight.vue 的 setup 分支完全一致：
        //   model.addRestaurant(currentPlayerIndex(), index, rotation, true)
        const allowed = rules.givePossibleStartingRestaurantsPosition(
          this.store.context.rotation ?? 0,
        )
        if (!allowed.includes(spec.index)) {
          return fail(
            `位置 ${spec.index} 不是合法开局点位（当前旋转 ${this.store.context.rotation ?? 0}）`,
          )
        }
        if (this.store.players[playerIndex].restaurants.length > 0) {
          return fail('该玩家已经放过餐厅了')
        }
        return { ok: true }
      }

      case ACTIONS.HIRE: {
        const entry = legal.actions.find((a) => a.type === 'hire')
        const cand = (entry.candidates ?? []).find((c) => c.id === spec.employee)
        if (!cand) {
          const ids = (entry.candidates ?? []).map((c) => c.id).join(', ')
          return fail(`员工 ${spec.employee} 不在可招募列表里（可招募：${ids || '无'}）`)
        }
        if (rules.getRemainingRecruitingPoints(playerIndex) <= 0) {
          return fail('招募点数不足')
        }
        return { ok: true }
      }

      case ACTIONS.NEXT_SUBPHASE: {
        if (this.store.gameflow.phase !== 5) {
          return fail(`next_subphase 只用于工作日（当前阶段 ${this.store.gameflow.phase}）`)
        }
        return { ok: true }
      }

      case ACTIONS.TRAIN: {
        const SUBPHASE_TRAINING = 2
        if (this.store.gameflow.subphase !== SUBPHASE_TRAINING) {
          return fail(`当前子阶段 ${this.store.gameflow.subphase} 不能培训（需 TRAINING=2）`)
        }
        const entry = legal.actions.find((a) => a.type === 'train')
        const cands = entry?.available ?? []
        const hit = cands.find((x) => x.id === spec.employee)
        if (!hit) {
          return fail(
            `员工 ${spec.employee} 不可培训（可培训：${cands.map((x) => `${x.name}#${x.id}`).join(', ') || '无'}）`,
          )
        }
        if (spec.toEmployee == null) {
          return fail('必须指定 toEmployee；Agent 接口不保留只选择、不执行的临时 UI 状态')
        }
        const upgrade = hit.upgrades.find((u) => u.id === spec.toEmployee)
        if (!upgrade) {
          return fail(
            `员工 ${spec.employee} 不能升到 ${spec.toEmployee}（可升到：${hit.upgrades.map((u) => u.name).join(', ')}）`,
          )
        }
        if (spec.origin !== hit.origin) {
          return fail(`员工来源不匹配（应为 origin=${hit.origin}，收到 ${spec.origin}）`)
        }
        if (spec.steps !== upgrade.steps) {
          return fail(`培训步数不匹配（该升级需要 ${upgrade.steps}，收到 ${spec.steps}）`)
        }
        return { ok: true }
      }

      case ACTIONS.PLACE_EMPLOYEES: {
        const shop = this.store.players[playerIndex]
        const ids = spec.employees ?? []
        if (ids.length === 0) return fail('employees 不能为空')
        if (!Array.isArray(spec.slots) || spec.slots.length !== ids.length) {
          return fail('slots 与 employees 长度必须一致')
        }
        if (new Set(spec.slots).size !== spec.slots.length) {
          return fail('slots 不能包含重复位置')
        }
        for (const slot of spec.slots) {
          if (!Number.isInteger(slot) || slot < 0 || slot >= shop.employees.length) {
            return fail(`槽位 ${slot} 超出范围 (0..${shop.employees.length - 1})`)
          }
        }

        const ownedCounts = new Map()
        for (const employee of [...shop.beach, ...shop.employees]) {
          if (employee === rf.BLANK_EMPLOYEE_SPACE) continue
          ownedCounts.set(employee, (ownedCounts.get(employee) ?? 0) + 1)
        }
        const requestedCounts = new Map()
        for (const e of ids) {
          if (e === rf.BLANK_EMPLOYEE_SPACE) continue
          requestedCounts.set(e, (requestedCounts.get(e) ?? 0) + 1)
          if ((requestedCounts.get(e) ?? 0) > (ownedCounts.get(e) ?? 0)) {
            return fail(`员工 ${e} 的放置数量超过实际拥有数量`)
          }
        }
        return { ok: true }
      }

      case ACTIONS.PRODUCE: {
        // ★ 必须在 PRODUCE 子阶段（subphase === 4）才能生产。
        //   否则 remainingProducers 是空的，执行会破坏局面状态
        //   （实测：在 HIRING 子阶段生产会把员工 id 写进 resources）。
        const SUBPHASE_PRODUCE = 4
        if (this.store.gameflow.subphase !== SUBPHASE_PRODUCE) {
          return fail(
            `当前子阶段 ${this.store.gameflow.subphase} 不能生产（需先推进到生产子阶段 4）`,
          )
        }
        const entry = legal.actions.find((a) => a.type === 'produce')
        const producers = entry?.producers ?? []
        const selectedProducer = spec.producer

        if (typeof selectedProducer !== 'number') {
          return fail(`必须指定 producer（可用：${producers.map((p) => p.id).join(', ') || '无'}）`)
        }
        const producer = producers.find((candidate) => candidate.id === selectedProducer)
        if (!producer) {
          return fail(`生产者 ${selectedProducer} 当前不可用`)
        }

        if (!PRODUCIBLE_GOODS.includes(spec.item)) {
          return fail(
            `物品 ${spec.item} 不是合法的食物/饮料 id（可用：${PRODUCIBLE_GOODS.join(', ')}）`,
          )
        }
        const amt = Math.floor(spec.amount ?? 0)
        if (amt <= 0) return fail('生产数量必须 > 0')
        if (producers.length === 0) {
          return fail('当前没有可用的生产者')
        }

        if (producer.mode === 'collect' || (producer.goods ?? []).length === 0) {
          return fail('运输员工必须使用 collect_drinks 路线动作，不能直接生成资源')
        }
        if (!(producer.goods ?? []).includes(spec.item)) {
          return fail(`生产者 ${selectedProducer} 不能生产物品 ${spec.item}`)
        }

        // 普通员工的一次点击会由官方函数按员工类型决定实际产量
        // （厨师等可能一次生产多份），因此 Agent 只选择生产者和物品，
        // amount 固定为 1，不能把同一员工重复执行多次。
        if (amt !== 1) return fail('普通生产者的 amount 必须为 1')
        return { ok: true }
      }

      case ACTIONS.COLLECT_DRINKS: {
        if (this.store.gameflow.phase !== 5 || this.store.gameflow.subphase !== 4) {
          return fail('collect_drinks 只能在工作日生产子阶段执行')
        }
        const entry = legal.actions.find((action) => action.type === ACTIONS.COLLECT_DRINKS)
        if (!entry?.collectors?.some((collector) => collector.id === spec.producer)) {
          return fail(`运输员工 ${spec.producer} 当前不可用`)
        }
        if (!Array.isArray(spec.route) || spec.route.length === 0) {
          return fail('route 必须包含至少一个路线决策点')
        }
        if (!spec.route.every((point) => Number.isInteger(point) && point >= 0)) {
          return fail('route 只能包含非负整数地图位置')
        }
        return { ok: true }
      }

      case ACTIONS.MARKETING: {
        if (this.store.gameflow.phase !== 5 || this.store.gameflow.subphase !== 3) {
          return fail('marketing 只能在工作日营销子阶段执行')
        }
        const entry = legal.actions.find((action) => action.type === ACTIONS.MARKETING)
        const marketer = entry?.options?.find((option) => option.marketer === spec.marketer)
        if (!marketer) return fail(`营销员工 ${spec.marketer} 当前不可用`)
        const campaign = marketer.campaigns.find((option) => option.campaign === spec.campaign)
        if (!campaign) return fail(`广告活动 ${spec.campaign} 不适用于该营销员工`)
        if (!(entry.goods ?? []).includes(spec.good)) {
          return fail(`商品 ${spec.good} 不是基础游戏可营销商品`)
        }
        if (typeof spec.rotated !== 'boolean') return fail('rotated 必须明确为 true 或 false')
        const placement = campaign.placements.find((option) => option.rotated === spec.rotated)
        if (!placement?.legalSquares?.includes(spec.index)) {
          return fail(`位置 ${spec.index} 不是该广告活动当前旋转下的合法位置`)
        }
        if (campaign.durationInfinite) {
          if (spec.duration !== 9) return fail('该广告活动为无限期，duration 必须为 9')
        } else if (!Number.isInteger(spec.duration) || spec.duration < 1 ||
          spec.duration > campaign.maxDuration) {
          return fail(`广告时长必须在 1..${campaign.maxDuration} 之间`)
        }
        return { ok: true }
      }

      case ACTIONS.BUILD_HOUSE: {
        if (this.store.gameflow.phase !== 5 || this.store.gameflow.subphase !== 5) {
          return fail('build_house 只能在工作日建房与花园子阶段执行')
        }
        const entry = legal.actions.find((action) => action.type === ACTIONS.BUILD_HOUSE)
        if (!entry || entry.remainingBuilds <= 0) return fail('当前没有可用的新业务开发员')
        if (spec.building === 'house') {
          const house = entry.houses.find((option) => option.house === spec.house)
          const placement = house?.placements.find(
            (option) => option.rotation === spec.rotation,
          )
          if (!placement?.legalSquares?.includes(spec.index)) {
            return fail('房屋编号、旋转或位置不在当前合法选项中')
          }
          return { ok: true }
        }
        if (spec.building === 'garden') {
          const garden = entry.gardens.find((option) => option.house === spec.house)
          const edge = garden?.edges.find((option) => (
            option.edge === spec.edge && option.index === spec.index
          ))
          if (!garden || garden.houseIndex !== spec.houseIndex || !edge) {
            return fail('花园的房屋、边或位置不在当前合法选项中')
          }
          return { ok: true }
        }
        return fail('building 必须是 house 或 garden')
      }

      case ACTIONS.OPEN_RESTAURANT: {
        if (this.store.gameflow.phase !== 5 || this.store.gameflow.subphase !== 6) {
          return fail('open_restaurant 只能在工作日新餐厅子阶段执行')
        }
        const entry = legal.actions.find((action) => action.type === ACTIONS.OPEN_RESTAURANT)
        const manager = entry?.managers?.find((option) => option.manager === spec.manager)
        if (!manager) return fail(`经理 ${spec.manager} 当前不可用`)
        const action = manager.actions.find((option) => option.type === spec.restaurantAction)
        if (!action) return fail(`经理 ${spec.manager} 不能执行 ${spec.restaurantAction}`)
        if (spec.restaurantAction === 'move' && !action.restaurants.includes(spec.fromIndex)) {
          return fail(`餐厅 ${spec.fromIndex} 不属于当前玩家或不可搬迁`)
        }
        const placement = action.placements.find(
          (option) => option.rotation === spec.rotation,
        )
        if (!placement?.legalSquares?.includes(spec.index)) {
          return fail('新餐厅旋转或目标位置不在当前合法选项中')
        }
        return { ok: true }
      }

      case ACTIONS.PLACE_PIZZA_RADIO: {
        const entry = legal.actions.find(
          (action) => action.type === ACTIONS.PLACE_PIZZA_RADIO,
        )
        if (!entry) return fail('当前没有待处理的披萨广播里程碑')
        if (entry.legalSquares.length === 0) {
          return spec.skip === true
            ? { ok: true }
            : fail('没有合法位置时必须明确 skip=true')
        }
        if (spec.skip === true) return fail('仍有合法位置，不能跳过免费广播')
        if (!entry.legalSquares.includes(spec.index)) {
          return fail(`位置 ${spec.index} 不是披萨广播的合法位置`)
        }
        return { ok: true }
      }

      case ACTIONS.CHOOSE_TURN_ORDER: {
        const pos = spec.turnOrderPosition
        const nto = this.store.gameflow.newTurnOrder
        if (typeof pos !== 'number' || pos < 0 || pos >= nto.length) {
          return fail(`顺位 ${pos} 超出范围 (0..${nto.length - 1})`)
        }
        if (nto[pos] !== -1) return fail(`顺位 ${pos} 已被占`)
        return { ok: true }
      }

      case ACTIONS.CHOOSE_RESERVE_CARD: {
        const v = spec.cardValue ?? 3
        if (!RESERVE_CARD_VALUES.includes(v)) {
          return fail(`预备卡面值 ${v} 不合法（允许：${RESERVE_CARD_VALUES.join(', ')}）`)
        }
        if (this.store.players[playerIndex].restaurants.length === 0) {
          return fail('还没放餐厅，不能选预备卡')
        }
        return { ok: true }
      }

      case ACTIONS.RESOLVE_PAYDAY: {
        const entry = legal.actions.find((action) => action.type === ACTIONS.RESOLVE_PAYDAY)
        const fireEmployees = spec.fireEmployees ?? []
        const payWithResources = spec.payWithResources ?? []
        if (!Array.isArray(fireEmployees) || !Array.isArray(payWithResources)) {
          return fail('fireEmployees 和 payWithResources 必须是数组')
        }
        const withinCounts = (requested, available) => {
          const counts = new Map()
          for (const value of available ?? []) counts.set(value, (counts.get(value) ?? 0) + 1)
          for (const value of requested) {
            const left = counts.get(value) ?? 0
            if (left <= 0) return false
            counts.set(value, left - 1)
          }
          return true
        }
        if (!withinCounts(fireEmployees, entry?.fireableEmployees)) {
          return fail('包含不可解雇或数量超过实际拥有的员工')
        }
        if (!withinCounts(payWithResources, entry?.payableResources)) {
          return fail('包含不可用于发薪或数量超过实际拥有的资源')
        }
        const payUnitsBeforeFiring = rules.numPayNeeded?.(playerIndex)
        if (Number.isFinite(payUnitsBeforeFiring)) {
          // 每解雇一名需要薪资的员工，就少一个支付单位。在任何状态改动前
          // 拒绝“多扔食物”，防止 Agent 即使只提交了真实拥有的资源，
          // 仍能消耗超过薪资所需的数量。
          const salaryEmployees = new Set(rf?.REQUIRE_SALARY ?? [])
          const firedPayUnits = fireEmployees.filter((employee) => salaryEmployees.has(employee)).length
          const remainingPayUnits = Math.max(0, payUnitsBeforeFiring - firedPayUnits)
          if (payWithResources.length > remainingPayUnits) {
            return fail(
              `资源支付数 ${payWithResources.length} 超过解雇后剩余薪资所需 ${remainingPayUnits}`,
            )
          }
        }
        if (!entry?.currentlyAffordable && fireEmployees.length === 0 && payWithResources.length === 0) {
          return fail('当前无法支付薪资，必须提供解雇或资源支付方案')
        }
        return { ok: true }
      }

      case ACTIONS.RESOLVE_CLEANUP: {
        const entry = legal.actions.find((action) => action.type === ACTIONS.RESOLVE_CLEANUP)
        const discards = spec.discardResources ?? []
        if (!Array.isArray(discards)) return fail('discardResources 必须是数组')
        const allResources = [...(entry?.resources ?? [])]
        let resources = allResources
        let minimumDiscardCount = entry?.minimumDiscardCount ?? 0
        if (entry?.requiresFridgeChoice) {
          if (!['kimchi', 'rest'].includes(spec.fridgeChoice)) {
            return fail('泡菜冲突时必须指定 fridgeChoice=kimchi 或 rest')
          }
          const kimchi = this.modules.reference?.KIMCHI
          resources = allResources.filter((resource) => (
            spec.fridgeChoice === 'kimchi' ? resource === kimchi : resource !== kimchi
          ))
          minimumDiscardCount = spec.fridgeChoice === 'kimchi'
            ? 0
            : Math.max(0, resources.length - 10)
        }
        for (const resource of discards) {
          const index = resources.indexOf(resource)
          if (index < 0) return fail(`资源 ${resource} 不可丢弃或数量超过实际拥有数量`)
          resources.splice(index, 1)
        }
        if (discards.length < minimumDiscardCount) {
          return fail(`至少需要丢弃 ${minimumDiscardCount} 个资源`)
        }
        if (!entry?.requiresFridgeChoice && spec.fridgeChoice != null) {
          return fail('当前没有泡菜冲突，不能提交 fridgeChoice')
        }
        return { ok: true }
      }

      case ACTIONS.FINISH_TURN:
        return { ok: true }

      case ACTIONS.END_TURN:
        return { ok: true }

      default:
        return fail('未知操作类型')
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 执行（全部调用官方导出函数）
  // ────────────────────────────────────────────────────────────────
  _apply(spec, playerIndex) {
    const c = this.modules.controller
    const rf = this.modules.reference
    const applied = { type: spec.type }

    switch (spec.type) {
      case ACTIONS.PLACE_RESTAURANT: {
        const m = this.modules.model
        m.addRestaurant(playerIndex, spec.index, this.store.context.rotation ?? 0, true)
        applied.index = spec.index
        applied.rotation = this.store.context.rotation ?? 0
        break
      }

      case ACTIONS.HIRE: {
        c.hireEmployee(spec.employee)
        applied.employee = spec.employee
        break
      }

      case ACTIONS.TRAIN: {
        // 官方链路（ActionAreaWorkingDay.vue）：先 selectEmployeeToTrain 设状态，
        // 再 trainEmployee(toEmp, steps) 执行。
        //   origin: 0 = beach 待命区, 2 = at work 已上岗, 1 = just hired（本次招募）
        const fromId = spec.employee
        const toId = spec.toEmployee
        const origin = spec.origin ?? 0
        this.store.context.selectedEmployeeToTrainData.employee = fromId
        this.store.context.selectedEmployeeToTrainData.origin = origin
        applied.employee = fromId
        applied.toEmployee = toId
        applied.origin = origin
        if (toId != null) {
          c.trainEmployee(toId, spec.steps ?? 1)
          applied.trained = true
        } else {
          applied.deferred = true
        }
        break
      }

      case ACTIONS.NEXT_SUBPHASE: {
        // 官方 UI：@click="controller.endWorkingDaySubphase()"
        // 逐个子阶段推进：HIRING → TRAINING → MARKETING → PRODUCE → ...
        c.endWorkingDaySubphase()
        applied.subphaseAfter = this.store.gameflow.subphase
        break
      }

      case ACTIONS.PLACE_EMPLOYEES: {
        for (let i = 0; i < spec.slots.length; i++) {
          this.modules.player.setEmployeeInIndex(playerIndex, spec.employees[i], spec.slots[i])
        }
        applied.slots = spec.slots
        applied.employees = spec.employees
        // Phase 3（重组）是同时阶段：派完工还要 endTurn 才提交 move
        if (this.store.gameflow.phase === 3) applied.deferred = true
        break
      }

      case ACTIONS.PRODUCE: {
        // The official controller decides the amount produced for cooks and
        // leaves an item choice for employees such as kitchen trainees.
        c.clickedProducer(spec.producer)
        if (this.store.context.producer === spec.producer) {
          c.addProducedItemToPlayer(spec.item)
        }
        applied.item = spec.item
        applied.amount = spec.amount
        break
      }

      case ACTIONS.COLLECT_DRINKS: {
        const isZeppelin = spec.producer === rf.ZEPPELIN_PILOT
        c.clickedProducer(spec.producer)
        for (const point of spec.route) {
          const allowed = isZeppelin
            ? this.store.highlights.tilesToHighlight
            : this.store.highlights.indexesToHighlightYellow
          if (!allowed?.includes(point)) {
            throw new FCMActionError(`路线决策点 ${point} 不是当前高亮的合法位置`)
          }
          if (isZeppelin) c.selectNextTile(point)
          else c.selectNextPosition(point)
        }
        if (this.store.context.producer === spec.producer) c.stopCollecting()
        applied.producer = spec.producer
        applied.route = [...spec.route]
        break
      }

      case ACTIONS.MARKETING: {
        c.selectMarketer(spec.marketer)
        c.chooseCampaign(spec.campaign)
        c.chooseGood(spec.good)
        c.chooseDuration(spec.duration)
        if (spec.rotated) c.rotateCampaign()
        c.placeMarketingCampaign(spec.index)
        applied.marketer = spec.marketer
        applied.campaign = spec.campaign
        applied.good = spec.good
        applied.duration = spec.duration
        applied.rotated = spec.rotated
        applied.index = spec.index
        break
      }

      case ACTIONS.BUILD_HOUSE: {
        if (spec.building === 'house') {
          c.selectHouseToBuild(spec.house)
          // 官方 Vue 旋转控件也是直接写 context.rotation，再刷新高亮。
          this.store.context.rotation = spec.rotation
          c.updateHousesHighlights()
          c.clickedHouseSquare(spec.index)
        } else {
          c.selectGardenToBuild()
          c.chooseHouseForGarden(spec.houseIndex)
          // 唯一可用边会由 chooseHouseForGarden 自动完成；多边时继续选择。
          if ((this.store.context.edges ?? []).length > 0) {
            c.chooseHouseEdge(spec.edge, -1)
          }
        }
        applied.building = spec.building
        applied.house = spec.house
        applied.index = spec.index
        if (spec.building === 'house') applied.rotation = spec.rotation
        else applied.edge = spec.edge
        break
      }

      case ACTIONS.OPEN_RESTAURANT: {
        c.selectManager(spec.manager)
        if (spec.restaurantAction === 'move') {
          c.chooseBuildAction('move')
          c.removeRestaurantForMove(spec.fromIndex)
        } else if (spec.manager === rf.REGIONAL_MANAGER) {
          c.chooseBuildAction('create')
        }
        this.store.context.rotation = spec.rotation
        c.setNewRestaurantPlacementHighlights()
        if (!this.store.highlights.indexesToHighlightYellow.includes(spec.index)) {
          throw new FCMActionError('移除餐厅后目标位置不再合法')
        }
        c.chooseRestaurantPositionForWorking(spec.index)
        applied.restaurantAction = spec.restaurantAction
        applied.manager = spec.manager
        applied.fromIndex = spec.fromIndex ?? null
        applied.index = spec.index
        applied.rotation = spec.rotation
        break
      }

      case ACTIONS.PLACE_PIZZA_RADIO: {
        const completion = spec.skip
          ? c.skipPizzaBombMarketer()
          : c.choosePizzaBombMarketer(spec.index)
        applied.index = spec.index ?? null
        applied.skipped = Boolean(spec.skip)
        if (completion && typeof completion.then === 'function') {
          applied.completion = completion
          applied.selfPersisted = true
        }
        break
      }

      case ACTIONS.CHOOSE_TURN_ORDER: {
        c.chooseTurnOrderPosition(spec.turnOrderPosition)
        applied.turnOrderPosition = spec.turnOrderPosition
        applied.deferred = true // 选完顺位还要再 endTurn 才推进
        break
      }
      case ACTIONS.CHOOSE_RESERVE_CARD: {
        // 与 ActionArea.vue 的 localEndTurn() 一致：先落卡，再结束回合。
        // 只落卡不结束 → 阶段不推进，所以这里必须一起做。
        const v = spec.cardValue ?? 3
        this.store.reserveCards[playerIndex] = v
        applied.cardValue = v
        applied.deferred = true // 结束回合由上层调 endTurn()
        break
      }

      case ACTIONS.RESOLVE_PAYDAY: {
        for (const employee of spec.fireEmployees ?? []) {
          this.modules.player.fireEmployee(playerIndex, employee)
          this.store.availableEmployees[employee] =
            (this.store.availableEmployees[employee] ?? 0) + 1
          this.store.context.justFired.push(employee)
        }
        for (const resource of spec.payWithResources ?? []) {
          this.modules.player.removeResourcesFromPlayer(playerIndex, resource, 1)
          this.store.context.preMoveData[0][1].push(resource)
        }
        const rules = this.modules.rules
        const paidCount = this.store.context.preMoveData[0][1].length
        const paysLeft = Math.max(0, (rules.numPayNeeded?.(playerIndex) ?? 0) - paidCount)
        const canFinish = paysLeft === 0 || Boolean(rules.canPayWithMoney?.(playerIndex, paysLeft))
        if (!canFinish) {
          throw new FCMActionError('发薪方案仍不足以支付剩余薪资')
        }
        applied.fireEmployees = [...(spec.fireEmployees ?? [])]
        applied.payWithResources = [...(spec.payWithResources ?? [])]
        applied.deferred = true
        break
      }

      case ACTIONS.RESOLVE_CLEANUP: {
        if (spec.fridgeChoice) this.modules.controller.chooseFridgeType(spec.fridgeChoice)
        for (const resource of spec.discardResources ?? []) {
          this.modules.controller.binResource(resource)
        }
        if (
          (this.store.players[playerIndex]?.resources?.length ?? 0) > 10 ||
          this.modules.rules?.kimchiFridgeCollision?.(playerIndex)
        ) {
          throw new FCMActionError('清理方案完成后仍有超过冰箱容量的资源或泡菜冲突')
        }
        applied.discardResources = [...(spec.discardResources ?? [])]
        applied.fridgeChoice = spec.fridgeChoice ?? null
        applied.deferred = true
        break
      }

      case ACTIONS.FINISH_TURN:
      case ACTIONS.END_TURN: {
        // endPlayerTurn 是 async，且内部会自己落库
        applied.deferred = true
        break
      }

      default:
        throw new FCMActionError(`未实现：${spec.type}`)
    }
    return applied
  }

  /**
   * 结束当前玩家的回合
   *
   * ★ 两条路径（由官方 endPlayerTurn 内部自己分派）：
   *   - 轮替阶段 → saveGameNormal
   *   - 同时阶段（选预备卡/重组/发薪/清理）→ saveSimulMove
   *
   * ★ 同时阶段的关键：服务器只负责聚合各玩家的 move。
   *   当最后一个玩家提交后，服务器返回 allPlayersMoved=true + 汇总 moveData，
   *   **必须由客户端** 跑完剩下的收尾（FCM_IO.js:868-882）：
   *     processSimulMoveData → deleteMoveData → endCurrentPhase → saveGameNormal
   *   不做这一步，阶段永远停在原地（这是我之前打出死循环的根因）。
   */
  async endTurn(forced = false, playerIndex = null) {
    const idx = playerIndex ?? this._getPlayerIndex?.() ?? null
    if (idx === null) throw new FCMActionError('endTurn 需要 playerIndex')
    if (idx !== this.adapter.playerIndex) {
      throw new FCMActionError(
        `不能替座位 ${idx} 结束回合；当前登录账号属于座位 ${this.adapter.playerIndex}`,
        'ACTOR_MISMATCH',
        '为对应玩家启动独立 MCP 进程',
      )
    }

    // 同时阶段里 endPlayerTurn 用 personal.pov 决定"谁提交了 move"
    setPersonalState({
      gameID: this.adapter?.currentGameID ?? this.api?.gameID ?? null,
      name: this.store.players[idx]?.name ?? this.api?.username ?? null,
      pov: idx,
      latestUpdate: this.api?.latestUpdate ?? '-1',
    })

    const c = this.modules.controller
    const isSimul = c.isSimulPhase(this.store.gameflow.phase)
    const before = this.store.gameflow.phase

    // ★ 诊断打点：提交瞬间的真实状态（排查空 move 问题）
    if (process.env.FCM_TRACE_ENDTURN === '1') {
      const p = this.modules.personalMod?.usePersonalStore?.()
      console.error(
        `[TRACE endTurn] idx=${idx} phase=${this.store.gameflow.phase} ` +
          `turnOrder=${JSON.stringify(this.store.gameflow.turnOrder)} ` +
          `isSimul=${isSimul} personal.pov=${p?.pov} personal.name=${p?.name} ` +
          `personal.trainingGame=${p?.trainingGame} latestUpdate=${this.api?.latestUpdate}`,
      )
    }

    // ★ 官方 endPlayerTurn 内部已完整实现两条路径：
    //   轮替阶段 → saveGameNormal
    //   同时阶段 → saveSimulMove（含"最后一人提交后"的
    //              processSimulMoveData → deleteMoveData →
    //              endCurrentPhase → saveGameNormal 全套收尾）
    //   所以这里只需要把 pov / latestUpdate 设好，然后调用它 —— 不要自己重写。
    globalThis.__fcmLastWriteResult = null
    await withDbWriteLock(() => c.endPlayerTurn(forced, false))
    this._assertLastWriteSucceeded()

    const after = this.store.gameflow.phase
    // 内存里的 latestUpdate 可能已被内部更新，同步回 api
    try {
      this.api.latestUpdate = String(this.modules.personalMod?.usePersonalStore?.().latestUpdate ?? this.api.latestUpdate)
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      ended: true,
      forced,
      seat: idx,
      simul: isSimul,
      phaseBefore: before,
      phaseAfter: after,
      phaseAdvanced: before !== after,
    }
  }

  /**
   * 构造本座位在同时阶段要提交的 moveData。
   * 与 FCMcontroller.endPlayerTurn 的 simul 分支保持一致（第 1771-1795 行）。
   */
  _buildSimulMoveData(playerIndex) {
    const store = this.store
    const rf = this.modules.reference
    const phase = store.gameflow.phase
    const playerObj = store.players[playerIndex]
    let moveData = []

    if (phase === 2) {
      // SETUP_RESERVE：只提交选的预备卡
      moveData.push(store.reserveCards[playerIndex])
    } else if (phase === 3) {
      // RESTRUCTURING：beach + employees + OOBpreference
      const employees = [...(playerObj.employees ?? [])].filter((e) => e !== rf.BLANK_EMPLOYEE_SPACE)
      playerObj.employees = employees
      moveData.push([...(playerObj.beach ?? [])])
      moveData.push([...employees])
      moveData.push(parseInt(playerObj.OOBpreference ?? 0))
    } else if (phase === 7) {
      // PAYDAY
      const justFired = [...(store.context.justFired ?? [])]
      const paidInFood = [...(store.context.preMoveData?.[0]?.[1] ?? [])]
      let paydayMoveData = [[...justFired], [...paidInFood]]
      if (paydayMoveData[0].length === 0) paydayMoveData[0] = [-8]
      let cleanup = [...(store.context.preMoveData?.[1] ?? [])]
      if (cleanup.length === 0) cleanup = [-9]
      moveData = [[...paydayMoveData], [...cleanup]]
      store.context.preMoveData = [...moveData]
    } else if (phase === 9) {
      // CLEAN_UP
      let cleanupMoveData = [...(store.context.justBinned ?? [])]
      if (cleanupMoveData.length === 0) cleanupMoveData = [-8]
      moveData = [[[-9], []], [...cleanupMoveData]]
      store.context.preMoveData = [...moveData]
    } else {
      moveData = [null]
    }
    return moveData
  }

  // ────────────────────────────────────────────────────────────────
  // 落库 —— 与人类玩家完全同一条路径
  // ────────────────────────────────────────────────────────────────
  async _persist() {
    const IO = this.modules.backendIO
    if (!IO?.saveGameNormal) {
      throw new FCMActionError('FCM_IO.saveGameNormal 不可用，无法落库')
    }
    globalThis.__fcmLastWriteResult = null
    await withDbWriteLock(() => IO.saveGameNormal(true, false, false))
    const write = this._assertLastWriteSucceeded()
    if (write.body?.latestUpdate != null) {
      this.api.latestUpdate = String(write.body.latestUpdate)
    }
    return {
      via: 'saveGameNormal',
      latestUpdate: write.body?.latestUpdate ?? null,
    }
  }

  _assertLastWriteSucceeded() {
    const write = globalThis.__fcmLastWriteResult
    if (!write) {
      throw new FCMSystemError(
        '保存函数没有产生可验证的服务器响应',
        'WRITE_RESULT_MISSING',
        '重新读取游戏状态；如果状态未变化，请检查 Django 日志和网络连接',
      )
    }
    if (write.status < 200 || write.status >= 300) {
      throw new FCMSystemError(
        `服务器拒绝保存（HTTP ${write.status}）`,
        'WRITE_FAILED',
        '检查 Django 日志后重新读取局面',
      )
    }
    if (write.parsed === false || write.body === null || typeof write.body !== 'object') {
      throw new FCMSystemError(
        '保存接口返回了不可解析或非 JSON 的响应，无法确认动作是否写入',
        'INVALID_WRITE_RESPONSE',
        '重新读取游戏状态确认结果，并检查 Django 日志',
      )
    }
    if (write.body?.syncError) {
      throw new FCMSystemError(
        '局面已被其他玩家更新，本次动作没有写入',
        'STALE_STATE',
        '调用 fcm_get_state 和 fcm_list_legal_actions 获取最新版本后重试',
      )
    }
    if (write.body?.gameNotActive) {
      throw new FCMSystemError('游戏当前不可写', 'GAME_NOT_ACTIVE', '重新读取游戏状态')
    }
    if (!write.ok) {
      throw new FCMSystemError(
        `服务器拒绝保存（HTTP ${write.status}）`,
        'WRITE_FAILED',
        '检查 Django 日志后重新读取局面',
      )
    }
    return write
  }

  _snapshot() {
    const s = this.store
    const copy = (value, fallback = []) => JSON.parse(JSON.stringify(value ?? fallback))
    return {
      phase: s.gameflow.phase,
      subphase: s.gameflow.subphase,
      turnOrder: [...(s.gameflow.turnOrder ?? [])],
      fullTurnOrder: [...(s.gameflow.fullTurnOrder ?? [])],
      startingOptions: copy(s.startingOptions, {}),
      bank: s.bank,
      bankBroken: s.bankBroken,
      board: {
        tiles: copy(s.mapData?.tiles),
        dimensions: copy(s.mapData?.dimensions),
        houses: copy(s.houses),
        gardens: copy(s.gardens),
        needs: copy(s.needs),
        campaigns: copy(s.campaigns),
        freeways: copy(s.freeways),
        parks: copy(s.parks),
        newRoads: copy(s.newRoads),
      },
      supply: {
        availableEmployees: copy(s.availableEmployees),
        availableMilestones: copy(s.availableMilestones),
        availableMarketingCampaigns: copy(s.availableMarketingCampaigns),
      },
      players: s.players.map((p) => ({
        name: p.displayName ?? p.name,
        money: p.money,
        bankrupt: Boolean(p.bankrupt),
        resources: [...(p.resources ?? [])],
        employees: [...(p.employees ?? [])],
        beach: [...(p.beach ?? [])],
        restaurants: (p.restaurants ?? []).map((r) => ({ ...r })),
        milestones: copy(p.milestones),
        marketers: copy(p.marketers),
        coffeeShops: copy(p.coffeeShops),
        ceoSlots: p.ceoSlots,
      })),
      history: copy(s.history),
      chat: copy(s.chatData),
      untrustedTextFields: ['chat'],
    }
  }
}

export { WRITABLE_PHASES }
