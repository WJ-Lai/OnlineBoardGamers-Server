import { buildEngineMetadata, normalizeEngineSnapshot, seededRandom } from './engine-contract.mjs'
import { FCMAdapter } from './fcm-adapter.mjs'
import { actionFinishesTurn, getActionDefinition } from './action-registry.mjs'
import { AuthoritativeTransport } from './authoritative-transport.mjs'
import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })
const actionValidators = new Map()

function invalidCommand(message) {
  const error = new Error(message)
  error.code = 'INVALID_ENGINE_COMMAND'
  return error
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCommand(`${label} must be an object`)
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    throw invalidCommand(`unknown ${label} fields: ${unknown.sort().join(', ')}`)
  }
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 64) {
    throw invalidCommand('actions must contain 1..64 actions')
  }
  for (const [index, action] of actions.entries()) {
    let definition
    try {
      definition = getActionDefinition(action?.type)
    } catch {
      throw invalidCommand(`actions[${index}] has an unknown type`)
    }
    if (!definition.exposed) throw invalidCommand(`actions[${index}] is internal-only`)
    let validate = actionValidators.get(definition.type)
    if (!validate) {
      validate = ajv.compile(definition.inputSchema)
      actionValidators.set(definition.type, validate)
    }
    if (!validate(action)) {
      throw invalidCommand(`actions[${index}] is invalid: ${ajv.errorsText(validate.errors)}`)
    }
  }
  for (let index = 0; index < actions.length - 1; index += 1) {
    if (actionFinishesTurn(actions[index].type)) {
      throw invalidCommand('a turn-completing action must be the final action')
    }
  }
  const lastType = actions.at(-1).type
  if (!actionFinishesTurn(lastType) && !['next_subphase', 'place_pizza_radio'].includes(lastType)) {
    throw codedError(
      'INCOMPLETE_COMMAND',
      'the action batch must end the turn or advance the working-day subphase',
    )
  }
}

async function loadDeterministicSnapshot(adapter, snapshot, actor) {
  if (snapshot.blob || snapshot.initializationSeed == null) {
    return adapter.loadSnapshot(snapshot, actor)
  }
  const originalRandom = Math.random
  Math.random = seededRandom(snapshot.initializationSeed)
  try {
    return await adapter.loadSnapshot(snapshot, actor)
  } finally {
    Math.random = originalRandom
  }
}

export class EngineRuntime {
  constructor({
    createAdapter = () => new FCMAdapter({ username: null, jar: null }),
    metadata = buildEngineMetadata,
  } = {}) {
    this.createAdapter = createAdapter
    this.metadata = metadata
  }

  async inspect(command) {
    exactKeys(command, new Set(['snapshot', 'actor']), 'engine command')
    exactKeys(command.actor, new Set(['name', 'seat']), 'actor')
    const { name, seat } = command.actor
    if (typeof name !== 'string' || !name || !Number.isInteger(seat) || seat < 0) {
      throw invalidCommand('actor.name and actor.seat are required')
    }

    const snapshot = normalizeEngineSnapshot(command.snapshot)
    const adapter = this.createAdapter()
    await loadDeterministicSnapshot(adapter, snapshot, { actorName: name, actorSeat: seat })
    const [engine, state, legalActions] = await Promise.all([
      this.metadata(),
      Promise.resolve(adapter.getState()),
      Promise.resolve(adapter.getLegalActions(seat)),
    ])
    return {
      ...engine,
      gameID: snapshot.id,
      version: snapshot.latestUpdate,
      state,
      legalActions,
    }
  }

  async executeBatch(command) {
    exactKeys(
      command,
      new Set(['snapshot', 'actor', 'expectedVersion', 'actions', 'transportContext']),
      'engine command',
    )
    exactKeys(command.actor, new Set(['name', 'seat']), 'actor')
    const snapshot = normalizeEngineSnapshot(command.snapshot)
    if (String(command.expectedVersion) !== snapshot.latestUpdate) {
      throw codedError('STALE_STATE', 'expectedVersion does not match the server snapshot')
    }
    validateActions(command.actions)
    const { name, seat } = command.actor
    if (typeof name !== 'string' || !name || !Number.isInteger(seat) || seat < 0) {
      throw invalidCommand('actor.name and actor.seat are required')
    }

    const adapter = this.createAdapter()
    await loadDeterministicSnapshot(adapter, snapshot, { actorName: name, actorSeat: seat })
    const transportContext = command.transportContext ?? {}
    exactKeys(
      transportContext,
      new Set([
        'existingMoves', 'pendingPlayerNames', 'acceptedPhases', 'nextVersion', 'sideData',
      ]),
      'transportContext',
    )
    const transport = new AuthoritativeTransport({
      actorName: name,
      existingMoves: transportContext.existingMoves ?? [],
      pendingPlayerNames: transportContext.pendingPlayerNames ?? [],
      acceptedPhases: transportContext.acceptedPhases ?? [],
      nextVersion: transportContext.nextVersion ?? snapshot.latestUpdate,
      sideData: transportContext.sideData ?? '',
    })
    const previousTransport = globalThis.__fcmLocalTransport
    globalThis.__fcmLocalTransport = transport.fetch
    try {
      for (const [index, action] of command.actions.entries()) {
        if (action.type === 'end_turn') {
          if (index !== command.actions.length - 1) {
            throw invalidCommand('end_turn must be the final action')
          }
          const legal = adapter.getLegalActions(seat)
          if (!legal.yourTurn || !legal.actions.some((item) => item.type === 'finish_turn')) {
            throw codedError('ILLEGAL_ACTION', 'the official rules do not allow ending this turn')
          }
          continue
        }
        await adapter.doAction(action, { playerIndex: seat, save: false })
      }
      const lastType = command.actions.at(-1).type
      if (actionFinishesTurn(lastType)) await adapter.endTurn(false, seat)
    } finally {
      globalThis.__fcmLocalTransport = previousTransport
    }

    const state = adapter.getState()
    const legalActions = adapter.getLegalActions(seat)
    state.version = String(transportContext.nextVersion ?? snapshot.latestUpdate)
    const turnOrder = state.turnOrder ?? []
    const nextSeatIndexes = legalActions.isSimulPhase ? turnOrder : turnOrder.slice(0, 1)
    const syntheticSave = {
      action: 'saveNormal',
      gameID: snapshot.id,
      gameData: adapter.exportBlob(false),
      phase: state.phase,
      turn: state.turn,
      nextPlayer: nextSeatIndexes.map(
        (index) => state.players?.[index]?.name,
      ).filter(Boolean),
    }
    const capturedSave = transport.canonicalSave ?? (
      transport.simultaneousSubmission ? null : syntheticSave
    )
    // The legacy FCM controller emits displayName values in nextPlayer. Agent labels
    // are presentation-only; convert them back to stable internal account names
    // before Django validates membership and commits the turn.
    const displayToActor = new Map(
      (snapshot.displayNames ?? snapshot.playerNames).map(
        (displayName, index) => [displayName, snapshot.playerNames[index]],
      ),
    )
    const canonicalSave = capturedSave == null ? null : {
      ...capturedSave,
      nextPlayer: (capturedSave.nextPlayer ?? []).map(
        (name) => displayToActor.get(name) ?? name,
      ),
    }
    return {
      ...(await this.metadata()),
      gameID: snapshot.id,
      beforeVersion: snapshot.latestUpdate,
      actions: command.actions,
      canonicalSave,
      simultaneousSubmission: transport.simultaneousSubmission,
      transportRequests: transport.requests,
      state,
      legalActions,
    }
  }
}
