/**
 * Client half of dsh-irc-dock —— 右侧栏的「IRC」tab。
 *
 * 左侧频道、右侧消息流、底部输入。消息来自宿主内存（不落盘），
 * 用 since=<seq> 只取增量，避免每轮把整段历史搬一遍。
 * ⚠️ 整个模块包在 IIFE 里（DSH 把客户端插件拼成一个脚本，顶层 const 会撞名）。
 */

;(() => {
const TAB_KIND = 'irc'
const TAB_ID = 'dsh-irc-dock:irc'
const ROUTE_STATE = '/dsh-irc/state'

window.__ModuleLoader__.load({
  id: 'dsh-irc-dock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary, #5a7cff)',
      warn: '#ffb020',
      err: '#ff5a4d',
      ok: '#3ddc84',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const STATUS_TEXT = { disconnected: '未连接', connecting: '连接中…', connected: '已连接', error: '出错' }

    function fmtTime(ms) {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    function IrcPanel() {
      const [info, setInfo] = React.useState(null)
      const [messages, setMessages] = React.useState([])
      const [target, setTarget] = React.useState('#python')
      const [draft, setDraft] = React.useState('')
      const [joinName, setJoinName] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const seqRef = React.useRef(0)
      const listRef = React.useRef(null)

      const pull = React.useCallback(
        (full) => {
          const url = full || !seqRef.current ? ROUTE_STATE : `${ROUTE_STATE}?since=${seqRef.current}`
          return fetch(url)
            .then((response) => response.json())
            .then((payload) => {
              if (!payload || !payload.ok) return
              setInfo(payload.info)
              if (full) {
                setMessages(payload.messages || [])
                seqRef.current = (payload.messages || []).reduce((max, row) => Math.max(max, row.seq || 0), 0)
              } else if ((payload.messages || []).length) {
                setMessages((prev) => [...prev, ...payload.messages].slice(-400))
                seqRef.current = payload.messages.reduce((max, row) => Math.max(max, row.seq || 0), seqRef.current)
              }
            })
            .catch(() => {})
        },
        [],
      )

      React.useEffect(() => {
        pull(true)
        const timer = setInterval(() => pull(false), 2500)
        return () => clearInterval(timer)
      }, [pull])

      React.useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      }, [messages])

      const post = React.useCallback(
        (body) => {
          setBusy(true)
          return fetch(ROUTE_STATE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then((response) => response.json())
            .then((payload) => {
              if (payload && payload.info) setInfo(payload.info)
              if (payload && Array.isArray(payload.messages)) {
                setMessages(payload.messages)
                seqRef.current = payload.messages.reduce((max, row) => Math.max(max, row.seq || 0), 0)
              }
            })
            .catch(() => {})
            .finally(() => setBusy(false))
        },
        [],
      )

      const status = (info && info.status) || 'disconnected'
      const joined = (info && info.joined) || []
      const channels = joined.length ? joined : (info && info.joined) || []
      const allTargets = [...new Set([...(channels || []), target].filter(Boolean))]
      const shown = messages.filter((row) => !row.channel || row.channel === target || row.kind !== 'message')

      const send = () => {
        const text = draft.trim()
        if (!text || !target) return
        setDraft('')
        if (text.startsWith('/')) {
          const [cmd, ...rest] = text.slice(1).split(' ')
          if (cmd === 'join') post({ action: 'join', channel: rest[0] || '' })
          else if (cmd === 'part') post({ action: 'part', channel: rest[0] || target })
          else post({ action: 'send', target, text })
          return
        }
        post({ action: 'send', target, text })
      }

      const tone = status === 'connected' ? C.ok : status === 'error' ? C.err : C.dim

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12 } },
          h('span', { style: { fontWeight: 600 } }, '💬 IRC'),
          h('span', { style: { width: 7, height: 7, borderRadius: 7, background: tone, flex: 'none' } }),
          h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: tone } }, STATUS_TEXT[status] || status),
          h('span', { style: { fontFamily: C.mono, fontSize: 10, color: C.dim } }, info ? `${info.server}:${info.port}` : ''),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => post({ action: status === 'connected' ? 'disconnect' : 'connect' }),
              style: { marginLeft: 'auto', ...btn(), borderColor: tone, color: tone },
            },
            status === 'connected' ? '断开' : '连接',
          ),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
          // 左：频道
          h(
            'div',
            { style: { width: 152, flex: 'none', borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' } },
            h(
              'div',
              { style: { flex: '1 1 auto', overflow: 'auto', padding: '6px 4px' } },
              (allTargets.length ? allTargets : ['（还没进频道）']).map((name) =>
                h(
                  'div',
                  {
                    key: name,
                    onClick: () => !name.startsWith('（') && setTarget(name),
                    style: {
                      padding: '4px 8px',
                      borderRadius: 6,
                      fontSize: 11.5,
                      cursor: name.startsWith('（') ? 'default' : 'pointer',
                      color: target === name ? C.text : C.dim,
                      background: target === name ? `color-mix(in srgb, ${C.accent} 20%, transparent)` : 'transparent',
                    },
                  },
                  name,
                ),
              ),
            ),
            h(
              'div',
              { style: { flex: 'none', display: 'flex', gap: 4, padding: '6px' } },
              h('input', {
                value: joinName,
                onChange: (event) => setJoinName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && joinName.trim()) {
                    post({ action: 'join', channel: joinName.trim() })
                    setTarget(joinName.trim().startsWith('#') ? joinName.trim() : `#${joinName.trim()}`)
                    setJoinName('')
                  }
                },
                placeholder: '#频道',
                style: { flex: '1 1 auto', minWidth: 0, ...input() },
              }),
              h('button', { type: 'button', onClick: () => joinName.trim() && (post({ action: 'join', channel: joinName.trim() }), setJoinName('')), style: btn() }, '进'),
            ),
          ),
          // 右：消息 + 输入
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h(
              'div',
              { ref: listRef, style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '6px 8px', fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.5 } },
              shown.length
                ? shown.map((row) =>
                    h(
                      'div',
                      { key: row.seq, style: { marginBottom: 2, color: row.kind === 'error' ? C.err : row.kind === 'system' || row.kind === 'notice' ? C.dim : C.text, wordBreak: 'break-word' } },
                      h('span', { style: { color: C.dim, fontSize: 10 } }, `${fmtTime(row.at)} `),
                      row.from ? h('span', { style: { color: C.accent } }, `<${row.from}> `) : null,
                      row.text,
                    ),
                  )
                : h('div', { style: { color: C.dim, fontFamily: 'inherit' } }, status === 'connected' ? '还没有消息' : '点右上「连接」开始'),
            ),
            h(
              'div',
              { style: { flex: 'none', display: 'flex', gap: 6, padding: '7px 8px', borderTop: `1px solid ${C.border}` } },
              h('span', { style: { flex: 'none', fontFamily: C.mono, fontSize: 11, color: C.dim, lineHeight: '22px' } }, target || '—'),
              h('input', {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') send()
                },
                placeholder: status === 'connected' ? '说点什么（/join #x 也能用）' : '先连接',
                disabled: status !== 'connected',
                style: { flex: '1 1 auto', minWidth: 0, ...input() },
              }),
              h('button', { type: 'button', onClick: send, disabled: status !== 'connected', style: btn() }, '发'),
            ),
          ),
        ),
      )
    }

    function btn() {
      return {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        fontSize: 11.5,
        padding: '2px 8px',
        cursor: 'pointer',
      }
    }

    function input() {
      return {
        background: 'transparent',
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        color: C.text,
        fontSize: 11.5,
        padding: '3px 6px',
        outline: 'none',
      }
    }

    function IrcBody() {
      return h(IrcPanel)
    }

    function IrcTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { 'aria-hidden': 'true' }, '💬'),
        h('span', null, 'IRC'),
      )
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        scoped.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'IRC',
          guide: [
            {
              id: TAB_KIND,
              kind: TAB_KIND,
              order: 130,
              title: () => 'IRC 聊天',
              description: () => '连 Libera · 进频道 · 收发',
              icon: () => h('span', { style: { fontSize: 16 } }, '💬'),
            },
          ],
        })
      })
      ctx.inject(['slots'], (scoped) => {
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, IrcBody),
        )
        scoped.slots.inject('sidebar.right.pane.tab.title', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, IrcTitle),
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
})()
