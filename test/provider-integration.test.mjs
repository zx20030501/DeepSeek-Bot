import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as botPlugin from '../dist/index.js'
import {
  HERMES_BOT_FEISHU_SECRET_REF,
  HERMES_BOT_SETTINGS_NAMESPACE,
} from '../dist/setup.js'

class MemorySettingsProvider extends SettingsProvider {
  writable = true
  stored = {}
  failNextPersist = false

  async load() {
    return structuredClone(this.stored)
  }

  async persist(namespace, section) {
    if (this.failNextPersist) {
      this.failNextPersist = false
      throw new Error('controlled settings provider failure')
    }
    this.stored[String(namespace)] = structuredClone(section)
  }

  storedSection(namespace) {
    return structuredClone(this.stored[String(namespace)])
  }
}

class MemoryCredentialProvider extends CredentialProvider {
  values = new Map()
  failNextSetWithValue = false

  async resolve(ref) {
    const value = this.values.get(String(ref))
    return value === undefined ? undefined : { value, source: 'memory-test-provider' }
  }

  async describe(ref) {
    return {
      configured: this.values.has(String(ref)),
      source: this.values.has(String(ref)) ? 'memory-test-provider' : undefined,
      writable: true,
    }
  }

  async set(ref, value) {
    if (value.length === 0) throw new Error('empty credential')
    if (this.failNextSetWithValue) {
      this.failNextSetWithValue = false
      throw new Error(`credential write rejected for ${value}`)
    }
    this.values.set(String(ref), value)
    this.notifyUpdated(ref)
  }

  async unset(ref) {
    const changed = this.values.delete(String(ref))
    if (changed) this.notifyUpdated(ref)
  }
}

function settingsWithProfile(id, title) {
  return {
    enabled: true,
    feishu: { enabled: false, appId: 'cli_provider_test', domain: 'feishu', requireMention: true },
    access: { userIds: [], chatIds: [], pairing: true },
    collaboration: {
      enabled: true,
      autoPlanner: true,
      approvalMode: 'auto-planned',
      defaultSessionScope: 'requester',
      maxGroupBots: 6,
      maxGroupRounds: 3,
      maxGroupMessages: 10,
      maxParallelRuns: 6,
      botRunMaxAttempts: 3,
      features: { dynamicRegistry: true, chatBotCreation: true },
    },
    profiles: [{
      id,
      title,
      description: '',
      provider: '',
      model: '',
      capabilities: [],
      skills: [],
      soul: '',
      fleetRole: 'generalist',
      sessionScope: 'requester',
      allowedUserIds: [],
      allowedChatIds: [],
      approvalRequired: false,
      enabled: true,
    }],
  }
}

async function callRoute(route, method, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(raw === '' ? [] : [Buffer.from(raw)])
  req.method = method
  req.headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    ...(raw === '' ? {} : {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(raw)),
    }),
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  return new Promise((resolve, reject) => {
    const response = { status: 0, headers: {}, body: '' }
    const res = {
      writeHead(status, headers = {}) {
        response.status = status
        response.headers = headers
      },
      end(chunk = '') {
        response.body += String(chunk)
        try {
          resolve({ ...response, json: response.body === '' ? undefined : JSON.parse(response.body) })
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

test('real DSH provider contracts commit setup atomically and restore settings plus credentials on failure', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'deepseek-bot-provider-integration-'))
  const ctx = new Context()
  let route
  const agents = {
    get() { return undefined },
    async resume() { throw new Error('not found') },
    async create() { throw new Error('not used') },
  }
  let supportFiber
  let settingsFiber
  let credentialsFiber
  let botFiber
  try {
    supportFiber = await ctx.plugin({
      name: 'provider-integration-support',
      apply(pluginCtx) {
        pluginCtx.provide('agents', agents)
        pluginCtx.provide('webServer', {
          register(candidate) {
            route = candidate
            return () => { if (route === candidate) route = undefined }
          },
        })
      },
    })
    settingsFiber = await ctx.plugin(MemorySettingsProvider)
    credentialsFiber = await ctx.plugin(MemoryCredentialProvider)
    botFiber = await ctx.plugin(botPlugin, {
      stateDir,
      telegram: { enabled: false },
      feishu: { enabled: false },
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
    })

    assert.ok(route, 'plugin setup route was not registered')
    const settingsProvider = ctx.get('settings')
    const credentialProvider = ctx.get('credentials')
    const secretRef = credentialRef(HERMES_BOT_FEISHU_SECRET_REF)
    const stableSettings = settingsWithProfile('stablebot', 'Stable Bot')
    const firstSecret = 'provider-integration-secret-v1'
    const saved = await callRoute(route, 'POST', {
      action: 'save',
      settings: stableSettings,
      appSecret: firstSecret,
    })

    assert.equal(saved.status, 200)
    assert.equal(settingsProvider.storedSection(HERMES_BOT_SETTINGS_NAMESPACE).profiles[0].id, 'stablebot')
    assert.equal((await credentialProvider.resolve(secretRef))?.value, firstSecret)
    assert.ok(saved.json.diagnostics.bots.some(bot => bot.id === 'stablebot' && bot.title === 'Stable Bot'))
    assert.equal(JSON.stringify(saved.json).includes(firstSecret), false)

    settingsProvider.failNextPersist = true
    const failedSecret = 'provider-integration-secret-v2'
    const rejected = await callRoute(route, 'POST', {
      action: 'save',
      settings: settingsWithProfile('unstablebot', 'Must Roll Back'),
      appSecret: failedSecret,
    })

    assert.equal(rejected.status, 409)
    assert.match(rejected.json.error, /没有保留半完成配置/u)
    assert.equal(settingsProvider.storedSection(HERMES_BOT_SETTINGS_NAMESPACE).profiles[0].id, 'stablebot')
    assert.equal((await credentialProvider.resolve(secretRef))?.value, firstSecret)
    const afterFailure = await callRoute(route, 'GET')
    assert.equal(afterFailure.status, 200)
    assert.ok(afterFailure.json.diagnostics.bots.some(bot => bot.id === 'stablebot'))
    assert.equal(afterFailure.json.diagnostics.bots.some(bot => bot.id === 'unstablebot'), false)
    assert.equal(JSON.stringify(afterFailure.json).includes(firstSecret), false)
    assert.equal(JSON.stringify(afterFailure.json).includes(failedSecret), false)

    credentialProvider.failNextSetWithValue = true
    const reflectedSecret = 'provider-must-not-reflect-this-secret'
    const credentialRejected = await callRoute(route, 'POST', {
      action: 'save',
      settings: settingsWithProfile('credentialbot', 'Credential Failure'),
      appSecret: reflectedSecret,
    })
    assert.equal(credentialRejected.status, 409)
    assert.match(credentialRejected.json.error, /没有保留半完成配置/u)
    assert.equal(JSON.stringify(credentialRejected.json).includes(reflectedSecret), false)
    assert.equal(JSON.stringify(credentialRejected.json).includes(firstSecret), false)
    assert.equal(settingsProvider.storedSection(HERMES_BOT_SETTINGS_NAMESPACE).profiles[0].id, 'stablebot')
    assert.equal((await credentialProvider.resolve(secretRef))?.value, firstSecret)
  } finally {
    if (botFiber) await botFiber.dispose()
    if (credentialsFiber) await credentialsFiber.dispose()
    if (settingsFiber) await settingsFiber.dispose()
    if (supportFiber) await supportFiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})
