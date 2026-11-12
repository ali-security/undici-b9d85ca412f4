'use strict'

const assert = require('node:assert/strict')
const { constants } = require('node:crypto')
const { once } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createSecureContext, createServer } = require('node:tls')
const { test } = require('node:test')

const { Client } = require('..')

const fixtures = join(__dirname, 'fixtures', 'tls-renegotiation')
const matching = {
  key: readFileSync(join(fixtures, 'matching-key.pem')),
  cert: readFileSync(join(fixtures, 'matching-cert.pem'))
}
const wrongHost = {
  key: readFileSync(join(fixtures, 'wrong-key.pem')),
  cert: readFileSync(join(fixtures, 'wrong-cert.pem'))
}
const ca = readFileSync(join(fixtures, 'ca.pem'))

// tls.TLSSocket#setKeyCert() is only available on Node.js >= 20.17 / 22.5.
// On older runtimes install the wrong-host context as the connection's SNI
// context instead: OpenSSL re-runs the server name callback for the
// renegotiation ClientHello, which switches the connection to that certificate.
function presentWrongHostCert (socket) {
  if (typeof socket.setKeyCert === 'function') {
    socket.setKeyCert(wrongHost)
  } else {
    socket._handle.sni_context = createSecureContext(wrongHost).context
  }
}

// @see https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm
for (const protocol of ['http/1.1', 'h2']) {
  test(`TLS certificate errors after ${protocol} connection establishment reject the request`, async (t) => {
    let startRenegotiation
    const renegotiationStarted = new Promise((resolve) => {
      startRenegotiation = resolve
    })
    const sockets = new Set()
    const server = createServer({
      ...matching,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      secureOptions: constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
      ALPNProtocols: [protocol]
    }, (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      socket.once('data', () => {
        setTimeout(() => {
          presentWrongHostCert(socket)
          startRenegotiation(socket.renegotiate({
            requestCert: false,
            rejectUnauthorized: false
          }, () => {}))
        }, 50)
      })
    })

    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    const client = new Client(`https://localhost:${server.address().port}`, {
      allowH2: protocol === 'h2',
      connect: {
        ca,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        lookup (hostname, options, callback) {
          if (options.all === true) {
            callback(null, [{ address: '127.0.0.1', family: 4 }])
          } else {
            callback(null, '127.0.0.1', 4)
          }
        }
      }
    })

    t.after(async () => {
      await client.destroy()
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => server.close(resolve))
    })

    const disconnected = once(client, 'disconnect')
    const rejected = assert.rejects(
      client.request({ path: '/', method: 'GET' }),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
    )

    assert.equal(await renegotiationStarted, true)
    await rejected
    // v6 can reject the HTTP/2 stream before its socket close has updated the
    // client connection state. Wait for disconnect before issuing the follow-up.
    await disconnected

    // The errored HTTP/1.1 connection must not be reused to serve a later
    // request. v6's experimental HTTP/2 client cannot redispatch after this
    // transport failure, so its regression assertion ends at disconnect.
    if (protocol === 'http/1.1') {
      await assert.rejects(
        client.request({ path: '/', method: 'GET' }),
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
      )
    }
  })
}
