/**
 * User-managed account store.
 *
 * The plugin row carries the shipped defaults; accounts added or removed from
 * the Settings page live in `$DSH_HOME/quota-guard.json` so a UI edit survives
 * restarts without rewriting a patch layer.
 *
 * @module dsh-plugin-quota-guard/store
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Resolve the store path under the harness home.
 * @param {NodeJS.ProcessEnv} [env] - environment carrying `DSH_HOME`.
 * @param {string} [home] - fallback user home.
 * @returns {string} absolute file path.
 */
export function defaultStorePath(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = configured === '' ? join(home, '.dsh') : configured
  return join(root, 'quota-guard.json')
}

/**
 * Read the store synchronously at plugin load; a broken file must never block
 * the harness from booting.
 * @param {string} path - store path.
 * @param {(text: string) => void} [warn] - warning sink.
 * @returns {{version?: number, accounts?: unknown[]} | undefined} parsed store.
 */
export function readStoreSync(path, warn) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象')
    }
    if (parsed.accounts !== undefined && !Array.isArray(parsed.accounts)) {
      throw new Error('accounts 必须是数组')
    }
    return parsed
  } catch (error) {
    warn?.(`[quota-guard] 忽略无法解析的 ${path}：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Persist the store atomically (write a sibling temp file, then rename).
 * @param {string} path - store path.
 * @param {object} value - JSON-compatible document.
 * @returns {Promise<void>}
 */
export async function writeStore(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}
