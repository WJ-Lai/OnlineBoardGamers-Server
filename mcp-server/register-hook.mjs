import { register } from 'node:module'

const projectRoot = new URL('../', import.meta.url)
register(new URL('./resolve-hook.mjs', import.meta.url), projectRoot)
