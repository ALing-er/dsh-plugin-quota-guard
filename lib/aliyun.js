/**
 * Alibaba Cloud BSS OpenAPI balance query.
 *
 * The API is RPC-style and requires an AccessKey signature, so it cannot reuse
 * the bearer-token probes in `probes.js`. Signature version 1.0 (HMAC-SHA1) is
 * implemented here directly on top of `node:crypto`.
 *
 * https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance
 *
 * @module dsh-plugin-quota-guard/aliyun
 */

import { createHmac, randomUUID } from 'node:crypto'

/** Production endpoint of the BSS OpenAPI. */
const DEFAULT_ENDPOINT = 'https://business.aliyuncs.com'
/** API version that carries `QueryAccountBalance`. */
const API_VERSION = '2017-12-14'

/**
 * RFC 3986 encoding as required by Alibaba Cloud signatures.
 * @param {unknown} value - raw parameter.
 * @returns {string}
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Sign a parameter map with SignatureVersion 1.0.
 * @param {Record<string, string>} params - parameters excluding `Signature`.
 * @param {string} accessKeySecret - secret key.
 * @returns {string} base64 signature.
 */
export function signParams(params, accessKeySecret) {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
}

/**
 * Build the signed request URL.
 * @param {{accessKeyId: string, accessKeySecret: string, endpoint?: string, now?: number}} options - credentials.
 * @returns {string}
 */
export function signedUrl(options) {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const params = {
    Action: 'QueryAccountBalance',
    Version: API_VERSION,
    Format: 'JSON',
    AccessKeyId: options.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    Timestamp: new Date(options.now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  params.Signature = signParams(params, options.accessKeySecret)
  const query = Object.keys(params)
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
  return `${endpoint}/?${query}`
}

/**
 * Query the account balance. Never throws.
 * @param {object} options - query dependencies.
 * @param {string} options.accessKeyId - AccessKey ID.
 * @param {string} options.accessKeySecret - AccessKey secret.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} options.timeoutMs - per-request timeout.
 * @param {number} [options.now] - clock override.
 * @returns {Promise<{ok: true, amount: number, currency: string | null} | {ok: false, reason: string}>}
 */
export async function queryAccountBalance(options) {
  const fetchImpl = options.fetchImpl
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前运行时没有可用的 fetch' }

  let url
  try {
    url = signedUrl(options)
  } catch (error) {
    return { ok: false, reason: `构造请求失败：${error instanceof Error ? error.message : String(error)}` }
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    return { ok: false, reason: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }

  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '（AccessKey 无效或缺少 AliyunBSSReadOnlyAccess 权限）' : ''
    let code = ''
    let message = ''
    try {
      const body = await response.json()
      if (body !== null && typeof body === 'object') {
        if (typeof body.Code === 'string') code = body.Code
        if (typeof body.Message === 'string') message = body.Message
      }
    } catch {
      // A non-JSON error body adds nothing.
    }
    const detail = code === '' ? '' : ` ${code}${message === '' ? '' : `：${message}`}`
    const timeHint = code === 'InvalidTimeStamp.Expired' ? '（本机时间与服务器偏差过大，请校准系统时间）' : ''
    return { ok: false, reason: `HTTP ${response.status}${hint}${detail}${timeHint}` }
  }

  let json
  try {
    json = await response.json()
  } catch (error) {
    return { ok: false, reason: `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }

  if (typeof json?.Code === 'string' && json.Code !== 'Success') {
    const message = typeof json.Message === 'string' ? json.Message : ''
    return { ok: false, reason: `${json.Code}${message === '' ? '' : `：${message}`}` }
  }

  const data = json?.Data ?? {}
  const amount = Number(data.AvailableAmount ?? data.AvailableCashAmount)
  if (!Number.isFinite(amount)) return { ok: false, reason: '响应缺少 Data.AvailableAmount' }
  return { ok: true, amount, currency: typeof data.Currency === 'string' ? data.Currency : null }
}
