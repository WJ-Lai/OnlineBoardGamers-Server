/**
 * 跨进程写锁 —— 让发往同一 Django/SQLite 的写请求全局串行。
 *
 * 为什么需要：
 *   FCM 官方用 Lobby/sharedFunctions/db_mutex.py 做互斥，但它在 SQLite 下会自锁：
 *   get_or_create() 在 transaction.atomic() 里 INSERT，SQLite 只有「库级写锁」，
 *   两个请求同时 INSERT → 第二个阻塞在写锁上，而第一个还没提交事务 →
 *   30 秒 timeout 也拿不到锁 → OperationalError: database is locked → 500
 *   → 客户端拿到 HTML 而非 JSON → JSON.parse 崩 → 内存推进但服务端没落盘 → 死循环。
 *
 *   这个问题在 MySQL（生产环境）不存在，是 SQLite 本地调试特有的。
 *
 * 解法（不动官方代码）：
 *   在我们这一侧，把「写请求」用文件锁串行化。同一时刻只有一个 AI 会话
 *   能发写请求，db_mutex 就永远拿得到锁，500 消失。
 *
 * 注意：这是「本地单机调试」的补偿措施，不是对官方逻辑的修改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const LOCK_PATH = process.env.FCM_WRITE_LOCK_PATH
  ?? path.join(os.tmpdir(), 'fcm-processTurn.lock')

/** 异步等待，不能用 Atomics.wait 阻塞同进程内仍持锁的 Promise。 */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 用 O_EXCL 抢占式创建锁文件，拿到锁才执行 fn。
 * 这是一个简单的自旋锁：对手进程崩溃留下的陈旧锁，超过 stalenessMs 会被清掉。
 *
 * @param {() => Promise<any>} fn 要串行执行的异步函数
 * @param {{timeoutMs?: number, stalenessMs?: number}} opts
 */
export async function withDbWriteLock(fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000
  // 陈旧阈值必须大于正常等待上限；否则慢请求尚未结束时，另一进程会误删活锁。
  const stalenessMs = opts.stalenessMs ?? 120000
  const start = Date.now()
  const ownerToken = `${process.pid}:${randomUUID()}`

  for (;;) {
    try {
      // wx = O_CREAT | O_EXCL：文件已存在就抛 EEXIST，天然互斥
      const fd = fs.openSync(LOCK_PATH, 'wx')
      fs.writeSync(fd, ownerToken)
      fs.closeSync(fd)
      break // 拿到锁
    } catch (e) {
      if (e.code !== 'EEXIST') throw e

      // 陈旧锁清理：持有者崩了没删文件
      try {
        const st = fs.statSync(LOCK_PATH)
        if (Date.now() - st.mtimeMs > stalenessMs) {
          fs.unlinkSync(LOCK_PATH)
          continue
        }
      } catch {
        /* 文件刚好被别人删了，直接重试 */
        continue
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`withDbWriteLock: 等待锁超时（${timeoutMs}ms）`)
      }
      await sleepMs(25)
    }
  }

  try {
    return await fn()
  } finally {
    // 只释放自己创建的锁。即使陈旧锁被接管，也不能删除新持有者的锁。
    try {
      if (fs.readFileSync(LOCK_PATH, 'utf8') === ownerToken) fs.unlinkSync(LOCK_PATH)
    } catch {
      /* 已被清理 */
    }
  }
}

export { LOCK_PATH }
