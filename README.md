# dsh-irc-dock 💬

DSH 右侧栏的 **IRC 客户端**：宿主用 node `net`/`tls` 直连（也可走本机代理的 HTTP CONNECT 隧道），右侧栏收发消息。

> 这是给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 右侧栏做的一排日常插件之一。
> 右侧栏本来就是 DSH 的「apps 入口」—— 官方的文件/终端/浏览器和第三方插件走的是**完全同一套机制**。

## 效果

![面板](https://cdn.jsdelivr.net/gh/lemonhall/dsh-irc-dock@main/docs/screenshot-panel.png)

（截图只裁了右侧栏面板。想换订阅源/分类/时长这些，改配置就行，不用碰代码。）

## 它能干什么

- 自己写的薄协议层：NICK/USER → PING/PONG → JOIN → PRIVMSG，**不引 irc 库**
- **两种连接方式**：直连，或先跟本机 Clash 做 HTTP CONNECT 建隧道再套 TLS
- **SASL PLAIN 认证**（Libera 从某些网络出口连必须它）、**允许自签证书**（EFnet 就是自签）
- **限次自动重连**（最多 3 次）—— 认证被拒这类问题重连一万次也没用
- 消息只在内存（环形缓冲），**不落盘**；`irc_panel` 工具能读能发

## 装

```
plugin_manager  install_bundle  target=link:E:\development\dsh-irc-dock
```

或从 npm：

```
dsh plugin --profile <你的 profile> add dsh-irc-dock
```

装好之后：右侧栏点「**+**」→ 选「**IRC 聊天**」。

⚠️ **客户端半边改动要重启一次应用**；宿主半边热生效 —— 但**新增宿主路由要重启**（实测，别指望热重载）。

## 它是怎么work的

```
lib/index.js    宿主半：路由 + irc_panel 工具（Agent 侧读写同一份状态）
lib/state.js    本地状态（原子写：临时文件 + rename，读的人不会撞上写了一半的文件）
lib/client.js   右侧栏 tab（整个模块包在 IIFE 里 —— DSH 把所有客户端插件拼成一个脚本，
                顶层 const 会跨插件撞名，实测撞过一次直接把应用挡在启动之外）
```

**双向通道**：状态存在宿主，客户端 2 秒轮询。所以**你在面板里点一下，Agent 调工具就能读到**；
**Agent 写一次，面板自己会跟着变**。这不是"一个只读的看板"。

## 已知限制

- **凭据只从 `$DSH_HOME/dsh-irc-dock/secret.json` 读**（`{saslUser, saslPass}`），绝不进 git
- 不支持 DCC、文件传输、多服务器并发
- 消息不持久化，关掉就没了（这是有意的：聊天记录没必要写盘）

## License

MIT
