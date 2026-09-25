import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const worker = new URL('../engine-worker.mjs', import.meta.url)
const hook = new URL('../register-hook.mjs', import.meta.url)

function run(input) {
  return spawnSync(process.execPath, ['--import', hook.pathname, worker.pathname], {
    input,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 256_000,
  })
}

test('engine worker uses one JSON request and one machine-readable JSON response', () => {
  const result = run(JSON.stringify({ operation: 'unsupported', password: 'do-not-leak' }))
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr, '')
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'INVALID_ENGINE_COMMAND')
  assert.doesNotMatch(result.stdout, /do-not-leak/)
  assert.doesNotMatch(result.stdout, /\n\s+at /)
})

test('engine worker rejects oversized input before parsing it', () => {
  const result = run('x'.repeat(4 * 1024 * 1024 + 1))
  assert.notEqual(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.error.code, 'ENGINE_INPUT_TOO_LARGE')
})
