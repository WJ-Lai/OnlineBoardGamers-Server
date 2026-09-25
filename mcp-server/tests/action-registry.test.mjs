import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIONS,
  ACTION_DEFINITIONS,
  ACTION_INPUT_SCHEMA,
  actionFinishesTurn,
} from '../action-registry.mjs'
import { ACTIONS as ACTION_LAYER_ACTIONS } from '../action-layer.mjs'
import { TOOLS } from '../server.mjs'

test('one registry owns action names, input schema, and turn-completion metadata', () => {
  const definitions = Object.values(ACTION_DEFINITIONS)
  const registeredTypes = definitions.map((definition) => definition.type)

  assert.equal(new Set(registeredTypes).size, registeredTypes.length)
  assert.deepEqual(new Set(Object.values(ACTIONS)), new Set(registeredTypes))
  assert.strictEqual(ACTION_LAYER_ACTIONS, ACTIONS)

  const executeTool = TOOLS.find((tool) => tool.name === 'fcm_execute_action')
  assert.ok(executeTool)
  assert.strictEqual(executeTool.inputSchema.properties.action, ACTION_INPUT_SCHEMA)

  for (const definition of definitions) {
    assert.equal(typeof definition.finishesTurn, 'boolean', definition.type)
    assert.equal(typeof definition.inputSchema, 'object', definition.type)
    assert.equal(definition.inputSchema.properties.type.const, definition.type)
    assert.deepEqual(definition.inputSchema.required?.[0], 'type')
    assert.equal(definition.inputSchema.additionalProperties, false)
  }
})

test('turn-completing actions are declared once and reject unknown action types', () => {
  for (const type of [
    ACTIONS.CHOOSE_RESERVE_CARD,
    ACTIONS.CHOOSE_TURN_ORDER,
    ACTIONS.RESOLVE_PAYDAY,
    ACTIONS.RESOLVE_CLEANUP,
    ACTIONS.PLACE_EMPLOYEES,
    ACTIONS.END_TURN,
  ]) {
    assert.equal(actionFinishesTurn(type), true, type)
  }

  assert.equal(actionFinishesTurn(ACTIONS.HIRE), false)
  assert.throws(() => actionFinishesTurn('forged_action'), /Unknown FCM action/)
})
