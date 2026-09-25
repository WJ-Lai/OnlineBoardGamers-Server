#!/usr/bin/env node

import { EngineRuntime } from './engine-runtime.mjs'

// stdout is the worker protocol. Legacy FCM code occasionally uses console.log
// for alerts/diagnostics, so route those messages to captured stderr instead.
console.log = (...args) => console.error(...args)

// A late FCM game blob can exceed 64 KiB; keep a bounded but practical ceiling.
const MAX_INPUT_BYTES = 4 * 1024 * 1024
const SAFE_ERROR_CODES = new Set([
  'ACTOR_MISMATCH',
  'INCOMPLETE_COMMAND',
  'ILLEGAL_ACTION',
  'INVALID_ENGINE_COMMAND',
  'INVALID_SNAPSHOT',
  'NOT_A_PLAYER',
  'STALE_STATE',
])

function commandError(message, code = 'INVALID_ENGINE_COMMAND') {
  const error = new Error(message)
  error.code = code
  return error
}

async function readInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) {
      throw commandError('engine input exceeds 4 MiB', 'ENGINE_INPUT_TOO_LARGE')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw commandError('engine input must be valid JSON')
  }
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw commandError('engine request must be an object')
  }
  const unknown = Object.keys(envelope).filter((key) => !['operation', 'payload'].includes(key))
  if (unknown.length) throw commandError(`unknown engine request fields: ${unknown.sort().join(', ')}`)
  if (!['inspect', 'execute'].includes(envelope.operation)) {
    throw commandError(`unsupported engine operation: ${String(envelope.operation)}`)
  }
  return envelope
}

async function writeAndExit(payload, status) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  process.exit(status)
}

try {
  const request = validateEnvelope(await readInput())
  const runtime = new EngineRuntime()
  const result = request.operation === 'inspect'
    ? await runtime.inspect(request.payload)
    : await runtime.executeBatch(request.payload)
  await writeAndExit({ ok: true, result }, 0)
} catch (error) {
  const code = error?.code === 'ENGINE_INPUT_TOO_LARGE' || SAFE_ERROR_CODES.has(error?.code)
    ? error.code
    : 'ENGINE_FAILURE'
  const message = code === 'ENGINE_FAILURE'
    ? 'authoritative engine failed'
    : String(error?.message ?? 'engine command failed')
  await writeAndExit({ ok: false, error: { code, message } }, 1)
}
