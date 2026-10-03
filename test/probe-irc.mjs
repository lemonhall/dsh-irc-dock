/**
 * 探路：这台机器能不能连到 IRC 服务器？
 *
 * 三条路都试一下，结果决定 dsh-irc-dock 怎么实现：
 *   1) 直连（Clash 没开 TUN，裸 TCP 不走代理 → 大概率失败）
 *   2) 走本机代理的 HTTP CONNECT 隧道（Clash 的 7897 支持 CONNECT 任意 host:port）
 *   3) 隧道建好后再套 TLS（Libera 的 6697 是 TLS 端口）
 *
 *   node test/probe-irc.mjs
 */
import net from 'node:net'
import tls from 'node:tls'

const HOST = process.argv[2] || 'irc.libera.chat'
const PORT = Number(process.argv[3]) || 6697
const PROXY = { host: '127.0.0.1', port: 7897 }
const TIMEOUT = 12000

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${TIMEOUT}ms`)), TIMEOUT)),
  ])
}

async function direct() {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: HOST, port: PORT })
      socket.once('connect', () => {
        socket.destroy()
        resolve('直连 TCP OK')
      })
      socket.once('error', (error) => reject(error))
    }),
    '直连',
  )
}

/** 通过 HTTP 代理建一条到 host:port 的隧道。 */
function connectViaProxy() {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: PROXY.host, port: PROXY.port })
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString('latin1')
        if (!buffer.includes('\r\n\r\n')) return
        socket.removeListener('data', onData)
        if (/^HTTP\/1\.[01] 200/.test(buffer)) resolve(socket)
        else reject(new Error('代理拒绝：' + buffer.split('\r\n')[0]))
      }
      socket.once('connect', () => {
        socket.write(`CONNECT ${HOST}:${PORT} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\n\r\n`)
        socket.on('data', onData)
      })
      socket.once('error', reject)
    }),
    '代理隧道',
  )
}

async function viaProxyPlain() {
  const socket = await connectViaProxy()
  socket.destroy()
  return 'HTTP CONNECT 隧道 OK'
}

async function viaProxyTls() {
  const socket = await connectViaProxy()
  return withTimeout(
    new Promise((resolve, reject) => {
      const secure = tls.connect({ socket, servername: HOST }, () => {
        secure.write('NICK dshprobe\r\nUSER dshprobe 0 * :probe\r\n')
      })
      let seen = ''
      secure.on('data', (chunk) => {
        seen += chunk.toString('utf8')
        if (seen.length > 40 || /\d{3}/.test(seen)) {
          secure.destroy()
          resolve('隧道 + TLS + IRC 应答 OK：' + seen.split('\r\n')[0].slice(0, 60))
        }
      })
      secure.once('error', reject)
    }),
    'TLS',
  )
}

const results = []
for (const [name, fn] of [
  ['1 直连', direct],
  ['2 代理隧道（明文）', viaProxyPlain],
  ['3 代理隧道 + TLS + IRC', viaProxyTls],
]) {
  try {
    results.push(`✓ ${name}：${await fn()}`)
  } catch (error) {
    results.push(`✗ ${name}：${error.message}`)
  }
}
console.log(results.join('\n'))
