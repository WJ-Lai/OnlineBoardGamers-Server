// ESM loader hook：让无扩展名的 import 能解析到 .js
// 用途：在原生 Node 里 import Vite 源码（源码里 import "./FCMrules" 无扩展名）
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对路径且无扩展名的
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd()
    const candidate = path.resolve(path.dirname(parentPath), specifier + '.js')
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
    // 也试 index.js
    const idx = path.resolve(path.dirname(parentPath), specifier, 'index.js')
    if (existsSync(idx)) {
      return { url: pathToFileURL(idx).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
