/**
 * Alibaba Cloud Model Studio (百炼) free-quota reader.
 *
 * The OpenAI-compatible `/models` reply carries no quota data and there is no
 * public HTTP API for the per-model free allowance, so the official CLI is the
 * only scriptable source: `bl usage free --all --output json` answers one row
 * per model with `remaining` / `total` / `remainingPercent` / `expires`.
 *
 * @module dsh-plugin-quota-guard/bailian
 */

import { execFile } from 'node:child_process'

/** The CLI performs a network round-trip; give it more room than a probe. */
const COMMAND_TIMEOUT_MS = 20000

/** Phrases the CLI uses when no console session is configured. */
const AUTH_PATTERN = /No console access token|auth login|Not authenticated|authenticated[^:]*:\s*false|未登录/i
/** One shared message so the page can key the login prompt off the note. */
const LOGIN_REASON = 'bl 未登录（在终端执行 bl auth login --console）'

/**
 * Arguments of the listing command. `--all` omits models whose allowance is
 * gone, so a per-model question has to name the model explicitly.
 * @param {string | undefined} model - model id, when asking about one model.
 * @returns {string[]}
 */
function listArgs(model) {
  const scope = model === undefined || model === '' ? ['--all'] : ['--model', model]
  return ['usage', 'free', ...scope, '--output', 'json']
}

/**
 * Decode one CLI stream. Windows' `cmd.exe` writes its error text in the
 * console code page (GBK on a Chinese system), so a UTF-8 decode produces
 * replacement characters and the “not recognized” match silently fails. Try
 * UTF-8 first and fall back to GBK when the text is visibly broken.
 * @param {Buffer | string | null | undefined} value - raw stream.
 * @returns {string}
 */
function decodeOutput(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/**
 * Run one command and resolve with stdout.
 * @param {string[]} args - CLI arguments.
 * @param {number} timeout - per-call timeout in milliseconds.
 * @returns {Promise<string>} stdout.
 */
function defaultRun(args, timeout) {
  // Keep the raw bytes: decoding happens above so GBK console messages survive.
  const options = { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }
  return new Promise((resolve, reject) => {
    // npm installs the CLI as a `.cmd` shim on Windows, which needs a shell.
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'bl'
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `bl ${args.join(' ')}`] : args
    execFile(command, argv, options, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = decodeOutput(stderr)
        if (detail.trim() !== '') error.stderr = detail
        reject(error)
        return
      }
      resolve(decodeOutput(stdout))
    })
  })
}

/**
 * Turn a CLI failure into a human-readable reason.
 * @param {any} error - rejection from the runner.
 * @returns {string}
 */
function describeFailure(error) {
  const stderr = decodeOutput(error?.stderr)
  const message = error instanceof Error ? error.message : String(error)
  const combined = `${message} ${stderr}`
  if (/ENOENT|not recognized|不是内部或外部命令|command not found/i.test(combined)) {
    return '未安装 bl CLI（npm i -g bailian-cli）'
  }
  if (AUTH_PATTERN.test(combined)) return LOGIN_REASON
  if (/timed? ?out|killed|ETIMEDOUT/i.test(combined)) return 'bl 执行超时'
  const detail = stderr.trim() !== '' ? stderr.trim() : message
  return `bl 执行失败：${detail}`
}

/**
 * Normalize one CLI row.
 * @param {Record<string, unknown>} entry - raw row.
 * @returns {object | undefined}
 */
function normalizeModel(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  if (model === '') return undefined
  const remaining = Number(entry.remaining)
  const total = Number(entry.total)
  // A model whose allowance is gone answers with nulls instead of zeros.
  const hasQuota = Number.isFinite(remaining) && Number.isFinite(total) && total > 0
  const declared = Number(entry.remainingPercent)
  const remainingPercent = Number.isFinite(declared)
    ? declared
    : hasQuota ? (remaining / total) * 100 : 0
  return {
    model,
    type: typeof entry.type === 'string' ? entry.type : undefined,
    remaining: hasQuota ? remaining : 0,
    total: hasQuota ? total : 0,
    remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
    hasQuota,
    expires: typeof entry.expires === 'string' ? entry.expires : undefined,
    autoStop: entry.autoStop === true,
  }
}

/**
 * Models from a CLI listing that still carry free allowance.
 *
 * The listing covers every model family the platform hosts — text, embedding,
 * rerank, image, video and speech — so callers narrow it themselves.
 *
 * @param {unknown[]} rows - normalized rows from {@link queryFreeQuota}.
 * @returns {object[]} rows with allowance left.
 */
export function quotaModels(rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter((row) => row !== null && typeof row === 'object'
    && row.hasQuota === true
    && typeof row.model === 'string')
}

/**
 * Chat models from a CLI listing that still carry free allowance.
 *
 * The picker for switch targets and auto-adoption can only use text models, so
 * embedding, TTS and ASR rows are dropped here.
 *
 * @param {unknown[]} rows - normalized rows from {@link queryFreeQuota}.
 * @returns {object[]} usable text-model rows.
 */
export function usableTextModels(rows) {
  return quotaModels(rows)
    .filter((row) => row.type === undefined || /text/i.test(String(row.type)))
}

/**
 * Read every model's free allowance from the Bailian CLI.
 * @param {object} [options] - seams.
 * @param {string} [options.model] - ask about one model instead of every model.
 * @param {(args: string[], timeout: number) => Promise<string>} [options.run] - runner override (tests).
 * @param {number} [options.timeoutMs] - command timeout.
 * @returns {Promise<{ok: true, models: object[]} | {ok: false, reason: string}>}
 */
export async function queryFreeQuota(options = {}) {
  const run = options.run ?? defaultRun
  const timeout = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  let text
  try {
    text = await run(listArgs(options.model), timeout)
  } catch (error) {
    return { ok: false, reason: describeFailure(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return { ok: false, reason: 'bl 返回的不是合法 JSON' }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // The CLI reports failures as `{error: {code, message, hint}}`.
    const issue = parsed.error
    const detail = typeof issue === 'string'
      ? issue
      : issue !== null && typeof issue === 'object' && typeof issue.message === 'string'
        ? issue.message
        : typeof parsed.message === 'string' ? parsed.message : ''
    if (detail !== '') {
      if (AUTH_PATTERN.test(detail)) return { ok: false, reason: LOGIN_REASON }
      return { ok: false, reason: `bl 返回错误：${detail}` }
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'bl 返回的结构不是模型数组' }
  const models = parsed.map(normalizeModel).filter((model) => model !== undefined)
  return { ok: true, models }
}

/**
 * Whether the Bailian CLI is installed and runs at all.
 * @param {object} [options] - seams.
 * @param {(args: string[], timeout: number) => Promise<string>} [options.run] - runner override (tests).
 * @param {number} [options.timeoutMs] - command timeout.
 * @returns {Promise<{ok: boolean, version?: string, reason?: string}>}
 */
export async function detectCli(options = {}) {
  const run = options.run ?? defaultRun
  try {
    const text = await run(['--version'], options.timeoutMs ?? 10000)
    return { ok: true, version: String(text).trim() }
  } catch (error) {
    return { ok: false, reason: describeFailure(error) }
  }
}

/**
 * Install the CLI globally with npm. Only called when the plugin's own account
 * list needs it and the binary is missing.
 * @param {object} [options] - seams.
 * @param {() => Promise<{ok: boolean, reason?: string}>} [options.run] - installer override (tests).
 * @param {number} [options.timeoutMs] - install timeout.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function installCli(options = {}) {
  if (typeof options.run === 'function') return options.run()
  const optionsExec = { timeout: options.timeoutMs ?? 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm i -g bailian-cli --no-audit --no-fund'] : ['i', '-g', 'bailian-cli', '--no-audit', '--no-fund']
    execFile(command, argv, optionsExec, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true })
        return
      }
      const detail = decodeOutput(stderr).trim() !== '' ? decodeOutput(stderr).trim() : error.message
      resolve({ ok: false, reason: `npm 安装失败：${detail}` })
    })
  })
}
