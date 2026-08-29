import test from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedLocalRequest } from '../dist/setup-security.js'

function request(headers, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('setup route accepts same-origin loopback requests', () => {
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })), true)
  assert.equal(isTrustedLocalRequest(request({ host: 'localhost:3000' }, '::ffff:127.0.0.1')), true)
})

test('setup route rejects forged host, cross-site and remote requests', () => {
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3000' }, '10.0.0.2')), false)
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3000', origin: 'https://evil.example' })), false)
  assert.equal(isTrustedLocalRequest(request({
    host: '127.0.0.1:3000',
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  })), false)
  assert.equal(isTrustedLocalRequest(request({ host: '192.168.1.2:3000' })), false)
})

test('setup route allows Cursor/VS Code local webview fetches on loopback', () => {
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' })), true)
  assert.equal(isTrustedLocalRequest(request({
    host: '127.0.0.1:3000',
    origin: 'vscode-webview://1a2b3c',
    'sec-fetch-site': 'cross-site',
  })), true)
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3000', origin: 'null' })), true)
})
