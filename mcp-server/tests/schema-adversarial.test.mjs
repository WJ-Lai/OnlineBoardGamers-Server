import assert from 'node:assert/strict'
import test from 'node:test'

import { validateToolArguments } from '../server.mjs'

test('runtime validation rejects credential and seat injection even if a client ignores schemas', () => {
  assert.throws(
    () => validateToolArguments('fcm_whoami', { password: 'do-not-accept' }),
    (error) => error.code === 'INVALID_ARGUMENTS' && !error.message.includes('do-not-accept'),
  )
  assert.throws(
    () => validateToolArguments('fcm_list_legal_actions', { gameID: 1, playerIndex: 0 }),
    (error) => error.code === 'INVALID_ARGUMENTS',
  )
})

test('runtime validation rejects unknown actions and oversized input', () => {
  assert.throws(
    () => validateToolArguments('fcm_execute_action', {
      gameID: 1,
      expectedVersion: '1',
      idempotencyKey: '8c95e40d-b3b2-4498-94dd-f1969a816901',
      action: { type: 'overwrite_blob' },
    }),
    (error) => error.code === 'INVALID_ARGUMENTS',
  )
  assert.throws(
    () => validateToolArguments('fcm_execute_action', {
      gameID: 1,
      expectedVersion: '9'.repeat(10000),
      idempotencyKey: '8c95e40d-b3b2-4498-94dd-f1969a816901',
      action: { type: 'place_employees', slots: [0], employees: [-1] },
    }),
    (error) => error.code === 'INVALID_ARGUMENTS',
  )
  assert.throws(
    () => validateToolArguments('fcm_execute_action', {
      gameID: 1,
      expectedVersion: '1',
      idempotencyKey: 'reused-or-malformed',
      action: { type: 'hire', employee: 2 },
    }),
    (error) => error.code === 'INVALID_ARGUMENTS',
  )
})

test('runtime validation accepts a minimal valid read and write command', () => {
  assert.deepEqual(validateToolArguments('fcm_get_state', { gameID: 7 }), { gameID: 7 })
  const write = {
    gameID: 7,
    expectedVersion: '1234',
    idempotencyKey: '8c95e40d-b3b2-4498-94dd-f1969a816901',
    dryRun: true,
    action: { type: 'hire', employee: 2 },
  }
  assert.deepEqual(validateToolArguments('fcm_execute_action', write), write)
})
