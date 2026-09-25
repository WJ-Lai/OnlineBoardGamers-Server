/**
 * Canonical metadata for every FCM Agent action.
 *
 * Rule behavior still delegates to the existing FCM modules. This registry owns
 * the transport name, input shape, and command-completion semantics so MCP,
 * CLI, HTTP, and the action layer cannot silently invent different contracts.
 */

const field = {
  index: { type: 'integer', minimum: 0 },
  rotation: { type: 'integer' },
  cardValue: { type: 'integer', enum: [-1, 1, 2, 3] },
  employee: { type: 'integer' },
  toEmployee: { type: 'integer' },
  origin: { type: 'integer', enum: [0, 1, 2] },
  steps: { type: 'integer', minimum: 1 },
  slots: { type: 'array', maxItems: 100, items: { type: 'integer' } },
  employees: { type: 'array', maxItems: 100, items: { type: 'integer' } },
  producer: { type: 'integer' },
  item: { type: 'integer' },
  amount: { type: 'integer', minimum: 1 },
  route: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 0 } },
  marketer: { type: 'integer' },
  campaign: { type: 'integer', minimum: 1, maximum: 16 },
  good: { type: 'integer', minimum: 0, maximum: 4 },
  duration: { type: 'integer', minimum: 1, maximum: 9 },
  rotated: { type: 'boolean' },
  building: { type: 'string', enum: ['house', 'garden'] },
  house: { type: 'integer', minimum: 0 },
  houseIndex: { type: 'integer', minimum: 0 },
  edge: { type: 'integer', minimum: 0, maximum: 3 },
  restaurantAction: { type: 'string', enum: ['create', 'move'] },
  manager: { type: 'integer' },
  fromIndex: { type: 'integer', minimum: 0 },
  skip: { type: 'boolean' },
  turnOrderPosition: { type: 'integer', minimum: 0 },
  fireEmployees: { type: 'array', maxItems: 100, items: { type: 'integer' } },
  payWithResources: { type: 'array', maxItems: 100, items: { type: 'integer' } },
  discardResources: { type: 'array', maxItems: 100, items: { type: 'integer' } },
  fridgeChoice: { type: 'string', enum: ['kimchi', 'rest'] },
}

function define(type, propertyNames = [], { finishesTurn = false, exposed = true } = {}) {
  return Object.freeze({
    type,
    finishesTurn,
    exposed,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        type: Object.freeze({ type: 'string', const: type }),
        ...Object.fromEntries(propertyNames.map((name) => [name, field[name]])),
      }),
      required: Object.freeze(['type']),
      additionalProperties: false,
    }),
  })
}

export const ACTION_DEFINITIONS = Object.freeze({
  PLACE_RESTAURANT: define('place_restaurant', ['index', 'rotation']),
  CHOOSE_RESERVE_CARD: define('choose_reserve_card', ['cardValue'], { finishesTurn: true }),
  HIRE: define('hire', ['employee']),
  PLACE_EMPLOYEES: define('place_employees', ['slots', 'employees'], { finishesTurn: true }),
  PRODUCE: define('produce', ['producer', 'item', 'amount']),
  COLLECT_DRINKS: define('collect_drinks', ['producer', 'route']),
  TRAIN: define('train', ['employee', 'toEmployee', 'origin', 'steps']),
  MARKETING: define('marketing', ['marketer', 'campaign', 'good', 'duration', 'rotated', 'index']),
  BUILD_HOUSE: define('build_house', ['building', 'house', 'houseIndex', 'edge', 'rotation', 'index']),
  OPEN_RESTAURANT: define('open_restaurant', ['restaurantAction', 'manager', 'fromIndex', 'rotation', 'index']),
  PLACE_PIZZA_RADIO: define('place_pizza_radio', ['campaign', 'house', 'index', 'skip']),
  NEXT_SUBPHASE: define('next_subphase'),
  CHOOSE_TURN_ORDER: define('choose_turn_order', ['turnOrderPosition'], { finishesTurn: true }),
  RESOLVE_PAYDAY: define('resolve_payday', ['fireEmployees', 'payWithResources'], { finishesTurn: true }),
  RESOLVE_CLEANUP: define('resolve_cleanup', ['discardResources', 'fridgeChoice'], { finishesTurn: true }),
  FINISH_TURN: define('finish_turn', [], { finishesTurn: true, exposed: false }),
  END_TURN: define('end_turn', [], { finishesTurn: true }),
})

export const ACTIONS = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_DEFINITIONS).map(([key, definition]) => [key, definition.type]),
))

export const ACTION_PROPERTIES = Object.freeze({
  type: Object.freeze({
    type: 'string',
    enum: Object.freeze(
      Object.values(ACTION_DEFINITIONS)
        .filter((definition) => definition.exposed)
        .map((definition) => definition.type),
    ),
  }),
  ...field,
})

export const ACTION_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: ACTION_PROPERTIES,
  required: Object.freeze(['type']),
  additionalProperties: false,
})

const DEFINITIONS_BY_TYPE = new Map(
  Object.values(ACTION_DEFINITIONS).map((definition) => [definition.type, definition]),
)

export function getActionDefinition(type) {
  const definition = DEFINITIONS_BY_TYPE.get(type)
  if (!definition) throw new Error(`Unknown FCM action: ${type}`)
  return definition
}

export function actionFinishesTurn(type) {
  return getActionDefinition(type).finishesTurn
}
