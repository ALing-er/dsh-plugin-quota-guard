/**
 * Operations behind the Settings page. The HTTP routes are thin wrappers over
 * these functions, which makes every mutation testable without a browser.
 *
 * @module dsh-plugin-quota-guard/api
 */

import { queryFreeQuota } from './bailian.js'
import { serializeAccount } from './config.js'

/** Route ids double as settings keys and credential suffixes. */
const ROUTE_ID = /^[a-z][a-z0-9-]{0,39}$/
/** Model ids are opaque provider strings; only emptiness and shape are checked. */
const MODEL_ID = /^[A-Za-z0-9._:@+\/-]+$/
/** A value that can travel in an HTTP header. */
const API_KEY = /^[\x21-\x7E]+$/
/** A credential reference the store can address. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reject a malformed request field.
 * @param {string} message - human-readable reason.
 * @returns {never}
 */
function bad(message) {
  throw new Error(message)
}

/**
 * Read a required string.
 * @param {unknown} value - raw field.
 * @param {string} name - field label used in errors.
 * @param {number} [max] - maximum length.
 * @returns {string}
 */
function text(value, name, max = 200) {
  if (typeof value !== 'string' || value.trim() === '') bad(`${name}不能为空`)
  const trimmed = value.trim()
  if (trimmed.length > max) bad(`${name}过长`)
  return trimmed
}

/**
 * Read an optional positive integer.
 * @param {unknown} value - raw field.
 * @param {string} name - field label used in errors.
 * @returns {number | undefined}
 */
function positiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) bad(`${name}必须是正整数`)
  return parsed
}

/**
 * Validate one custom pi-ai provider request.
 * @param {object} body - request body.
 * @returns {{route: string, profile: object, models: object[]}} validated pieces.
 */
function readProvider(body) {
  const route = typeof body.route === 'string' ? body.route.trim() : ''
  if (!ROUTE_ID.test(route)) bad('Provider ID 必须以小写字母开头，只含小写字母、数字和连字符')

  const api = text(body.api, 'API 协议', 80)
  const baseURL = text(body.baseURL, 'Base URL', 500)
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    bad('Base URL 不是合法地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('Base URL 必须是 http(s)')

  if (!Array.isArray(body.models) || body.models.length === 0) bad('至少需要一个模型')
  if (body.models.length > 50) bad('一次最多添加 50 个模型')
  const seen = new Set()
  const models = body.models.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') bad(`模型 ${index + 1} 不是对象`)
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!MODEL_ID.test(id)) bad(`模型 ${index + 1} 的 ID 不合法`)
    if (seen.has(id)) bad(`模型 ID 重复：${id}`)
    seen.add(id)
    const model = { id }
    if (typeof entry.name === 'string' && entry.name.trim() !== '') model.name = entry.name.trim()
    const contextWindow = positiveInteger(entry.contextWindow, `模型 ${id} 的上下文窗口`)
    const maxTokens = positiveInteger(entry.maxTokens, `模型 ${id} 的输出上限`)
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    return model
  })

  const profile = { api, baseURL, models }
  if (typeof body.displayName === 'string' && body.displayName.trim() !== '') {
    profile.displayName = body.displayName.trim()
  }
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (key !== '' && !API_KEY.test(key)) {
    bad('API Key 含非法字符（只允许可打印 ASCII，且不能有空格）')
  }
  const requestedRef = optionalText(body.credentialRef)
  if (requestedRef !== undefined && !CREDENTIAL_REF.test(requestedRef)) {
    bad('凭据引用必须是合法的环境变量名（字母或下划线开头，只含字母、数字、下划线）')
  }
  // Reusing an existing reference is how a subscriber route (or a shared
  // gateway key) is declared without pasting the secret again.
  const credentialRef = requestedRef ?? (key === '' ? undefined : credentialRefFor(route))
  if (credentialRef !== undefined) profile.apiKeyEnv = credentialRef

  return { route, profile, models, key, credentialRef }
}

/**
 * Derive the credential reference stored for one route.
 * @param {string} route - provider id.
 * @returns {string} POSIX-shell-shaped reference.
 */
export function credentialRefFor(route) {
  return `${route.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/**
 * Read an optional trimmed string.
 * @param {unknown} value - raw field.
 * @returns {string | undefined}
 */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Normalize one adapter discovery reply.
 * @param {unknown} list - models reported by the endpoint.
 * @returns {{id: string, name?: string, contextWindow?: number, maxTokens?: number}[]}
 */
function normalizeDiscovered(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const models = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const model = { id }
    if (typeof item.name === 'string' && item.name.trim() !== '') model.name = item.name.trim()
    if (Number.isFinite(item.contextWindow) && item.contextWindow > 0) model.contextWindow = item.contextWindow
    if (Number.isFinite(item.maxTokens) && item.maxTokens > 0) model.maxTokens = item.maxTokens
    models.push(model)
  }
  return models
}

/**
 * Fold a platform's other allowed models into a route's own catalog.
 *
 * A route only lists the models already declared on it, but the Bailian CLI
 * knows every model the platform grants allowance to — and saving one of those
 * declares it on the route, so offering them is safe and lets the page add a
 * model the route has not seen yet.
 *
 * @param {object[]} catalog - models the route declares.
 * @param {object[] | undefined} allowance - CLI rows.
 * @returns {object[]} catalog first, then the extra text models.
 */
function withAllowanceModels(catalog, allowance) {
  if (!Array.isArray(allowance) || allowance.length === 0) return catalog
  const known = new Set(catalog.map((model) => model.id))
  const extra = allowance
    .filter((row) => row !== null && typeof row === 'object' && row.hasQuota === true)
    // Audio/TTS/ASR rows are not chat models; the chat picker cannot use them.
    .filter((row) => row.type === undefined || /text/i.test(String(row.type)))
    .filter((row) => typeof row.model === 'string' && !known.has(row.model))
    .map((row) => ({ id: row.model }))
  return extra.length === 0 ? catalog : [...catalog, ...extra]
}

/**
 * Credential references worth trying for one provider route, most specific
 * first. The derived name is only a candidate: the UI adopts the first one the
 * credential store actually reports as configured.
 * @param {string} provider - route id.
 * @returns {string[]} candidate references.
 */
function candidateRefs(provider) {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const candidates = [`${upper}_API_KEY`, upper]
  if (/deepseek/.test(provider)) candidates.push('DEEPSEEK_API_KEY')
  if (/ark|volc|volcano/.test(provider)) candidates.push('ARK_API_KEY', 'ARKCLI_CODING_PLAN_API_KEY')
  return [...new Set(candidates)]
}

/**
 * Fields an account edit may change. `id` is the lookup key and stays
 * immutable; runtime fields (status, remaining, note, ...) are ignored so a
 * form built from the snapshot cannot write probe output back as config.
 */
const EDITABLE_FIELDS = [
  'label', 'provider', 'model', 'models', 'priority',
  'warnBelow', 'criticalBelow', 'currency', 'siteUrl',
  'pricing', 'balance', 'quota',
]
/** Sections merged one level deep so a partial edit keeps sibling fields. */
const MERGED_SECTIONS = new Set(['balance', 'quota', 'pricing'])

/**
 * @param {unknown} value - candidate section.
 * @returns {boolean} whether it is a plain object.
 */
function isPlainMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Overlay an edit patch onto the stored account.
 * @param {object} existing - normalized account held by the controller.
 * @param {object} patch - raw fields submitted by the edit form.
 * @returns {object} merged raw account, ready for re-normalization.
 */
function mergeAccount(existing, patch) {
  const merged = { ...existing }
  for (const key of EDITABLE_FIELDS) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (MERGED_SECTIONS.has(key) && isPlainMapping(value) && isPlainMapping(merged[key])) {
      merged[key] = { ...merged[key], ...value }
    } else {
      merged[key] = value
    }
  }
  // The stored `models` list includes the primary model, while normalization
  // treats a submitted `models` array as extras. When the primary model moves
  // and the patch carries no list, drop the old primary so it is not silently
  // re-bound as an extra model.
  if (patch.models === undefined && merged.model !== existing.model) {
    merged.models = existing.models.filter((entry) => entry !== existing.model && entry !== merged.model)
  }
  return merged
}

/**
 * Union two model lists, keeping the incoming entry for an id both share (it
 * carries the freshest window and limits).
 * @param {unknown} current - models already stored on the route.
 * @param {object[]} incoming - models coming from the form.
 * @returns {object[]}
 */
function mergeRouteModels(current, incoming) {
  const byId = new Map()
  for (const model of Array.isArray(current) ? current : []) {
    if (model === null || typeof model !== 'object') continue
    if (typeof model.id !== 'string' || model.id === '') continue
    byId.set(model.id, model)
  }
  for (const model of incoming) byId.set(model.id, model)
  return [...byId.values()]
}

/**
 * Read an OpenAI-compatible endpoint's own model listing.
 *
 * The harness' discovery answers a *named* route from the adapter's installed
 * catalog without touching the network, so a route configured with one model
 * can only ever report that one. Asking the endpoint directly is what exposes
 * the platform's full catalog.
 *
 * @param {string} baseURL - endpoint root, e.g. `https://host/v1`.
 * @param {string | undefined} api - protocol id; only OpenAI-compatible ones are read.
 * @param {string | undefined} apiKey - bearer credential, when one was resolved.
 * @param {typeof fetch | undefined} fetchImpl - fetch implementation.
 * @returns {Promise<object[]>} normalized models, or an empty list on any failure.
 */
async function listedModels(baseURL, api, apiKey, fetchImpl) {
  if (typeof fetchImpl !== 'function') return []
  if (api !== undefined && !/openai/i.test(api)) return []
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' }
  if (typeof apiKey === 'string' && apiKey.trim() !== '') headers.authorization = `Bearer ${apiKey.trim()}`
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) })
  } catch {
    return []
  }
  if (!response.ok) return []
  let json
  try {
    json = await response.json()
  } catch {
    return []
  }
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  return normalizeDiscovered(list.map((item) => ({
    id: item?.id,
    name: item?.name,
    contextWindow: item?.context_window ?? item?.contextWindow,
    maxTokens: item?.max_tokens ?? item?.maxTokens,
  })))
}

/**
 * Create the Settings-page operations.
 * @param {object} options - dependencies.
 * @param {object} options.ctx - plugin context (settings, credentials, llm).
 * @param {object} options.controller - runtime controller.
 * @param {(level: string, text: string) => void} options.log - logger.
 * @param {typeof fetch} [options.fetchImpl] - fetch used for direct model listings.
 * @param {() => Promise<object>} [options.freeQuotaProbe] - Bailian allowance reader.
 * @param {(provider: string, model: string) => Promise<{mode: 'session' | 'default' | undefined, reason: string}>} [options.switchForeground] - foreground model switcher.
 * @param {() => Promise<{ok: boolean, detail: string}>} [options.prepareCli] - local tool installer.
 * @returns {object} operation table.
 */
export function createApi({ ctx, controller, log, fetchImpl, freeQuotaProbe = queryFreeQuota, switchForeground, prepareCli }) {
  /**
   * One settings namespace's stored value.
   *
   * The settings service is read through `describe()`, which returns one
   * descriptor per namespace (`{ns, value, schema, …}`); there is no per-key
   * getter.
   *
   * @param {string} ns - settings namespace.
   * @returns {unknown} the namespace value, or undefined.
   */
  function namespaceValue(ns) {
    const settings = ctx.get('settings')
    if (ns === '' || settings === undefined || typeof settings.describe !== 'function') return undefined
    try {
      const namespaces = settings.describe({ redactSecrets: true })
      if (!Array.isArray(namespaces)) return undefined
      return namespaces.find((entry) => entry !== null && typeof entry === 'object' && entry.ns === ns)?.value
    } catch {
      return undefined
    }
  }

  /**
   * The configurable-provider descriptor that owns one route.
   * @param {string} provider - route id.
   * @returns {object | undefined} descriptor carrying `settingsNs` / `settingsPath`.
   */
  function configurableEntry(provider) {
    let directory = []
    try {
      directory = ctx.get('llm')?.listConfigurableProviders?.() ?? []
    } catch {
      directory = []
    }
    return directory.find((item) => item !== null && typeof item === 'object'
      && item.provider === provider && typeof item.settingsNs === 'string')
  }

  /**
   * The stored pi-ai profile for one route, when the settings tree declares it.
   * @param {string} provider - route id.
   * @returns {object | undefined} profile carrying `baseURL` / `api` / `apiKeyEnv`.
   */
  function providerProfile(provider) {
    const entry = configurableEntry(provider)
    if (entry === undefined) return undefined
    let profile = namespaceValue(entry.settingsNs)
    for (const key of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
      profile = profile !== null && typeof profile === 'object' ? Reflect.get(profile, key) : undefined
    }
    return profile !== null && typeof profile === 'object' ? profile : undefined
  }

  /**
   * Credential references the provider profiles already declare in settings.
   * @returns {Map<string, string>} route id to reference.
   */
  function declaredRefs() {
    const refs = new Map()
    let directory = []
    try {
      directory = ctx.get('llm')?.listConfigurableProviders?.() ?? []
    } catch {
      directory = []
    }
    for (const entry of directory) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.provider !== 'string' || typeof entry.settingsNs !== 'string') continue
      let profile = namespaceValue(entry.settingsNs)
      for (const key of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
        profile = profile !== null && typeof profile === 'object' ? Reflect.get(profile, key) : undefined
      }
      if (profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string') {
        refs.set(entry.provider, profile.apiKeyEnv)
      }
    }
    return refs
  }

  /**
   * Registered provider routes, with the credential reference each route
   * already declares in settings (when one is resolvable).
   * @returns {{id: string, name: string, apiKeyEnv?: string}[]}
   */
  function providers() {
    let live = []
    try {
      live = ctx.get('llm')?.listProviders?.() ?? []
    } catch (error) {
      log('warn', `[quota-guard] 读取提供方列表失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const refs = declaredRefs()
    return live
      .map((provider) => {
        const id = String(provider.id ?? '')
        const info = { id, name: String(provider.name ?? provider.id ?? '') }
        const ref = refs.get(id)
        return ref === undefined ? info : { ...info, apiKeyEnv: ref }
      })
      .filter((provider) => provider.id !== '')
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Providers with a credential reference that is known to be configured.
   *
   * An adapter that authenticates by login (no `apiKeyEnv`) gets its route
   * reference detected from the store instead, so the page never proposes a
   * variable name that holds nothing.
   *
   * @returns {Promise<{id: string, name: string, apiKeyEnv?: string}[]>}
   */
  async function providersWithRefs() {
    const list = providers()
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.describe !== 'function') return list

    const enriched = []
    for (const provider of list) {
      if (typeof provider.apiKeyEnv === 'string') {
        enriched.push(provider)
        continue
      }
      let detected
      for (const candidate of candidateRefs(provider.id)) {
        try {
          const info = await credentials.describe(candidate)
          if (info !== null && typeof info === 'object' && info.configured === true) {
            detected = candidate
            break
          }
        } catch {
          // An unreadable reference simply stays a candidate.
        }
      }
      enriched.push(detected === undefined ? provider : { ...provider, apiKeyEnv: detected, apiKeyDetected: true })
    }
    return enriched
  }

  /**
   * The configured default route, used before the first request of a session.
   * @returns {{provider: string, model: string} | null}
   */
  function defaultSelection() {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // Service absent or not ready: there is no current route to report.
    }
    return null
  }

  /**
   * Snapshot enriched with the provider directory and live credential refs.
   * @returns {Promise<object>} snapshot.
   */
  async function snapshot() {
    const base = controller.snapshot()
    return {
      ...base,
      // The last real request wins; the configured default covers a cold start.
      current: base.current ?? defaultSelection(),
      providers: await providersWithRefs(),
    }
  }

  /**
   * Whether any monitored model depends on the Bailian CLI.
   * @returns {boolean}
   */
  function needsBailianCli() {
    return controller.accounts().some((account) => account.quota?.kind === 'bailian-free')
  }

  /** The installer is asked once per process; a failure allows a later retry. */
  let cliRequested = false

  /**
   * Install the Bailian CLI the first time a Bailian account appears.
   *
   * Startup only prepares the toolchain when accounts already exist, so a user
   * adding their first Bailian model mid-session would otherwise see “not
   * installed” until the next restart.
   *
   * @returns {void}
   */
  function ensureCli() {
    if (cliRequested || typeof prepareCli !== 'function' || !needsBailianCli()) return
    cliRequested = true
    void prepareCli()
      .then((result) => {
        if (result.ok !== true) {
          cliRequested = false
          log('warn', `[quota-guard] 环境准备失败：${result.detail}`)
          return undefined
        }
        if (result.installed === true) {
          controller.resetQuotaCache()
          return controller.refreshAll()
        }
        return undefined
      })
      .catch((error) => {
        cliRequested = false
        log('warn', `[quota-guard] 环境准备失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /**
   * Store an Alibaba Cloud AccessKey pair supplied alongside an account.
   *
   * The balance section only carries reference names; accepting the values in
   * the same request keeps the Settings form a single step.
   *
   * @param {object} body - request carrying `accessKey` / `accessKeySecret`.
   * @param {unknown} balance - the account's balance section.
   * @param {string} [route] - provider id, used in error messages.
   * @returns {Promise<void>}
   */
  async function saveAccessKeyPair(body, balance, route) {
    if (balance === null || typeof balance !== 'object' || balance.kind !== 'aliyun') return
    const credentials = ctx.get('credentials')
    const pairs = [
      { ref: balance.accessKeyEnv, value: body.accessKey, label: 'AccessKey ID' },
      { ref: balance.accessKeySecretEnv, value: body.accessKeySecret, label: 'AccessKey Secret' },
    ]
    for (const pair of pairs) {
      if (typeof pair.value !== 'string' || pair.value.trim() === '') continue
      if (typeof pair.ref !== 'string' || pair.ref === '') bad(`缺少${pair.label}的凭据引用`)
      if (credentials === undefined) bad('凭据服务未挂载，无法保存 AccessKey')
      try {
        await credentials.set(pair.ref, pair.value.trim())
      } catch (error) {
        const where = route === undefined ? '' : `提供方 ${route} 已写入，但 `
        throw new Error(`${where}${pair.label} 保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Store a pi-ai route's API key under the reference the route declares, or a
   * derived one when the profile has none yet.
   *
   * This is what lets “add model” ask only for the key: the endpoint, protocol,
   * quota source, and thresholds already come from the selected platform.
   *
   * @param {unknown} provider - route id.
   * @param {unknown} rawKey - key typed into the form.
   * @returns {Promise<void>}
   */
  async function saveProviderKey(provider, rawKey) {
    if (typeof provider !== 'string' || provider === '') return
    if (typeof rawKey !== 'string' || rawKey.trim() === '') return
    const key = rawKey.trim()
    if (!API_KEY.test(key)) bad('API Key 含非法字符（只允许可打印 ASCII，且不能有空格）')
    const credentials = ctx.get('credentials')
    if (credentials === undefined) bad('凭据服务未挂载，无法保存 API Key')
    const profile = providerProfile(provider)
    const declared = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== ''
      ? profile.apiKeyEnv
      : undefined
    const ref = declared ?? credentialRefFor(provider)
    await credentials.set(ref, key)
    if (declared === undefined) {
      const settings = ctx.get('settings')
      if (settings !== undefined && typeof settings.mutate === 'function') {
        await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', provider, 'apiKeyEnv'], value: ref }])
      }
    }
  }

  /**
   * Make one route declare every model its accounts may switch to.
   *
   * A provider route can only call the models it lists. Registering an account
   * without touching the route leaves its model unreachable: the page then
   * reports a healthy allowance while the actual switch fails with
   * "Select an available model before sending a message", and the auto
   * failover/recommendation layers — which only read the route's catalog —
   * never see the model at all.
   *
   * @param {string} provider - route id.
   * @param {string[]} modelIds - models the accounts need to be callable.
   * @returns {Promise<void>}
   */
  async function ensureRouteModels(provider, modelIds) {
    if (typeof provider !== 'string' || provider === '') return
    const wanted = [...new Set(modelIds
      .filter((id) => typeof id === 'string' && MODEL_ID.test(id.trim()))
      .map((id) => id.trim()))]
    if (wanted.length === 0) return
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.mutate !== 'function') return
    const entry = configurableEntry(provider)
    if (entry === undefined) return
    const profile = providerProfile(provider)
    if (profile === undefined) return
    // Only pi-ai-shaped routes carry a callable model catalog; another
    // adapter's profile must never be rewritten here.
    if (typeof profile.api !== 'string' || typeof profile.baseURL !== 'string') return
    const current = Array.isArray(profile.models) ? profile.models : []
    const known = new Set(current
      .map((model) => (model !== null && typeof model === 'object' ? model.id : undefined))
      .filter((id) => typeof id === 'string'))
    const missing = wanted.filter((id) => !known.has(id))
    if (missing.length === 0) return
    const merged = mergeRouteModels(current, missing.map((id) => ({ id })))
    await settings.mutate(entry.settingsNs, [{
      op: 'set',
      path: [...(Array.isArray(entry.settingsPath) ? entry.settingsPath : []), 'models'],
      value: merged,
    }])
    log('info', `[quota-guard] 已把 ${missing.join(', ')} 写入提供方 ${provider} 的模型列表`)
  }

  /**
   * Whether a route belongs to Alibaba Cloud Model Studio, whose free allowance
   * only the CLI can read.
   * @param {string | undefined} provider - route id.
   * @param {string | undefined} baseURL - endpoint root.
   * @returns {boolean}
   */
  function isBailian(provider, baseURL) {
    return /dashscope|bailian|qwen|aliyun/i.test(`${provider ?? ''} ${baseURL ?? ''}`)
  }

  /**
   * The Bailian per-model allowance rows, when the CLI can answer.
   * @param {string | undefined} provider - route id.
   * @param {string | undefined} baseURL - endpoint root.
   * @returns {Promise<object[] | undefined>}
   */
  async function bailianQuotaFor(provider, baseURL) {
    if (!isBailian(provider, baseURL)) return undefined
    try {
      const result = await freeQuotaProbe()
      return result.ok === true ? result.models : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Move the deployment default off a route that is about to disappear.
   *
   * dsh refuses to start a session while the default points at a provider id
   * that no longer exists, so releasing a route must retarget the default to a
   * surviving account first.
   *
   * @param {string} provider - route being released.
   * @returns {Promise<void>}
   */
  async function releaseDefaultSelection(provider) {
    const selection = defaultSelection()
    if (selection === null || selection.provider !== provider) return
    const next = controller.accounts()
      .filter((account) => account.provider !== provider)
      .sort((left, right) => left.priority - right.priority)[0]
    if (next === undefined) {
      log('warn', `[quota-guard] 默认模型仍指向已移除的平台 ${provider}，请在设置里改选一个模型`)
      return
    }
    try {
      const defaults = ctx.get('agentDefaultModel')
      if (defaults === undefined || typeof defaults.saveSelection !== 'function') return
      await defaults.saveSelection({ provider: next.provider, model: next.model })
      log('info', `[quota-guard] 默认模型已改到 ${next.provider} / ${next.model}`)
    } catch (error) {
      log('warn', `[quota-guard] 切换默认模型失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Drop a pi-ai route once no monitored account refers to it.
   *
   * Removing a model should also free its provider id, otherwise "新建提供方"
   * keeps rejecting the same platform as already occupied. Only routes the
   * plugin can see as `llm-pi-ai` profiles are released; native adapters keep
   * whatever the user configured.
   *
   * @param {string} provider - route id.
   * @returns {Promise<void>} never rejects.
   */
  async function releaseRoute(provider) {
    if (controller.accounts().some((account) => account.provider === provider)) return
    if (providerProfile(provider) === undefined) return
    await releaseDefaultSelection(provider)
    const settings = ctx.get('settings')
    if (typeof settings?.mutate !== 'function') return
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', provider] }])
      log('info', `[quota-guard] 已释放提供方路由 ${provider}（不再有监控账户）`)
    } catch (error) {
      log('warn', `[quota-guard] 释放提供方路由 ${provider} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    providers,

    /**
     * Read the current status document.
     * @returns {Promise<object>} snapshot.
     */
    async state() {
      return snapshot()
    },

    /**
     * Force a balance refresh.
     * @returns {Promise<object>} snapshot after the refresh.
     */
    async refresh(body) {
      if (body !== null && typeof body === 'object' && body.force === true) controller.resetQuotaCache()
      await controller.refreshAll()
      return snapshot()
    },

    /**
     * Add or update one monitored account.
     * @param {object} body - account fields.
     * @returns {Promise<object>} snapshot.
     */
    async saveAccount(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      // The route must know the model before the account points at it: an
      // unlisted model shows a healthy allowance but cannot actually be called.
      await ensureRouteModels(body.provider, [body.model, ...(Array.isArray(body.models) ? body.models : [])])
      await saveProviderKey(body.provider, body.apiKey)
      await saveAccessKeyPair(body, body.balance)
      await controller.upsertAccount(body)
      ensureCli()
      return snapshot()
    },

    /**
     * Change fields of an already-saved account.
     *
     * Unlike saveAccount (which replaces the whole entry), this merges the
     * submitted fields onto the stored account, so an edit never silently
     * resets the parts of the configuration the form did not touch.
     * @param {object} body - `{ id, ...fieldsToChange }`.
     * @returns {Promise<object>} snapshot.
     */
    async updateAccount(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const id = text(body.id, '账户 ID', 80)
      const existing = controller.accounts().find((account) => account.id === id)
      if (existing === undefined) bad(`账户 ${id} 不存在`)
      await saveProviderKey(existing.provider, body.apiKey)
      await saveAccessKeyPair(body, body.balance)
      const merged = mergeAccount(existing, body)
      // An edit can move the account to a model the route does not list yet.
      await ensureRouteModels(merged.provider, [merged.model, ...(Array.isArray(merged.models) ? merged.models : [])])
      await controller.upsertAccount(merged)
      ensureCli()
      return snapshot()
    },

    /**
     * Remove one monitored account.
     *
     * A pi-ai route that no longer has any monitored account is released too:
     * otherwise its provider id stays "occupied" and the same platform cannot be
     * declared again. Routes outside `llm-pi-ai` are never touched.
     *
     * @param {object} body - `{ id }`.
     * @returns {Promise<object>} snapshot.
     */
    async deleteAccount(body) {
      const id = text(body?.id, '账户 ID', 80)
      const account = controller.accounts().find((entry) => entry.id === id)
      if (account === undefined) bad(`账户 ${id} 不存在`)
      const removed = await controller.removeAccount(id)
      if (!removed) bad(`账户 ${id} 不存在`)
      await releaseRoute(account.provider)
      return snapshot()
    },

    /**
     * Remove every monitored model of one platform in a single step.
     *
     * The id list is captured before deleting so the loop is stable; the route
     * is released once, after the last account is gone.
     *
     * @param {object} body - `{ provider }`.
     * @returns {Promise<object>} snapshot.
     */
    async clearProvider(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const provider = text(body.provider, 'Provider ID', 80)
      const ids = controller.accounts()
        .filter((account) => account.provider === provider)
        .map((account) => account.id)
      for (const id of ids) await controller.removeAccount(id)
      if (ids.length > 0) await releaseRoute(provider)
      return snapshot()
    },

    /**
     * Check the local toolchain and install what the accounts need (Bailian CLI).
     * @returns {Promise<{ok: boolean, detail: string}>} outcome.
     */
    async setupCli() {
      if (typeof prepareCli !== 'function') bad('当前部署不支持本地工具安装')
      return prepareCli()
    },

    /**
     * Make every monitored model callable on its route.
     *
     * Runs at startup so models registered before the route was kept in sync
     * (or added by an older build) become usable without being removed and
     * re-added.
     * @returns {Promise<void>}
     */
    async syncRouteModels() {
      for (const account of controller.accounts()) {
        await ensureRouteModels(account.provider, [
          account.model,
          ...(Array.isArray(account.models) ? account.models : []),
        ])
      }
    },

    /**
     * Choose how the second-level failover orders its candidates.
     *
     * `auto` keeps the measured-health ranking (the default); `manual` follows
     * the priority order the user arranged on the page.
     *
     * @param {object} body - `{ switchOrder: 'auto' | 'manual' }`.
     * @returns {Promise<object>} snapshot.
     */
    async setSwitchOrder(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      if (body.switchOrder !== 'auto' && body.switchOrder !== 'manual') {
        bad('switchOrder 必须是 auto 或 manual')
      }
      await controller.setSwitchOrder(body.switchOrder)
      return snapshot()
    },

    /**
     * Move one account up or down among the models of its own provider.
     *
     * Manual order is per platform: moving a Bailian model never reorders the
     * Volcano models. The siblings are renumbered in tens so the moved item
     * always lands on a distinct priority, even when several started equal.
     *
     * @param {object} body - `{ id, direction: 'up' | 'down' }`.
     * @returns {Promise<object>} snapshot.
     */
    async reorderAccount(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const id = text(body.id, '账户 ID', 80)
      const direction = body.direction
      if (direction !== 'up' && direction !== 'down') bad('direction 必须是 up 或 down')
      const list = [...controller.accounts()]
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      const target = list.find((account) => account.id === id)
      if (target === undefined) bad(`账户 ${id} 不存在`)
      const siblings = list.filter((account) => account.provider === target.provider)
      const index = siblings.indexOf(target)
      const neighbour = direction === 'up' ? index - 1 : index + 1
      if (neighbour < 0 || neighbour >= siblings.length) return snapshot()
      ;[siblings[index], siblings[neighbour]] = [siblings[neighbour], siblings[index]]
      for (const [position, account] of siblings.entries()) {
        const priority = (position + 1) * 10
        if (account.priority === priority) continue
        await controller.upsertAccount({ ...serializeAccount(account), priority })
      }
      return snapshot()
    },

    /**
     * Other models of one platform that still carry free quota.
     *
     * Advisory only: the Settings page renders them next to an exhausted card
     * and the user picks one explicitly.
     *
     * @param {object} body - `{ provider }`.
     * @returns {Promise<{models: object[]}>} sorted candidates.
     */
    async recommendations(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const provider = text(body.provider, 'Provider ID', 80)
      return { models: await controller.recommendations(provider) }
    },

    /**
     * Switch the foreground to one suggested model in a single click.
     *
     * The model is first adopted into the monitored list, then the live Session
     * selection is replaced so the dsh model picker follows the switch. A
     * deployment without a Session controller falls back to the saved default,
     * and the request-time failover still covers the rest.
     *
     * @param {object} body - `{ provider, model }`.
     * @returns {Promise<object>} snapshot plus the applied switch mode.
     */
    async switchModel(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const provider = text(body.provider, 'Provider ID', 80)
      const model = text(body.model, '模型 ID', 200)
      // A suggested model may not be declared on the route yet; declaring it is
      // what makes the one-click switch (and later failovers) actually callable.
      await ensureRouteModels(provider, [model])
      controller.resetQuotaCache()
      const account = await controller.adoptModel(provider, model)
      if (account === undefined) bad(`模型 ${model} 不在提供方 ${provider} 的路由里，或该平台不支持按模型切换额度`)
      let applied = { mode: null, reason: '' }
      if (typeof switchForeground === 'function') {
        try {
          const result = await switchForeground(provider, model)
          applied = { mode: result?.mode ?? null, reason: result?.reason ?? '' }
        } catch (error) {
          applied = { mode: null, reason: error instanceof Error ? error.message : String(error) }
          log('warn', `[quota-guard] 前台模型切换失败：${applied.reason}`)
        }
      }
      controller.noteSwitch({ provider, model, mode: applied.mode, reason: applied.reason })
      // Only claim the foreground route when the Session selection really moved;
      // otherwise the page would show a model the picker is not using.
      if (applied.mode === 'session') controller.noteRoute(provider, model)
      return { ...(await snapshot()), switched: applied.mode, switchError: applied.reason }
    },

    /**
     * Ask a provider endpoint which models it advertises.
     *
     * Accepts either a draft (`baseURL` + `api` + one-shot `apiKey`) or an
     * existing route; the adapter that owns the route answers from its own
     * catalog when it can, so an existing provider needs no network call.
     *
     * @param {object} body - `{ provider?, baseURL?, api?, apiKey? }`.
     * @returns {Promise<{models: object[]}>} candidate models.
     */
    async discoverModels(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const llm = ctx.get('llm')
      if (llm === undefined || (typeof llm.discoverModels !== 'function' && typeof llm.listModels !== 'function')) {
        bad('当前运行时不支持模型发现')
      }

      const provider = optionalText(body.provider)
      const explicitBase = optionalText(body.baseURL)
      const api = optionalText(body.api)
      const apiKey = optionalText(body.apiKey)
      if (provider === undefined && explicitBase === undefined) bad('需要 provider 或 baseURL')

      const profile = provider === undefined ? undefined : providerProfile(provider)
      const baseURL = explicitBase ?? (typeof profile?.baseURL === 'string' ? profile.baseURL : undefined)
      const resolvedApi = api ?? (typeof profile?.api === 'string' ? profile.api : undefined)

      // An existing route's adapter only lists the models the route was
      // configured with (usually one). That catalog is a starting point, not the
      // platform's catalog: asking the endpoint itself is what exposes the rest.
      const catalog = []
      if (provider !== undefined) {
        try {
          const listed = await llm.listModels?.(provider)
          if (Array.isArray(listed)) {
            catalog.push(...normalizeDiscovered(listed.map((item) => ({ id: item?.id, name: item?.name }))))
          }
        } catch {
          // Adapters that cannot enumerate their catalog fall through to discovery.
        }
      }
      // Bailian publishes its per-model free allowance only through its CLI;
      // read it once and fold it into whatever listing comes back.
      const freeQuota = await bailianQuotaFor(provider, baseURL)
      const listing = (models) => (freeQuota === undefined ? { models } : { models, freeQuota })

      // A brand-new Bailian route has no catalog at all; the CLI still knows the
      // platform's models, so a first-time user picks from that list instead of
      // typing model ids from memory.
      if (provider !== undefined && catalog.length === 0 && freeQuota !== undefined) {
        const allowed = withAllowanceModels([], freeQuota)
        if (allowed.length > 0) return listing(allowed)
      }

      // A route already declares the models dsh can call; on a Bailian route the
      // CLI additionally knows the rest of the platform's allowance, and saving
      // one of those declares it on the route too.
      if (provider !== undefined && catalog.length > 0) {
        return listing(withAllowanceModels(catalog, freeQuota))
      }

      let key = apiKey
      if (key === undefined && typeof profile?.apiKeyEnv === 'string') {
        try {
          const hit = await ctx.get('credentials')?.resolve?.(profile.apiKeyEnv)
          if (typeof hit?.value === 'string' && hit.value !== '') key = hit.value
        } catch {
          // A credential that cannot be read simply leaves discovery unauthenticated.
        }
      }

      let directory = []
      try {
        directory = llm.listConfigurableProviders?.() ?? []
      } catch {
        directory = []
      }
      const namespaces = []
      if (provider !== undefined) {
        const entry = directory.find((item) => item !== null && typeof item === 'object'
          && item.provider === provider && typeof item.settingsNs === 'string')
        if (entry !== undefined) namespaces.push(entry.settingsNs)
      }
      try {
        for (const ns of llm.listModelDiscoveryNamespaces?.() ?? []) {
          if (typeof ns === 'string' && !namespaces.includes(ns)) namespaces.push(ns)
        }
      } catch {
        // No discovery registry: fall back to the pi-ai namespace below.
      }
      if (namespaces.length === 0) namespaces.push('llm-pi-ai')

      // Two questions, two answers: naming the route returns the adapter's
      // installed catalog, while a bare baseURL is what makes the adapter hit
      // the endpoint's /models. A named provider short-circuits before the
      // network, so the platform's full catalog only comes from the second form.
      const attempts = []
      if (provider !== undefined) {
        attempts.push({
          provider,
          ...(baseURL === undefined ? {} : { baseURL }),
          ...(resolvedApi === undefined ? {} : { api: resolvedApi }),
          ...(key === undefined ? {} : { apiKey: key }),
        })
      }
      // A route already declares the models dsh can actually call. Those are the
      // only ones worth listing — an unconfigured model cannot be routed to, so
      // the platform's full catalog is only asked for when the route has none.
      if (baseURL !== undefined && catalog.length === 0) {
        attempts.push({
          baseURL,
          ...(resolvedApi === undefined ? {} : { api: resolvedApi }),
          ...(key === undefined ? {} : { apiKey: key }),
        })
      }
      if (attempts.length === 0) attempts.push({})

      const collected = []
      // Ask the endpoint itself only when the route declares no catalog of its
      // own; otherwise the route's models already answer the question.
      if (baseURL !== undefined && catalog.length === 0) {
        collected.push(...await listedModels(baseURL, resolvedApi, key, fetchImpl))
      }
      let failure
      let answeredEmpty = false
      for (const request of attempts) {
        for (const ns of namespaces) {
          if (typeof llm.discoverModels !== 'function') break
          try {
            const found = await llm.discoverModels(ns, request)
            const models = normalizeDiscovered(found)
            if (models.length > 0) {
              collected.push(...models)
              break
            }
            answeredEmpty = true
          } catch (error) {
            failure = error
          }
        }
      }
      // Bailian publishes its per-model free allowance only through its CLI; fold
      // it into the listing so the picker can show real remaining numbers.
      if (collected.length > 0 || catalog.length > 0) {
        // The endpoint's catalog wins; the route's own entries fill the gaps it
        // does not mention (they are already known to be callable).
        const seen = new Set()
        const models = []
        for (const model of [...collected, ...catalog]) {
          if (seen.has(model.id)) continue
          seen.add(model.id)
          models.push(model)
        }
        return listing(models)
      }
      // An endpoint that answered with an empty list is a valid answer, not a failure.
      if (answeredEmpty) return listing([])
      if (provider !== undefined && baseURL === undefined) {
        throw new Error(`无法获取 ${provider} 的模型列表：该适配器既没有公布模型目录，也没有注册模型发现接口，请手动填写模型 ID`)
      }
      throw failure ?? new Error('没有可用的模型发现接口')
    },

    /**
     * Declare a pi-ai route, store its key, and register the account.
     * @param {object} body - provider request.
     * @returns {Promise<object>} snapshot.
     */
    async createProvider(body) {
      if (body === null || typeof body !== 'object') bad('请求体必须是对象')
      const { route, profile, models, key, credentialRef } = readProvider(body)

      const existing = providers().find((provider) => provider.id === route)
      const current = providerProfile(route)
      // A route this plugin cannot see as an llm-pi-ai profile belongs to some
      // other adapter; writing over it would collide with that adapter.
      if (existing !== undefined && current === undefined) {
        bad(`Provider ID ${route} 已被现有路由占用；同一个平台请改用「使用已有提供方」登记账户，或换一个 ID`)
      }

      const settings = ctx.get('settings')
      if (settings === undefined) bad('设置服务未挂载，无法写入 llm-pi-ai 配置')

      const account = body.account
      if (account === null || typeof account !== 'object') bad('缺少账户配置')
      const model = typeof account.model === 'string' ? account.model.trim() : ''
      if (!models.some((entry) => entry.id === model)) bad('账户使用的模型必须在新提供方的模型列表内')

      // Re-declaring an existing route is a save, not a conflict: keep the
      // models (and the key reference) that are already routed through it and
      // add what this form brings.
      const target = current === undefined
        ? profile
        : {
          ...current,
          ...profile,
          models: mergeRouteModels(current.models, models),
        }

      const credentials = ctx.get('credentials')
      // A reference that is meant to be reused must already hold a secret:
      // otherwise the route would be stored pointing at nothing.
      if (key === '' && credentialRef !== undefined) {
        if (credentials !== undefined && typeof credentials.describe === 'function') {
          let info
          try {
            info = await credentials.describe(credentialRef)
          } catch {
            info = undefined
          }
          if (info === null || info === undefined || info.configured !== true) {
            bad(`凭据 ${credentialRef} 未配置，请填入 API Key 或换一个引用`)
          }
        }
      }

      await settings.mutate('llm-pi-ai', [
        { op: 'set', path: ['providers', route], value: target },
      ])

      if (key !== '') {
        if (credentialRef === undefined) bad('缺少凭据引用')
        if (credentials === undefined) bad('凭据服务未挂载，无法保存 API Key')
        try {
          await credentials.set(credentialRef, key)
        } catch (error) {
          throw new Error(`提供方 ${route} 已写入，但 API Key 保存失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // Alibaba Cloud probes sign with an AccessKey pair; accepting the values
      // here keeps "create route + monitor account" a single step.
      await saveAccessKeyPair(body, account.balance, route)

      const accountId = typeof account.id === 'string' && account.id.trim() !== ''
        ? account.id.trim()
        : `${route}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      const submitted = { ...account, id: accountId, provider: route, model }
      // Re-declaring a route that already monitors this model is a save too:
      // replacing the stored entry outright would drop its allowance source and
      // thresholds, leaving a healthy model displayed as "未知".
      const stored = controller.accounts().find((entry) => entry.id === accountId)
      await controller.upsertAccount(stored === undefined ? submitted : mergeAccount(stored, submitted))
      return snapshot()
    },
  }
}
