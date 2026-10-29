/**
 * Balance probes for the platforms that expose a queryable balance, plus the
 * "unsupported" answer every other platform returns.
 *
 * A probe never throws: callers need one uniform shape so a failed HTTP call
 * degrades into estimation instead of aborting the refresh cycle.
 *
 * @module dsh-plugin-quota-guard/probes
 */

import { BALANCE_BASE_URLS } from './config.js'
import { queryAccountBalance } from './aliyun.js'

/**
 * Read a dot-separated path out of parsed JSON.
 * @param {unknown} value - parsed document.
 * @param {string | undefined} path - e.g. `data.available_balance` or `items.0.total`.
 * @returns {unknown} resolved value, or `undefined` when a segment is missing.
 */
export function readPath(value, path) {
  if (!path) return undefined
  let current = value
  for (const segment of path.split('.')) {
    if (segment === '') continue
    if (current === null || typeof current !== 'object') return undefined
    current = Array.isArray(current) && /^\d+$/.test(segment)
      ? current[Number(segment)]
      : current[segment]
  }
  return current
}

/**
 * Join an API root with an absolute-ish path without doubling a version prefix.
 * @param {string} base - configured root, e.g. `https://api.deepseek.com`.
 * @param {string} path - e.g. `/user/balance` or `/v1/users/me/balance`.
 * @returns {string}
 */
function joinUrl(base, path) {
  const trimmed = base.replace(/\/+$/, '')
  if (path.startsWith('/v1/') && trimmed.endsWith('/v1')) return `${trimmed}${path.slice('/v1'.length)}`
  return `${trimmed}${path}`
}

/**
 * Build the probe result for a successful reading.
 * @param {number} remaining - money or credits left.
 * @param {string | null} currency - currency code when the endpoint reports one.
 * @param {string} source - stable probe label for display.
 * @returns {{kind: 'balance', remaining: number, currency: string | null, source: string}}
 */
function balance(remaining, currency, source) {
  return { kind: 'balance', remaining, currency: currency ?? null, source }
}

/**
 * Classify one DeepSeek `/user/balance` document.
 * @param {any} json - parsed response.
 * @param {object} account - normalized account.
 * @returns {object} probe result.
 */
function parseDeepseek(json, account) {
  const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
  const preferred = account.balance.currency ?? account.currency ?? undefined
  const info = (preferred !== undefined && infos.find((entry) => entry?.currency === preferred)) || infos[0]
  if (info === undefined) return { kind: 'unavailable', reason: '余额响应缺少 balance_infos' }
  const total = Number(info.total_balance)
  if (!Number.isFinite(total)) return { kind: 'unavailable', reason: '余额响应中的 total_balance 不是数字' }
  const empty = json?.is_available === false
  return balance(empty ? 0 : total, typeof info.currency === 'string' ? info.currency : preferred ?? null, 'deepseek-balance')
}

/**
 * Classify one Moonshot `/v1/users/me/balance` document.
 * @param {any} json - parsed response.
 * @param {object} account - normalized account.
 * @returns {object} probe result.
 */
function parseMoonshot(json, account) {
  const available = Number(json?.data?.available_balance)
  if (!Number.isFinite(available)) return { kind: 'unavailable', reason: '余额响应缺少 data.available_balance' }
  const currency = account.balance.currency ?? account.currency ?? 'USD'
  return balance(available, currency, 'moonshot-balance')
}

/**
 * Classify one generic endpoint response using the configured JSON paths.
 * @param {any} json - parsed response.
 * @param {object} account - normalized account.
 * @returns {object} probe result.
 */
function parseGeneric(json, account) {
  const remaining = Number(readPath(json, account.balance.jsonPath))
  if (!Number.isFinite(remaining)) {
    return { kind: 'unavailable', reason: `响应 ${account.balance.jsonPath} 不是数字` }
  }
  const available = account.balance.availablePath === undefined
    ? undefined
    : readPath(json, account.balance.availablePath)
  const exhausted = available === false || available === 0 || available === 'false'
  return balance(exhausted ? 0 : remaining, account.balance.currency ?? account.currency ?? null, 'http')
}

/**
 * Read one credential reference through the injected resolver.
 * @param {object} options - probe dependencies.
 * @param {string} ref - credential reference.
 * @returns {Promise<{value: string} | {error: string}>}
 */
export async function readCredential(options, ref) {
  try {
    const value = await options.resolveApiKey(ref)
    if (value === undefined || value === '') return { error: `凭据 ${ref} 未配置` }
    return { value }
  } catch (error) {
    return { error: `读取凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Probe an Alibaba Cloud account balance (AccessKey-signed BSS API).
 * @param {object} account - normalized account.
 * @param {object} options - probe dependencies.
 * @returns {Promise<object>} probe result.
 */
async function probeAliyun(account, options) {
  const spec = account.balance
  const fetchImpl = options.fetchImpl
  if (typeof fetchImpl !== 'function') return { kind: 'unavailable', reason: '当前运行时没有可用的 fetch' }

  const id = await readCredential(options, spec.accessKeyEnv)
  if (id.error !== undefined) return { kind: 'unavailable', reason: id.error }
  const secret = await readCredential(options, spec.accessKeySecretEnv)
  if (secret.error !== undefined) return { kind: 'unavailable', reason: secret.error }

  const result = await queryAccountBalance({
    accessKeyId: id.value,
    accessKeySecret: secret.value,
    fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  if (!result.ok) return { kind: 'unavailable', reason: result.reason }
  return balance(result.amount, result.currency ?? spec.currency ?? 'CNY', 'aliyun-balance')
}

/**
 * Probe one account's balance.
 * @param {object} account - normalized account.
 * @param {object} options - probe dependencies.
 * @param {(ref: string) => Promise<string | undefined>} options.resolveApiKey - credential lookup.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation (tests inject one).
 * @param {number} options.timeoutMs - per-request timeout.
 * @returns {Promise<object>} `balance`, `unsupported`, or `unavailable` result.
 */
export async function probeBalance(account, options) {
  const { balance: spec } = account
  if (spec.kind === 'none') return { kind: 'unsupported', reason: '未配置余额接口，仅按用量估算与错误码判断' }
  if (spec.kind === 'aliyun') return probeAliyun(account, options)

  const fetchImpl = options.fetchImpl
  if (typeof fetchImpl !== 'function') return { kind: 'unavailable', reason: '当前运行时没有可用的 fetch' }

  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json', ...spec.headers }
  if (spec.apiKeyEnv !== undefined) {
    const key = await readCredential(options, spec.apiKeyEnv)
    if (key.error !== undefined) return { kind: 'unavailable', reason: key.error }
    headers.Authorization = `Bearer ${key.value}`
  }

  let url
  if (spec.kind === 'deepseek') url = joinUrl(spec.baseUrl ?? BALANCE_BASE_URLS.deepseek, '/user/balance')
  else if (spec.kind === 'moonshot') url = joinUrl(spec.baseUrl ?? BALANCE_BASE_URLS.moonshot, '/v1/users/me/balance')
  else url = spec.url

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    return { kind: 'unavailable', reason: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }

  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '（凭据无效或无权查余额）' : ''
    return { kind: 'unavailable', reason: `HTTP ${response.status}${hint}` }
  }

  let json
  try {
    json = await response.json()
  } catch (error) {
    return { kind: 'unavailable', reason: `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }

  if (spec.kind === 'deepseek') return parseDeepseek(json, account)
  if (spec.kind === 'moonshot') return parseMoonshot(json, account)
  return parseGeneric(json, account)
}
