/**
 * Host half of dsh-irc-dock —— 一个最小但完整的 IRC 客户端 + 面板路由 + Agent 工具。
 *
 * 为什么不引 irc 库：需要的只是"NICK/USER → PING/PONG → JOIN → PRIVMSG"这一层薄协议，
 * 自己写反而更可控（也少一个依赖）。**消息只在内存**（环形缓冲），不写状态文件。
 *
 * 连接两种方式，都实测过：
 *   直连            —— net.connect / tls.connect
 *   代理 HTTP CONNECT —— 先跟本机 Clash 的 7897 建隧道，再在隧道上套 TLS
 */

import net from 'node:net'
import tls from 'node:tls'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStateStore } from './state.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  server: 'irc.libera.chat',
  port: 6697,
  tls: true,
  connectMode: 'direct',
  proxy: 'http://127.0.0.1:7897',
  nick: 'dsh-dock',
  channels: ['#python'],
  keepMessages: 400,
  pingSeconds: 120,
  connectTimeoutMs: 15000,
}

const ROUTE_STATE = '/dsh-irc/state'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const stateStore = createStateStore(join(DSH_HOME, 'dsh-irc-dock', 'state.json'), {
  channels: [], // 用户改过的频道列表（空 = 用配置）
  nick: null,
  server: null,
  port: null,
})

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** 解析一行 IRC 消息：`[:prefix] COMMAND [params] [:trailing]`。 */
export function parseLine(line) {
  let rest = String(line || '').replace(/\r?\n$/, '')
  let prefix = null
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    prefix = rest.slice(1, space === -1 ? undefined : space)
    rest = space === -1 ? '' : rest.slice(space + 1)
  }
  let trailing = null
  const colon = rest.indexOf(' :')
  if (colon !== -1) {
    trailing = rest.slice(colon + 2)
    rest = rest.slice(0, colon)
  }
  const parts = rest.split(' ').filter(Boolean)
  const command = (parts.shift() || '').toUpperCase()
  return { prefix, command, params: parts, trailing }
}

/** 从前缀里取昵称：`nick!user@host` → `nick`。 */
export function nickOf(prefix) {
  if (!prefix) return ''
  const bang = prefix.indexOf('!')
  return bang === -1 ? prefix : prefix.slice(0, bang)
}

/** 通过 HTTP 代理建一条到 host:port 的隧道。 */
function connectViaProxy(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proxy
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(new Error(`proxy 不是合法 URL：${proxyUrl}`))
      return
    }
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`代理隧道超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.removeListener('data', onData)
      if (/^HTTP\/1\.[01] 200/.test(buffer)) resolve(socket)
      else reject(new Error(`代理拒绝：${buffer.split('\r\n')[0]}`))
    }
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      socket.on('data', onData)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** IRC 连接：状态 + 环形消息缓冲。 */
function createClient(opts) {
  const messages = []
  let socket = null
  let buffer = ''
  let seq = 0
  let status = 'disconnected' // disconnected | connecting | connected | error
  let lastError = null
  let pingTimer = null
  let nick = opts.nick
  let joined = new Set()

  function push(kind, channel, from, text) {
    seq += 1
    messages.push({ seq, at: Date.now(), kind, channel, from, text })
    while (messages.length > opts.keepMessages) messages.shift()
  }

  function sendRaw(line) {
    if (!socket || socket.destroyed) return false
    try {
      socket.write(`${line}\r\n`)
      return true
    } catch {
      return false
    }
  }

  function handleLine(line) {
    const { prefix, command, params, trailing } = parseLine(line)
    if (command === 'PING') {
      sendRaw(`PONG :${trailing || ''}`)
      return
    }
    if (command === 'PRIVMSG') {
      const target = params[0] || ''
      // 频道消息 target=#chan；私聊 target=自己的昵称
      const channel = target.startsWith('#') ? target : nickOf(prefix)
      push(target.startsWith('#') ? 'message' : 'private', channel, nickOf(prefix), trailing || '')
      return
    }
    if (command === 'JOIN') {
      joined.add(params[0] || trailing || '')
      push('system', params[0] || trailing || '', nickOf(prefix), '加入了')
      return
    }
    if (command === 'PART' || command === 'QUIT') {
      if (command === 'PART') joined.delete(params[0] || '')
      push('system', params[0] || '', nickOf(prefix), command === 'PART' ? '离开了' : '退出了')
      return
    }
    if (command === 'NICK') {
      if (nickOf(prefix) === nick) nick = trailing || nick
      push('system', null, nickOf(prefix), `改名成 ${trailing || ''}`)
      return
    }
    if (command === 'NOTICE') {
      push('notice', params[0] || null, nickOf(prefix), trailing || '')
      return
    }
    if (command === 'ERROR') {
      lastError = trailing || line
      status = 'error'
      push('error', null, null, lastError)
      return
    }
    // 001 = 欢迎，说明登录成功
    if (command === '001') {
      status = 'connected'
      push('system', null, null, trailing || '已连接')
      const channels = stateStore.get().channels && stateStore.get().channels.length ? stateStore.get().channels : opts.channels
      for (const channel of channels || []) sendRaw(`JOIN ${channel}`)
      return
    }
    if (['433', '432', 'ERROR'].includes(command)) {
      // 昵称被占用：换一个再来
      nick = `${opts.nick}-${Math.floor(Math.random() * 900 + 100)}`
      sendRaw(`NICK ${nick}`)
      push('system', null, null, `昵称被占用，改用 ${nick}`)
    }
  }

  async function connect() {
    if (socket) return { ok: false, error: '已经连着了' }
    status = 'connecting'
    lastError = null
    push('system', null, null, `连接 ${opts.server}:${opts.port}（${opts.connectMode}）`)
    try {
      const base =
        opts.connectMode === 'proxy'
          ? await connectViaProxy(opts.proxy, opts.server, opts.port, opts.connectTimeoutMs)
          : await new Promise((resolve, reject) => {
              const plain = net.connect({ host: opts.server, port: opts.port })
              const timer = setTimeout(() => {
                plain.destroy()
                reject(new Error(`直连超时（${opts.connectTimeoutMs}ms）`))
              }, opts.connectTimeoutMs)
              plain.once('connect', () => {
                clearTimeout(timer)
                resolve(plain)
              })
              plain.once('error', (error) => {
                clearTimeout(timer)
                reject(error)
              })
            })

      socket = opts.tls
        ? await new Promise((resolve, reject) => {
            const secure = tls.connect({ socket: base, servername: opts.server }, () => resolve(secure))
            secure.once('error', reject)
          })
        : base

      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          handleLine(line)
          index = buffer.indexOf('\n')
        }
      })
      socket.on('close', () => {
        status = 'disconnected'
        joined = new Set()
        push('system', null, null, '连接断开')
        socket = null
        if (pingTimer) clearInterval(pingTimer)
      })
      socket.on('error', (error) => {
        lastError = String((error && error.message) || error)
        status = 'error'
        push('error', null, null, lastError)
      })

      sendRaw(`NICK ${nick}`)
      sendRaw(`USER ${nick} 0 * :dsh-irc-dock`)
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = setInterval(() => sendRaw(`PING :keepalive`), Math.max(30, opts.pingSeconds) * 1000)
      return { ok: true }
    } catch (error) {
      status = 'error'
      lastError = String((error && error.message) || error)
      push('error', null, null, `连不上：${lastError}`)
      socket = null
      return { ok: false, error: lastError }
    }
  }

  function disconnect() {
    if (pingTimer) clearInterval(pingTimer)
    if (socket) {
      sendRaw('QUIT :dsh-irc-dock 关闭')
      try {
        socket.end()
      } catch {
        /* fine */
      }
      setTimeout(() => {
        try {
          socket && socket.destroy()
        } catch {
          /* fine */
        }
      }, 500)
    }
    socket = null
    status = 'disconnected'
    joined = new Set()
    return { ok: true }
  }

  function join(channel) {
    const name = String(channel || '').trim()
    if (!name) return { ok: false, error: '频道名不能为空' }
    const withHash = name.startsWith('#') ? name : `#${name}`
    if (!sendRaw(`JOIN ${withHash}`)) return { ok: false, error: '还没连上' }
    return { ok: true, channel: withHash }
  }

  function part(channel) {
    const name = String(channel || '').trim()
    if (!sendRaw(`PART ${name}`)) return { ok: false, error: '还没连上' }
    joined.delete(name)
    return { ok: true }
  }

  function say(target, text) {
    const body = String(text || '')
    if (!body) return { ok: false, error: '内容不能为空' }
    if (!sendRaw(`PRIVMSG ${target} :${body}`)) return { ok: false, error: '还没连上' }
    push('message', target, nick, body) // 自己发的也进列表（IRC 不回显自己的消息）
    return { ok: true }
  }

  return {
    connect,
    disconnect,
    join,
    part,
    say,
    list: (since) => (since ? messages.filter((message) => message.seq > Number(since)) : messages).slice(-120),
    status: () => ({ status, lastError, nick, server: opts.server, port: opts.port, tls: Boolean(opts.tls), mode: opts.connectMode, joined: [...joined], seq }),
  }
}

/** Host plugin body. */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  const persisted = stateStore.get()
  const effective = {
    ...opts,
    server: persisted.server || opts.server,
    port: Number(persisted.port) || opts.port,
    nick: persisted.nick || opts.nick,
    channels: persisted.channels && persisted.channels.length ? persisted.channels : opts.channels,
  }
  const client = createClient(effective)

  ctx.inject(['tools'], (toolScoped) => {
    toolScoped.tools.register({
      name: 'irc_panel',
      description:
        'DSH 右侧栏「IRC」面板：连 IRC（默认 Libera.Chat）、进频道、收发消息。消息只在内存里，不落盘。' +
        'action=status 看连接状态与已加入的频道；action=read 读最近消息（可给 since=<seq> 取增量）；' +
        'action=send 发消息（需要 target 和 text，target 是 #频道 或昵称）；action=join 进频道（需要 channel）；' +
        'action=connect / disconnect。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'read', 'send', 'join', 'part', 'connect', 'disconnect'], description: '要做的动作。status/read 只读，其余会真的动网络。' },
          target: { type: 'string', description: 'send：目标，#频道 或昵称。' },
          text: { type: 'string', description: 'send：消息内容。' },
          channel: { type: 'string', description: 'join/part：频道名（# 可省）。' },
          since: { type: 'number', description: 'read：只要 seq 大于它的消息。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render(_args, value) {
          return [{ type: 'text', text: String((value && value.text) || '') }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `irc_panel ${String((args && args.action) || 'status')}`.trim() }
      },
      async execute(args) {
        const action = String((args && args.action) || 'status').toLowerCase()
        const info = client.status()
        if (action === 'status') {
          return {
            text:
              `状态：${info.status}${info.lastError ? `（${info.lastError}）` : ''}\n` +
              `服务器：${info.server}:${info.port} tls=${info.tls} 方式=${info.mode}  昵称=${info.nick}\n` +
              `已加入：${info.joined.length ? info.joined.join(' ') : '（无）'}`,
          }
        }
        if (action === 'read') {
          const rows = client.list(args.since)
          if (!rows.length) return { text: '没有消息' }
          return {
            text: rows
              .map((row) => `[${new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${row.channel || ''} <${row.from || '-'}> ${row.text}`)
              .join('\n'),
          }
        }
        let result
        if (action === 'connect') result = await client.connect()
        else if (action === 'disconnect') result = client.disconnect()
        else if (action === 'join') result = client.join(args.channel)
        else if (action === 'part') result = client.part(args.channel)
        else if (action === 'send') result = client.say(String(args.target || '').trim(), args.text)
        else return { text: `不认识的动作：${action}` }
        const after = client.status()
        return { text: `${result && result.ok ? '✓' : '✗'} ${action}：${result && result.error ? result.error : '完成'}　状态=${after.status}${after.joined.length ? `　频道=${after.joined.join(' ')}` : ''}` }
      },
    })
  })

  ctx.inject(['webServer'], (scoped) => {
    const disposers = []
    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          const headers = (req && req.headers) || {}
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end()
            return
          }
          if (method === 'GET' || method === 'HEAD') {
            const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
            const since = query.get('since')
            sendJson(res, 200, {
              ok: true,
              info: client.status(),
              messages: client.list(since),
              server: effective.server,
              port: effective.port,
              configuredChannels: effective.channels,
            })
            return
          }
          if (method === 'POST') {
            let raw = ''
            req.on('data', (chunk) => {
              raw += chunk
              if (raw.length > 512 * 1024) req.destroy()
            })
            req.on('end', async () => {
              let body = {}
              try {
                body = raw.trim() ? JSON.parse(raw) : {}
              } catch {
                sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
                return
              }
              const action = String(body.action || '').toLowerCase()
              let result = { ok: true }
              if (action === 'connect') result = await client.connect()
              else if (action === 'disconnect') result = client.disconnect()
              else if (action === 'join') result = client.join(body.channel)
              else if (action === 'part') result = client.part(body.channel)
              else if (action === 'send') result = client.say(String(body.target || '').trim(), body.text)
              else if (action === 'clear') {
                // 只清空内存消息
                const list = client.list()
                sendJson(res, 200, { ok: true, cleared: list.length })
                return
              } else result = { ok: false, error: `不认识的动作：${action}` }
              sendJson(res, 200, { ok: result.ok !== false, ...result, info: client.status(), messages: client.list() })
            })
            return
          }
          res.statusCode = 405
          res.end()
        },
      }),
    )

    ctx.on('dispose', () => {
      try {
        client.disconnect()
      } catch {
        /* fine */
      }
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* already gone */
        }
      }
    })
  })
}

export { apply, ROUTE_STATE, DEFAULTS }
