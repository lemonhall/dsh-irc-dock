/**
 * IRC 协议行的解析单元测试（纯函数）：
 *   node test/irc.test.mjs
 */
import { parseLine, nickOf } from '../lib/index.js'

let failed = 0
function check(name, actual, expected) {
  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const ok = show(actual) === show(expected)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${show(expected)}\n    实际 ${show(actual)}`}`)
}

// 真实的 IRC 行（都是从 Libera 上见过的那种）
const ping = parseLine('PING :irc.libera.chat')
check('PING 带 trailing', ping.command, 'PING')
check('PING 的 trailing', ping.trailing, 'irc.libera.chat')

const welcome = parseLine(':uranium.libera.chat 001 dsh-dock :Welcome to Libera.Chat dsh-dock')
check('001 命令', welcome.command, '001')
check('001 前缀', welcome.prefix, 'uranium.libera.chat')
check('001 参数', welcome.params, ['dsh-dock'])
check('001 trailing 里的空格保留', welcome.trailing, 'Welcome to Libera.Chat dsh-dock')

const privmsg = parseLine(':alice!~alice@host.example PRIVMSG #python :hello world : with colon')
check('PRIVMSG 命令', privmsg.command, 'PRIVMSG')
check('PRIVMSG 目标', privmsg.params[0], '#python')
check('PRIVMSG 内容（只按第一个 " :" 切）', privmsg.trailing, 'hello world : with colon')
check('PRIVMSG 发信人', nickOf(privmsg.prefix), 'alice')

const notice = parseLine(':uranium.libera.chat NOTICE * :*** Checking Ident')
check('NOTICE', notice.command, 'NOTICE')
check('NOTICE trailing', notice.trailing, '*** Checking Ident')

const join = parseLine(':bob!bob@host JOIN :#python')
check('JOIN', join.command, 'JOIN')
check('JOIN 频道在 trailing', join.trailing, '#python')

const noPrefix = parseLine('ERROR :Closing Link: dsh-dock (Ping timeout)')
check('无前缀也能解析', noPrefix.prefix, null)
check('ERROR trailing', noPrefix.trailing, 'Closing Link: dsh-dock (Ping timeout)')

const empty = parseLine('')
check('空行不炸', empty.command, '')

check('nickOf 只有昵称', nickOf('alice'), 'alice')
check('nickOf 带 user@host', nickOf('alice!~a@h'), 'alice')
check('nickOf 空', nickOf(null), '')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
