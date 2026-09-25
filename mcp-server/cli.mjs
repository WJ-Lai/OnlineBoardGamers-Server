#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

import { FCMApiClient } from './api-client.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function usage(message) {
  const error = new Error(message)
  error.code = 'CLI_USAGE'
  error.nextAction = 'Run fcm-agent help'
  return error
}

function gameID(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw usage('gameID must be a positive integer')
  return parsed
}

function json(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw usage(`${label} must be valid JSON`)
  }
}

export function parseCli(argv) {
  const [command, ...args] = argv
  if (!command || command.startsWith('-')) throw usage('credentials are environment-only; a command is required')
  if (command === 'help') return { command }
  if (command === 'doctor' && args.length === 0) return { command }
  if (command === 'whoami' && args.length === 0) return { command }
  if (command === 'games' && args.length === 0) return { command }
  if (['state', 'actions', 'join'].includes(command) && args.length === 1) {
    return { command, gameID: gameID(args[0]) }
  }
  if (command === 'create' && args.length === 1) {
    const input = json(args[0], 'create payload')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw usage('create payload must be an object')
    return { command, input }
  }
  if (command === 'execute' && args.length === 4) {
    const actions = json(args[3], 'actions')
    if (!Array.isArray(actions) || actions.length < 1) throw usage('actions must be a non-empty array')
    if (!/^\d+$/.test(args[1])) throw usage('expectedVersion must be numeric')
    if (!UUID_RE.test(args[2])) throw usage('idempotencyKey must be a UUID')
    return {
      command,
      gameID: gameID(args[0]),
      expectedVersion: args[1],
      idempotencyKey: args[2],
      actions,
    }
  }
  throw usage(`invalid arguments for command: ${command}`)
}

export async function runCli(input, api = new FCMApiClient()) {
  switch (input.command) {
    case 'help':
      return {
        usage: [
          'fcm-agent whoami',
          'fcm-agent doctor',
          'fcm-agent games',
          'fcm-agent state GAME_ID',
          'fcm-agent actions GAME_ID',
          'fcm-agent create JSON_OBJECT',
          'fcm-agent join GAME_ID',
          'fcm-agent execute GAME_ID VERSION UUID JSON_ACTION_ARRAY',
        ],
        authentication: 'Set FCM_AGENT_TOKEN; never pass tokens on the command line.',
      }
    case 'whoami': return api.whoami()
    case 'doctor': {
      const identity = await api.whoami()
      const games = await api.listGames()
      return {
        ok: identity.authentication === 'pat',
        server: api.base,
        username: identity.username,
        authentication: identity.authentication,
        scopes: identity.scopes,
        visibleGames: games.length,
      }
    }
    case 'games': return { games: await api.listGames() }
    case 'state': return (await api.getAuthoritativeActions(input.gameID)).state
    case 'actions': return api.getAuthoritativeActions(input.gameID)
    case 'create': return api.createGame(input.input)
    case 'join': return api.joinGame(input.gameID)
    case 'execute':
      return api.executeActions(input.gameID, {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        actions: input.actions,
      })
    default: throw usage(`unknown command: ${input.command}`)
  }
}

async function main() {
  try {
    const result = await runCli(parseCli(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: {
        code: error.code ?? 'CLI_ERROR',
        message: error.message ?? String(error),
        nextAction: error.nextAction,
      },
    })}\n`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
