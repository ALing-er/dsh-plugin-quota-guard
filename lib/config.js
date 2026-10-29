/**
 * quota-guard configuration normalization.
 *
 * The plugin reads its config from the Cordis loader row, so every value here
 * arrives as plain YAML data. Validation fails loud at load time: a typo must
 * never turn into a silently disabled monitor.
 *
 * @module dsh-plugin-quota-guard/config
 */

/** Balance probe kinds. `none` means "no queryable balance; rely on usage and provider errors". */
export const BALANCE_KINDS = Object.freeze(['none', 'deepseek', 'moonshot', 'aliyun', 'http'])

/** Quota probe kinds used when no monetary balance is queryable. `tokens` is
 * the local ledger: start-tokens minus everything this account has consumed.
 * `bailian-free` reads the per-model free allowance from the Bailian CLI. */
export const QUOTA_KINDS = Object.freeze(['none', 'arkcli-plan', 'http', 'tokens', 'bailian-free'])

/** Default API roots for the first-party balance endpoints. */
export const BALANCE_BASE_URLS = Object.freeze({
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.cn',
})

/** Webhook payload dialects understood by {@link sendWebhook}. */
export const WEBHOOK_FORMATS = Object.freeze(['generic', 'feishu', 'dingtalk'])

/** How the second-level (same-provider) failover picks its target. */
export const SWITCH_ORDERS = Object.freeze(['auto', 'manual'])

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reject one malformed config value with a path-prefixed message.
 * @param {string} path - dotted config path.
 * @param {string} message - what is wrong.
 * @returns {never}
 */
function fail(path, message) {
  throw new Error(`quota-guard: ${path} ${message}`)
}

/**
 * Whether a value is a plain mapping (and not an array or class instance).
 * @param {unknown} value - candidate.
 * @returns {boolean}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an optional positive finite number.
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @param {number} fallback - value used when the field is absent.
 * @param {{min?: number}} [options] - inclusive lower bound, default 0.
 * @returns {number}
 */
function positiveNumber(value, path, fallback, options = {}) {
  if (value === undefined || value === null) return fallback
  const min = options.min ?? 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    fail(path, `must be a number >= ${min}`)
  }
  return value
}

/**
 * Read an optional non-negative finite number (thresholds may be zero).
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @returns {number | null}
 */
function threshold(value, path) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, 'must be a number >= 0')
  }
  return value
}

/**
 * Read a required non-empty string.
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @returns {string}
 */
function requiredString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'is required')
  return value.trim()
}

/**
 * Read an optional non-empty string.
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @returns {string | undefined}
 */
function optionalString(value, path) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(path, 'must be a string')
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read an optional boolean.
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @param {boolean} fallback - value used when the field is absent.
 * @returns {boolean}
 */
function optionalBoolean(value, path, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

/**
 * Normalize one balance probe section.
 * @param {unknown} raw - raw `account.balance` value.
 * @param {string} path - dotted config path.
 * @returns {object} normalized probe settings.
 */
function normalizeBalance(raw, path) {
  if (raw === undefined || raw === null) return { kind: 'none', headers: {} }
  if (!isMapping(raw)) fail(path, 'must be a mapping')

  const kind = raw.kind === undefined ? 'none' : requiredString(raw.kind, `${path}.kind`)
  if (!BALANCE_KINDS.includes(kind)) {
    fail(`${path}.kind`, `must be one of ${BALANCE_KINDS.join(', ')}`)
  }

  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${path}.apiKeyEnv`)
  if (apiKeyEnv !== undefined && !CREDENTIAL_REF.test(apiKeyEnv)) {
    fail(`${path}.apiKeyEnv`, 'must look like an environment variable name')
  }

  // Alibaba Cloud signs requests with an AccessKey pair, not a bearer token.
  const accessKeyEnv = optionalString(raw.accessKeyEnv, `${path}.accessKeyEnv`)
  const accessKeySecretEnv = optionalString(raw.accessKeySecretEnv, `${path}.accessKeySecretEnv`)
  for (const [name, ref] of [['accessKeyEnv', accessKeyEnv], ['accessKeySecretEnv', accessKeySecretEnv]]) {
    if (ref !== undefined && !CREDENTIAL_REF.test(ref)) {
      fail(`${path}.${name}`, 'must look like an environment variable name')
    }
  }
  if (kind === 'aliyun' && accessKeyEnv === undefined) {
    fail(`${path}.accessKeyEnv`, 'is required when kind is aliyun')
  }
  if (kind === 'aliyun' && accessKeySecretEnv === undefined) {
    fail(`${path}.accessKeySecretEnv`, 'is required when kind is aliyun')
  }

  // With no queryable balance the remaining amount is estimated locally from
  // this starting figure minus everything dsh has spent since.
  const startAmount = threshold(raw.startAmount, `${path}.startAmount`)

  const url = optionalString(raw.url, `${path}.url`)
  if (kind === 'http' && url === undefined) fail(`${path}.url`, 'is required when kind is http')

  const baseUrl = optionalString(raw.baseUrl, `${path}.baseUrl`)
  const jsonPath = optionalString(raw.jsonPath, `${path}.jsonPath`)
  if (kind === 'http' && jsonPath === undefined) fail(`${path}.jsonPath`, 'is required when kind is http')
  const availablePath = optionalString(raw.availablePath, `${path}.availablePath`)
  const currency = optionalString(raw.currency, `${path}.currency`)

  /** @type {Record<string, string>} */
  const headers = {}
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isMapping(raw.headers)) fail(`${path}.headers`, 'must be a mapping of string to string')
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value !== 'string') fail(`${path}.headers.${name}`, 'must be a string')
      headers[name] = value
    }
  }

  return {
    kind,
    apiKeyEnv,
    accessKeyEnv,
    accessKeySecretEnv,
    startAmount,
    url,
    baseUrl,
    jsonPath,
    availablePath,
    currency,
    headers,
  }
}

/**
 * Normalize optional per-million-token prices used by the estimation fallback.
 * @param {unknown} raw - raw `account.pricing` value.
 * @param {string} path - dotted config path.
 * @returns {object | null}
 */
function normalizePricing(raw, path) {
  if (raw === undefined || raw === null) return null
  if (!isMapping(raw)) fail(path, 'must be a mapping')
  const pricing = {
    inputPerMTok: positiveNumber(raw.inputPerMTok, `${path}.inputPerMTok`, 0),
    outputPerMTok: positiveNumber(raw.outputPerMTok, `${path}.outputPerMTok`, 0),
    cacheReadPerMTok: positiveNumber(raw.cacheReadPerMTok, `${path}.cacheReadPerMTok`, NaN),
    cacheWritePerMTok: positiveNumber(raw.cacheWritePerMTok, `${path}.cacheWritePerMTok`, NaN),
  }
  const priced = [pricing.inputPerMTok, pricing.outputPerMTok, pricing.cacheReadPerMTok, pricing.cacheWritePerMTok]
    .some((value) => Number.isFinite(value) && value > 0)
  if (!priced) fail(path, 'must set at least one positive price')
  // Unspecified cache prices fall back to the uncached input price (an upper bound).
  if (!Number.isFinite(pricing.cacheReadPerMTok)) pricing.cacheReadPerMTok = pricing.inputPerMTok
  if (!Number.isFinite(pricing.cacheWritePerMTok)) pricing.cacheWritePerMTok = pricing.inputPerMTok
  return pricing
}

/**
 * Read an optional percentage in [0, 100].
 * @param {unknown} value - raw value.
 * @param {string} path - dotted config path.
 * @param {number} fallback - value used when the field is absent.
 * @returns {number}
 */
function percent(value, path, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(path, 'must be a percentage between 0 and 100')
  }
  return value
}

/**
 * Normalize one quota-probe section (level 2 of the escalation strategy).
 * @param {unknown} raw - raw `account.quota` value.
 * @param {string} path - dotted config path.
 * @returns {object} normalized quota settings.
 */
function normalizeQuota(raw, path) {
  if (raw === undefined || raw === null) return { kind: 'none', warnPercent: 20, criticalPercent: 5 }
  if (!isMapping(raw)) fail(path, 'must be a mapping')

  const kind = raw.kind === undefined ? 'none' : requiredString(raw.kind, `${path}.kind`)
  if (!QUOTA_KINDS.includes(kind)) fail(`${path}.kind`, `must be one of ${QUOTA_KINDS.join(', ')}`)

  const warnPercent = percent(raw.warnPercent, `${path}.warnPercent`, 20)
  const criticalPercent = percent(raw.criticalPercent, `${path}.criticalPercent`, 5)
  if (criticalPercent > warnPercent) fail(`${path}.criticalPercent`, 'must not be greater than warnPercent')

  // The local token ledger needs the allowance it counts down from.
  const startTokens = raw.startTokens === undefined || raw.startTokens === null
    ? undefined
    : positiveNumber(raw.startTokens, `${path}.startTokens`, 0, { min: 1 })
  if (kind === 'tokens' && startTokens === undefined) {
    fail(`${path}.startTokens`, 'is required when kind is tokens')
  }

  const url = optionalString(raw.url, `${path}.url`)
  const jsonPath = optionalString(raw.jsonPath, `${path}.jsonPath`)
  if (kind === 'http' && url === undefined) fail(`${path}.url`, 'is required when kind is http')
  if (kind === 'http' && jsonPath === undefined) fail(`${path}.jsonPath`, 'is required when kind is http')

  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${path}.apiKeyEnv`)
  if (apiKeyEnv !== undefined && !CREDENTIAL_REF.test(apiKeyEnv)) {
    fail(`${path}.apiKeyEnv`, 'must look like an environment variable name')
  }

  /** @type {Record<string, string>} */
  const headers = {}
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isMapping(raw.headers)) fail(`${path}.headers`, 'must be a mapping of string to string')
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value !== 'string') fail(`${path}.headers.${name}`, 'must be a string')
      headers[name] = value
    }
  }

  return {
    kind,
    product: optionalString(raw.product, `${path}.product`) ?? 'coding-plan',
    startTokens,
    url,
    jsonPath,
    apiKeyEnv,
    headers,
    warnPercent,
    criticalPercent,
  }
}

/**
 * Normalize one monitored account.
 * @param {unknown} raw - raw account entry.
 * @param {string} path - dotted config path.
 * @returns {object} normalized account.
 */
export function normalizeAccount(raw, path = 'account') {
  if (!isMapping(raw)) fail(path, 'must be a mapping')

  const id = requiredString(raw.id, `${path}.id`)
  const provider = requiredString(raw.provider, `${path}.provider`)
  const model = requiredString(raw.model, `${path}.model`)

  const extraModels = raw.models === undefined || raw.models === null ? [] : raw.models
  if (!Array.isArray(extraModels)) fail(`${path}.models`, 'must be an array of model ids')
  const models = []
  for (const [index, entry] of [model, ...extraModels].entries()) {
    const modelId = requiredString(entry, `${path}.models[${index}]`)
    if (!models.includes(modelId)) models.push(modelId)
  }

  const warnBelow = threshold(raw.warnBelow, `${path}.warnBelow`)
  const criticalBelow = threshold(raw.criticalBelow, `${path}.criticalBelow`)
  if (warnBelow !== null && criticalBelow !== null && criticalBelow > warnBelow) {
    fail(`${path}.criticalBelow`, 'must not be greater than warnBelow')
  }

  return {
    id,
    provider,
    model,
    models,
    label: optionalString(raw.label, `${path}.label`) ?? id,
    priority: positiveNumber(raw.priority, `${path}.priority`, 100),
    warnBelow,
    criticalBelow,
    currency: optionalString(raw.currency, `${path}.currency`),
    balance: normalizeBalance(raw.balance, `${path}.balance`),
    quota: normalizeQuota(raw.quota, `${path}.quota`),
    siteUrl: optionalString(raw.siteUrl, `${path}.siteUrl`),
    pricing: normalizePricing(raw.pricing, `${path}.pricing`),
  }
}

/**
 * Normalize the webhook alert section.
 * @param {unknown} raw - raw `alert` value.
 * @param {string} path - dotted config path.
 * @returns {object}
 */
function normalizeAlert(raw, path) {
  if (raw === undefined || raw === null) raw = {}
  if (!isMapping(raw)) fail(path, 'must be a mapping')

  const webhookUrl = optionalString(raw.webhookUrl, `${path}.webhookUrl`)
  if (webhookUrl !== undefined) {
    let parsed
    try {
      parsed = new URL(webhookUrl)
    } catch {
      fail(`${path}.webhookUrl`, 'must be an absolute http(s) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(`${path}.webhookUrl`, 'must be an absolute http(s) URL')
    }
  }

  const format = raw.format === undefined ? 'generic' : requiredString(raw.format, `${path}.format`)
  if (!WEBHOOK_FORMATS.includes(format)) {
    fail(`${path}.format`, `must be one of ${WEBHOOK_FORMATS.join(', ')}`)
  }

  return {
    webhookUrl,
    format,
    minIntervalMs: positiveNumber(raw.minIntervalMs, `${path}.minIntervalMs`, 30 * 60 * 1000),
    onSwitch: optionalBoolean(raw.onSwitch, `${path}.onSwitch`, true),
    timeoutMs: positiveNumber(raw.timeoutMs, `${path}.timeoutMs`, 8000, { min: 1 }),
  }
}

/**
 * Validate and normalize the plugin config.
 * @param {unknown} raw - loader row config.
 * @returns {object} normalized config, safe to read for the plugin lifetime.
 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (!isMapping(source)) fail('config', 'must be a mapping')

  if (source.accounts !== undefined && !Array.isArray(source.accounts)) {
    fail('accounts', 'must be an array')
  }
  const accounts = []
  const seen = new Set()
  for (const [index, entry] of (source.accounts ?? []).entries()) {
    const account = normalizeAccount(entry, `accounts[${index}]`)
    if (seen.has(account.id)) fail(`accounts[${index}].id`, `duplicates "${account.id}"`)
    seen.add(account.id)
    accounts.push(account)
  }

  /** @type {string[]} */
  const quotaErrorCodes = []
  if (source.quotaErrorCodes !== undefined && source.quotaErrorCodes !== null) {
    if (!Array.isArray(source.quotaErrorCodes)) fail('quotaErrorCodes', 'must be an array of codes')
    for (const [index, code] of source.quotaErrorCodes.entries()) {
      quotaErrorCodes.push(requiredString(code, `quotaErrorCodes[${index}]`))
    }
  }
  if (quotaErrorCodes.length === 0) quotaErrorCodes.push('QUOTA_EXCEEDED')

  // `auto` ranks candidates by measured health; `manual` keeps the user's
  // priority order inside one provider. The default stays automatic.
  const switchOrder = source.switchOrder === undefined ? 'auto' : requiredString(source.switchOrder, 'switchOrder')
  if (!SWITCH_ORDERS.includes(switchOrder)) {
    fail('switchOrder', `must be one of ${SWITCH_ORDERS.join(', ')}`)
  }

  return {
    intervalMs: positiveNumber(source.intervalMs, 'intervalMs', 10 * 60 * 1000, { min: 30000 }),
    probeTimeoutMs: positiveNumber(source.probeTimeoutMs, 'probeTimeoutMs', 8000, { min: 1 }),
    autoSwitch: optionalBoolean(source.autoSwitch, 'autoSwitch', true),
    switchOnQuotaError: optionalBoolean(source.switchOnQuotaError, 'switchOnQuotaError', true),
    switchOrder,
    // 同平台模型耗尽、且监控列表里没有其它可用账户时，自动探测该平台路由里
    // 尚未登记的模型（仅限可按模型读取免费额度的平台），有额度就直接接管。
    autoAdoptModels: optionalBoolean(source.autoAdoptModels, 'autoAdoptModels', true),
    // 路由决策前允许的最大数据年龄：超过就先把该账户刷一遍再决定是否切换，
    // 避免额度刚耗尽时因为轮询间隔而漏切。
    routeFreshMs: positiveNumber(source.routeFreshMs, 'routeFreshMs', 60000, { min: 5000 }),
    quotaErrorCodes,
    quotaCooldownMs: positiveNumber(source.quotaCooldownMs, 'quotaCooldownMs', 15 * 60 * 1000),
    staleAfterMs: positiveNumber(source.staleAfterMs, 'staleAfterMs', 6 * 60 * 60 * 1000),
    accounts,
    alert: normalizeAlert(source.alert, 'alert'),
  }
}

/**
 * Render one normalized account back into the persisted config shape.
 *
 * Used for the user store file and for the browser snapshot, so both stay
 * readable and free of `undefined`/`null` noise.
 *
 * @param {object} account - normalized account.
 * @returns {object} plain JSON-compatible account.
 */
export function serializeAccount(account) {
  const balance = { kind: account.balance.kind }
  for (const key of ['apiKeyEnv', 'accessKeyEnv', 'accessKeySecretEnv', 'baseUrl', 'url', 'jsonPath', 'availablePath', 'currency']) {
    if (account.balance[key] !== undefined) balance[key] = account.balance[key]
  }
  const headers = account.balance.headers ?? {}
  if (Object.keys(headers).length > 0) balance.headers = { ...headers }
  if (typeof account.balance.startAmount === 'number') balance.startAmount = account.balance.startAmount

  const serialized = {
    id: account.id,
    label: account.label,
    provider: account.provider,
    model: account.model,
    models: [...account.models],
    priority: account.priority,
    balance,
  }
  if (account.warnBelow !== null) serialized.warnBelow = account.warnBelow
  if (account.criticalBelow !== null) serialized.criticalBelow = account.criticalBelow
  if (account.currency !== undefined) serialized.currency = account.currency
  if (account.siteUrl !== undefined) serialized.siteUrl = account.siteUrl
  if (account.quota !== undefined && account.quota.kind !== 'none') {
    const quota = { kind: account.quota.kind, warnPercent: account.quota.warnPercent, criticalPercent: account.quota.criticalPercent }
    for (const key of ['product', 'startTokens', 'url', 'jsonPath', 'apiKeyEnv']) {
      if (account.quota[key] !== undefined) quota[key] = account.quota[key]
    }
    if (Object.keys(account.quota.headers ?? {}).length > 0) quota.headers = { ...account.quota.headers }
    serialized.quota = quota
  }
  if (account.pricing !== null) serialized.pricing = { ...account.pricing }
  return serialized
}
