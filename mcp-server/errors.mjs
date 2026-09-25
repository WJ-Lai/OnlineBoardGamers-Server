/** FCM MCP 错误类型 —— 便于 server 层区分「规则拒绝」和「系统错误」 */

export class FCMActionError extends Error {
  constructor(message, code = 'ILLEGAL_ACTION', nextAction = '重新读取合法动作后再试') {
    super(message)
    this.name = 'FCMActionError'
    this.code = code
    this.nextAction = nextAction
    this.isRuleRejection = true
  }
}

export class FCMSystemError extends Error {
  constructor(message, code = 'WRITE_FAILED', nextAction = '重新读取游戏状态后再试') {
    super(message)
    this.name = 'FCMSystemError'
    this.code = code
    this.nextAction = nextAction
    this.isRuleRejection = false
  }
}
