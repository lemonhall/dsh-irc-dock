# 我在 DSH 里自己写了个 IRC 客户端，然后被 Libera 拒了

💬 **IRC 客户端** —— DSH 右侧栏的一个新 tab。

## 为什么做这个

想验证一件事：右侧栏能不能承载一个有状态的长连接，而不只是个看板。

## 长什么样

![IRC 客户端](https://cdn.jsdelivr.net/gh/lemonhall/dsh-irc-dock@main/docs/screenshot-panel.png)

（图只截了右侧栏面板。我这台机器桌面左下角有真名，所以截图从来不整屏。）

## 它能干什么

- 自己写的薄协议层：NICK/USER → PING/PONG → JOIN → PRIVMSG，**不引 irc 库**
- **两种连接方式**：直连，或先跟本机 Clash 做 HTTP CONNECT 建隧道再套 TLS
- **SASL PLAIN 认证**（Libera 从某些网络出口连必须它）、**允许自签证书**（EFnet 就是自签）
- **限次自动重连**（最多 3 次）—— 认证被拒这类问题重连一万次也没用
- 消息只在内存（环形缓冲），**不落盘**；`irc_panel` 工具能读能发

## 一个值得说的设计决定

**被拒的那次，恰恰证明代码是对的。** 我连上 Libera 的 6697，TLS 成功，收到 `Checking Ident → Looking up hostname → No Ident response`，然后被 Closing Link 拒了 —— 原因是这个网络出口**必须用 SASL 认证**。所以我补了三件事：SASL PLAIN、允许自签证书（EFnet 就是自签，那个证书错误其实说明连上了）、以及**限次**自动重连 —— 认证被拒这类问题重连一万次也没用，重试 3 次就停下并说明原因。

## 双向的，不只看

这是这批插件的共同点：**状态在宿主、界面 2 秒轮询**。所以我在面板里点一下，Agent 调工具就能读到；Agent 写一次（比如「帮我记一笔午饭 12.5」），面板自己就变了。

装：

```
# 先装 DSH（桌面版从 https://harness.deepseek.com 下载安装包；只要 CLI 的话）：
npm i -g @deepseek-ai/dsh

# 再装这个插件（桌面版也可以走 GUI：右侧栏「插件 → 添加插件」）
dsh plugin --profile desktop add dsh-irc-dock

# 如果你是开发者、想用本地目录直接挂：
plugin_manager install_bundle target=link:E:\development\dsh-irc-dock
```

代码在 <https://github.com/lemonhall/dsh-irc-dock>，npm 上是 `dsh-irc-dock`。右侧栏点「**+**」→ 选「IRC 客户端」就能看到它。

## 已知限制

- **凭据只从 `$DSH_HOME/dsh-irc-dock/secret.json` 读**（`{saslUser, saslPass}`），绝不进 git
- 不支持 DCC、文件传输、多服务器并发
- 消息不持久化，关掉就没了（这是有意的：聊天记录没必要写盘）
