import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultStorePath, readStoreSync, writeStore } from '../lib/store.js'

test('defaultStorePath honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(defaultStorePath({ DSH_HOME: 'D:/harness' }, 'C:/Users/x'), join('D:/harness', 'quota-guard.json'))
  assert.equal(defaultStorePath({}, 'C:/Users/x'), join('C:/Users/x', '.dsh', 'quota-guard.json'))
  assert.equal(defaultStorePath({ DSH_HOME: '   ' }, 'C:/Users/x'), join('C:/Users/x', '.dsh', 'quota-guard.json'))
})

test('readStoreSync reports a missing file as undefined', () => {
  assert.equal(readStoreSync(join(tmpdir(), 'definitely-not-there', 'quota-guard.json')), undefined)
})

test('writeStore then readStoreSync round-trips accounts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-guard-'))
  try {
    const path = join(dir, 'nested', 'quota-guard.json')
    await writeStore(path, { version: 1, accounts: [{ id: 'a', provider: 'p', model: 'm' }] })
    const store = readStoreSync(path)
    assert.equal(store.version, 1)
    assert.equal(store.accounts[0].id, 'a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed store is ignored with a warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-guard-'))
  try {
    const path = join(dir, 'quota-guard.json')
    await writeStore(path, ['not', 'an', 'object'])
    const warnings = []
    assert.equal(readStoreSync(path, (text) => warnings.push(text)), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /忽略无法解析/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
