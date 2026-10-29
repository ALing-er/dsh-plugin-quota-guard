/**
 * Level-2 quota probes: what is left on a subscription or per-model allowance
 * when no monetary balance endpoint exists.
 *
 * @module dsh-plugin-quota-guard/quota-probe
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { readPath } from './probes.js'

const run = promisify(execFile)

/**
 * Clamp one percentage into [0, 100].
 * @param {number} value - raw percentage.
 * @returns {number}
 */
function clamp(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Parse the first JSON object found in a mixed stdout/stderr blob.
 * @param {string} text - captured output.
 * @returns {any | undefined} parsed document.
 */
function parseJson(text) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/**
 * Turn one period row into the shared shape.
 * @param {any} row - raw period.
 * @returns {{label: string, remainingPercent: number, resetAt?: string} | undefined}
 */
function periodOf(row) {
  if (row === null || typeof row !== 'object') return undefined
  const used = Number(row.percent ?? row.usedPercent)
  if (!Number.isFinite(used)) return undefined
  return {
    label: String(row.label ?? row.name ?? row.model ?? 'period'),
    remainingPercent: clamp(100 - used),
    ...(typeof row.reset_at === 'string' ? { resetAt: row.reset_at } : {}),
    ...(typeof row.resetAt === 'string' ? { resetAt: row.resetAt } : {}),
  }
}

/**
 * Ask arkcli for the subscription plan snapshot (session/weekly/monthly).
 * @param {object} spec - normalized quota settings.
 * @param {number} timeoutMs - subprocess timeout.
 * @returns {Promise<object>} probe result.
 */
async function probeArkcliPlan(spec, timeoutMs) {
  const args = ['usage', 'plan', '--format', 'json']
  if (spec.product !== undefined) args.push('--product', spec.product)

  let stdout = ''
  try {
    // Windows resolves the npm shim through cmd; passing fixed arguments to
    // cmd avoids Node's shell-injection warning while keeping the shim usable.
    const windows = process.platform === 'win32'
    const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'arkcli'
    const argv = windows ? ['/d', '/s', '/c', 'arkcli', ...args] : args
    const result = await run(command, argv, {
      timeout: Math.max(timeoutMs, 15000),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`
    const parsed = parseJson(output)
    const message = parsed?.error?.message ?? (error instanceof Error ? error.message : String(error))
    return { kind: 'unavailable', reason: `arkcli 查询失败：${String(message).slice(0, 160)}` }
  }

  const parsed = parseJson(stdout)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  if (items.length === 0) return { kind: 'unavailable', reason: 'arkcli 没有返回套餐信息' }
  const item = items.find((entry) => entry?.subscribed === true) ?? items[0]
  if (item?.subscribed === false) {
    return { kind: 'unavailable', reason: `未订阅 ${spec.product ?? '套餐'}` }
  }
  const periods = (item.periods ?? []).map(periodOf).filter((entry) => entry !== undefined)
  if (periods.length === 0) return { kind: 'unavailable', reason: '套餐没有可用的周期额度' }

  return {
    kind: 'quota',
    source: 'arkcli-plan',
    product: typeof item.product === 'string' ? item.product : spec.product,
    edition: typeof item.edition === 'string' ? item.edition : undefined,
    periods,
    remainingPercent: Math.min(...periods.map((period) => period.remainingPercent)),
  }
}

/**
 * Ask one generic HTTP endpoint for quota rows.
 * @param {object} account - normalized account.
 * @param {object} spec - normalized quota settings.
 * @param {object} options - probe dependencies.
 * @returns {Promise<object>} probe result.
 */
async function probeHttp(account, spec, options) {
  const resolveApiKey = options.resolveApiKey
  let key
  if (spec.apiKeyEnv !== undefined) {
    try {
      key = await resolveApiKey(spec.apiKeyEnv)
    } catch (error) {
      return { kind: 'unavailable', reason: `读取凭据 ${spec.apiKeyEnv} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (key === undefined || key === '') return { kind: 'unavailable', reason: `凭据 ${spec.apiKeyEnv} 未配置` }
  }

  const headers = { Accept: 'application/json', ...spec.headers }
  if (key !== undefined) headers.Authorization = `Bearer ${key}`

  let response
  try {
    response = await options.fetchImpl(spec.url, { method: 'GET', headers, signal: AbortSignal.timeout(options.timeoutMs) })
  } catch (error) {
    return { kind: 'unavailable', reason: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { kind: 'unavailable', reason: `HTTP ${response.status}` }

  let json
  try {
    json = await response.json()
  } catch (error) {
    return { kind: 'unavailable', reason: `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }

  const rows = readPath(json, spec.jsonPath)
  if (!Array.isArray(rows)) return { kind: 'unavailable', reason: `响应 ${spec.jsonPath} 不是数组` }
  const periods = rows.map((row) => {
    if (row === null || typeof row !== 'object') return undefined
    const explicit = Number(row.remainingPercent)
    const total = Number(row.total)
    const remaining = Number(row.remaining)
    const remainingPercent = Number.isFinite(explicit)
      ? clamp(explicit)
      : Number.isFinite(total) && total > 0
        ? clamp((remaining / total) * 100)
        : undefined
    if (remainingPercent === undefined) return undefined
    return {
      label: String(row.label ?? row.model ?? row.id ?? 'quota'),
      remainingPercent,
      ...(typeof row.resetAt === 'string' ? { resetAt: row.resetAt } : {}),
    }
  }).filter((entry) => entry !== undefined)
  if (periods.length === 0) return { kind: 'unavailable', reason: '额度响应里没有可识别的剩余比例' }

  return {
    kind: 'quota',
    source: 'http',
    periods,
    remainingPercent: Math.min(...periods.map((period) => period.remainingPercent)),
    account: account.id,
  }
}

/**
 * Probe one account's level-2 quota.
 * @param {object} account - normalized account.
 * @param {object} options - probe dependencies.
 * @param {(ref: string) => Promise<string | undefined>} options.resolveApiKey - credential lookup.
 * @param {typeof fetch} options.fetchImpl - fetch implementation.
 * @param {number} options.timeoutMs - per-request / subprocess timeout.
 * @returns {Promise<object>} `quota`, `unsupported`, or `unavailable` result.
 */
export async function probeQuota(account, options) {
  const spec = account.quota ?? { kind: 'none' }
  if (spec.kind === 'none') return { kind: 'unsupported', reason: '未配置额度接口' }
  if (spec.kind === 'arkcli-plan') return probeArkcliPlan(spec, options.timeoutMs)
  return probeHttp(account, spec, options)
}
