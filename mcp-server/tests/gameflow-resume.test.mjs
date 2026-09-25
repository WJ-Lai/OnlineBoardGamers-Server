import assert from 'node:assert/strict'
import test from 'node:test'

import { loadFCMModules, setupBrowserEnv } from '../browser-env.mjs'


test('gameflow serialization preserves working subphase and accepts legacy saves', async () => {
  await setupBrowserEnv()
  const modules = await loadFCMModules()
  const encoded = modules.funcs.exportGameflowData({
    fullTurnOrder: [1, 0],
    phase: 5,
    subphase: 4,
    turnOrder: [1],
    newTurnOrder: [0, 1],
  })
  assert.deepEqual(encoded, [[1, 0], 5, [1], [0, 1], 4])

  const restored = {}
  modules.funcs.importGameflowData(restored, encoded)
  assert.deepEqual(restored, {
    fullTurnOrder: [1, 0], phase: 5, subphase: 4,
    turnOrder: [1], newTurnOrder: [0, 1],
  })

  const legacy = {}
  modules.funcs.importGameflowData(legacy, [[0, 1], 5, [0], [1, 0]])
  assert.equal(legacy.subphase, modules.reference.SUBPHASE_HIRING)
  assert.deepEqual(legacy.newTurnOrder, [1, 0])
})

test('game initialization resumes only a persisted working-day subphase', async () => {
  await setupBrowserEnv()
  const modules = await loadFCMModules()
  assert.equal(modules.model.shouldResumeWorkingSubphase({ phase: 5, subphase: 2 }), true)
  assert.equal(modules.model.shouldResumeWorkingSubphase({ phase: 5, subphase: 1 }), false)
  assert.equal(modules.model.shouldResumeWorkingSubphase({ phase: 3, subphase: 2 }), false)
})

test('resuming production reconstructs official producer slots', async () => {
  await setupBrowserEnv()
  const modules = await loadFCMModules()
  const rf = modules.reference
  assert.deepEqual(
    modules.controller.producersForWorkingDay({
      employees: [rf.KITCHEN_TRAINEE, rf.RECRUITING_GIRL],
    }),
    [rf.KITCHEN_TRAINEE],
  )
  assert.deepEqual(
    modules.controller.producersForWorkingDay({
      employees: [rf.KITCHEN_TRAINEE, rf.NIGHT_SHIFT_MANAGER],
    }),
    [rf.KITCHEN_TRAINEE, rf.KITCHEN_TRAINEE],
  )
})
