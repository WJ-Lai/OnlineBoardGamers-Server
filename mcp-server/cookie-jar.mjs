/**
 * 极简 Cookie Jar —— Node 原生 fetch 不自动管理 cookie
 */

export class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  /** 从 set-cookie 头吸收 cookie */
  absorb(setCookieHeaders) {
    for (const line of setCookieHeaders ?? []) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  get(name) {
    return this.cookies.get(name) ?? null
  }

  /** 生成 Cookie 请求头 */
  header() {
    if (this.cookies.size === 0) return ''
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  clear() {
    this.cookies.clear()
  }

  toJSON() {
    return Object.fromEntries(this.cookies)
  }
}
