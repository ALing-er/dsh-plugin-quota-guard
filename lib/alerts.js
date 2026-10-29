/**
 * Human-facing alert and status text, plus webhook delivery.
 *
 * @module dsh-plugin-quota-guard/alerts
 */

const STATUS_LABELS = Object.freeze({
  ok: '正常',
  warn: '预警',
  critical: '不足',
  exhausted: '耗尽',
  unknown: '未知',
})

const CURRENCY_SYMBOLS = Object.freeze({ CNY: '¥', USD: '$', EUR: '€', JPY: '¥', HKD: 'HK$' })

/**
 * Render a money value with its currency symbol.
 * @param {number | null | undefined} remaining - amount left.
 * @param {string | null | undefined} currency - ISO currency code.
 * @returns {string}
 */
export function formatMoney(remaining, currency) {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return '-'
  const symbol = currency === null || currency === undefined ? '' : CURRENCY_SYMBOLS[currency] ?? `${currency} `
  const digits = Math.abs(remaining) >= 100 ? 0 : 2
  return `${symbol}${remaining.toFixed(digits)}`
}

/**
 * Render an account as `label（provider/model）`.
 * @param {object} account - normalized account (provider/model optional).
 * @param {string} [model] - override the account's default model.
 * @returns {string}
 */
export function describeRoute(account, model = account.model) {
  return `${account.label}（${account.provider}/${model}）`
}

/**
 * Find the period with the least headroom.
 * @param {object} state - live state.
 * @returns {{label: string, remainingPercent: number} | undefined}
 */
function limitingPeriod(state) {
  const periods = Array.isArray(state.quota?.periods) ? state.quota.periods : []
  return periods.reduce((min, period) => (
    min === undefined || period.remainingPercent < min.remainingPercent ? period : min
  ), undefined)
}

/**
 * Compose the level-2 (subscription quota) alert text.
 * @param {object} account - normalized account.
 * @param {object} state - live state.
 * @param {'warn' | 'critical' | 'exhausted'} level - crossed level.
 * @returns {string}
 */
function formatQuotaAlert(account, state, level) {
  const period = limitingPeriod(state)
  // The token ledger and the free-allowance reading have no billing period;
  // "周期" would read as nonsense.
  const periodLabel = state.quota?.source === 'token-ledger' || state.quota?.source === 'bailian-free'
    ? 'token 额度'
    : period === undefined ? '套餐' : `${period.label} 周期`
  const remaining = `${Number(state.remainingPercent ?? 0).toFixed(1)}%`
  if (level === 'warn') {
    return `[quota-guard] 额度预警：${account.label}（${account.provider}）${periodLabel}剩余 ${remaining}，低于预警线 ${account.quota.warnPercent}%。`
  }
  if (level === 'critical') {
    return `[quota-guard] 额度不足：${account.label}（${account.provider}）${periodLabel}剩余 ${remaining}，低于切换线 ${account.quota.criticalPercent}%，后续请求将自动改投健康账户。`
  }
  return `[quota-guard] 额度耗尽：${account.label}（${account.provider}）${periodLabel}已不可用${state.note === undefined || state.note === '' ? '' : `（${state.note}）`}，后续请求将自动改投健康账户。`
}

/**
 * Compose the text pushed when an account crosses a threshold.
 * @param {object} account - normalized account.
 * @param {object} state - live state.
 * @param {'warn' | 'critical' | 'exhausted'} level - crossed level.
 * @returns {string}
 */
export function formatBalanceAlert(account, state, level) {
  if (state.quota !== null && state.quota !== undefined) return formatQuotaAlert(account, state, level)
  const money = formatMoney(state.remaining, state.currency ?? account.currency)
  if (level === 'warn') {
    return `[quota-guard] 余额预警：${account.label}（${account.provider}）剩余 ${money}，低于预警阈值 ${formatMoney(account.warnBelow, state.currency ?? account.currency)}。`
  }
  if (level === 'critical') {
    return `[quota-guard] 余额不足：${account.label}（${account.provider}）剩余 ${money}，低于切换阈值 ${formatMoney(account.criticalBelow, state.currency ?? account.currency)}，后续请求将自动改投健康账户。`
  }
  return `[quota-guard] 额度耗尽：${account.label}（${account.provider}）已不可用${state.note === undefined ? '' : `（${state.note}）`}，后续请求将自动改投健康账户。`
}

/**
 * Compose the text pushed after a successful failover.
 * @param {object} from - account being left.
 * @param {string} fromModel - model being left.
 * @param {object} to - account taking over.
 * @param {string} toModel - model taking over.
 * @param {string} reason - why the switch happened.
 * @returns {string}
 */
export function formatSwitchAlert(from, fromModel, to, toModel, reason) {
  return `[quota-guard] 已自动切换模型路由：${describeRoute(from, fromModel)} → ${describeRoute(to, toModel)}，原因：${reason}。`
}

/**
 * Count terminal display columns, treating CJK characters as double width.
 * @param {string} text - one cell.
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0
  for (const char of text) width += char.codePointAt(0) > 0x2e7f ? 2 : 1
  return width
}

/**
 * Pad a cell to a column width.
 * @param {string} text - cell content.
 * @param {number} width - target display width.
 * @returns {string}
 */
function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/**
 * Render the `/quota` status table from a controller snapshot.
 * @param {{accounts: object[]}} snapshot - controller snapshot.
 * @param {number} now - epoch milliseconds.
 * @returns {string}
 */
export function formatStatusTable(snapshot, now) {
  const accounts = snapshot.accounts ?? []
  if (accounts.length === 0) return 'quota-guard 未配置任何账户。可在 dsh 设置页「模型额度」中添加。'

  const rows = accounts.map((account) => {
    const quotaMode = account.quota !== undefined && account.quota !== null
    const thresholds = quotaMode
      ? [
        `预警<${account.quota.warnPercent}%`,
        `切换<${account.quota.criticalPercent}%`,
      ].join(' ')
      : [
        account.warnBelow === null || account.warnBelow === undefined ? undefined : `预警<${formatMoney(account.warnBelow, account.currency)}`,
        account.criticalBelow === null || account.criticalBelow === undefined ? undefined : `切换<${formatMoney(account.criticalBelow, account.currency)}`,
      ].filter((part) => part !== undefined).join(' ')
    const status = `[${STATUS_LABELS[account.status ?? 'unknown']}]`
    const note = account.note === undefined || account.note === '' ? '' : ` ${account.note}`
    const value = quotaMode
      ? `${Number(account.remainingPercent ?? 0).toFixed(1)}%`
      : formatMoney(account.remaining, account.currency)
    return [
      account.label,
      `${status}${note}`,
      value,
      thresholds === '' ? '-' : thresholds,
      `${account.provider}/${account.model}`,
    ]
  })

  const header = ['账户', '状态', '余额', '阈值', '路由']
  const widths = header.map((cell, index) => Math.max(
    displayWidth(cell),
    ...rows.map((row) => displayWidth(row[index])),
  ))

  const lines = [
    `配额状态（${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
    header.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd(),
    ...rows.map((row) => row.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd()),
  ]
  return lines.join('\n')
}

/**
 * Deliver one alert to the configured webhook.
 * @param {object} alert - normalized `config.alert`.
 * @param {string} text - message body.
 * @param {typeof fetch} [fetchImpl] - fetch implementation (tests inject one).
 * @returns {Promise<void>} resolves after a 2xx response.
 */
export async function sendWebhook(alert, text, fetchImpl) {
  if (alert.webhookUrl === undefined) return
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有可用的 fetch')

  let body
  if (alert.format === 'feishu') body = { msg_type: 'text', content: { text } }
  else if (alert.format === 'dingtalk') body = { msgtype: 'text', text: { content: text } }
  else body = { source: 'dsh-quota-guard', at: new Date().toISOString(), text }

  const response = await fetchImpl(alert.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(alert.timeoutMs),
  })
  if (!response.ok) throw new Error(`webhook HTTP ${response.status}`)
}
