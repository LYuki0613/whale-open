# whale-chat · 鲸窝

自托管 AI 伴侣的聊天端：**服务端 + 网页 + Electron 桌面壳 + Android WebView**。
同一份数据，三个入口看到的东西一模一样。

## 它是什么

不是"调用 API 聊天的网页"，而是一个**壳 + 记忆胶水**：

- 聊天记录、图片、表情、朋友圈都存本地（`data/db.json` + `data/files/`）
- 每轮对话前，去记忆系统取"相关记忆 + 情绪 + 语感"塞进 prompt
- 每 10 条消息触发一次提炼，把值得记的写回记忆库
- 她不直接调模型 —— 模型在 DeepSeek Harness 那一层

## 跑起来

```bash
npm install
node server.mjs          # http://127.0.0.1:7501
```

依赖只有两个公开包：`js-yaml` 和 DSH 的 `@deepseek-ai/dsh-host-apiproxy`（API 客户端用）。
桌面壳另外需要 `electron`（devDependency）。
完整的配置、接 DSH、接记忆系统，见仓库根目录《使用笔记.md》。

## 特性

- 文字 / 图片 / 动图（自动抽帧成网格给模型看）/ 视频 / 文件
- 表情包（含收藏、发送）
- 朋友圈（发、点赞、评论，她也会自己发）
- 定时消息（她说「明早七点叫我」→ `[[sched:2026-11-12 07:00|...]]`）
- 主动消息：她按自己的节奏找你，也可以选择不说
- 已读不回：`[[沉默]]` 会被服务端过滤，不会变成一条空消息
- 回复节奏：按你打的字数延迟（1 字 1 秒，封顶 8 秒），期间继续发会并成一轮
- 上下文轮换：超过阈值自动换新窗口 + 记忆开场（避免越聊越贵）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHAT_PORT` | `7501` | 端口 |
| `CHAT_DATA` | `./data` | 数据目录 |
| `MEMORY_BASE` | `http://127.0.0.1:7331` | 记忆系统 |
| `CHAT_KEY` | `local:me` | 记忆来源标识 |
| `DIARY_DIR` | `<CHAT_DATA>/diary` | 日记目录 |
| `DSH_PORT` | 自动探测 | DSH API 端口（非 Windows 必须显式给） |
| `CHAT_PRESET` | 空 | DSH agent preset |
| `CHAT_NO_AGENT` | 空 | `1` = 只看界面 |
| `CHAT_BRIDGE_STATE` | 空 | 与别的入口共用 DSH 会话时，指向那边的 `sessions.json` |
| `PYTHON` | `python` | 动图抽帧用（需要 Pillow） |

## 目录

| 路径 | 作用 |
|---|---|
| `server.mjs` | 服务端：HTTP + SSE + 存储 + DSH 桥 + 记忆注入 + 提炼 + 定时 |
| `main.cjs` | Electron 外壳：托盘、通知、原生选文件 |
| `preload.cjs` | 暴露 `whaleNative.notify / pickFiles` |
| `public/` | 网页端（原生 JS，无框架） |
| `vendor/dsh-client.js` | DSH API 客户端（随仓库自带，不依赖外部工程） |
| `tools/gif-grid.py` | 动图抽帧拼网格 |
| `android/` | WebView 壳 + 通知/选文件/前台保活 |

## 踩过的坑（都已在代码里绕过，改的时候别改回去）

1. **不要用 Electron 自带的 Node 跑服务端**：Node 20 没有原生 WebSocket，接不上 DSH 事件流，表现是"她一直不回"
2. **不能用 `node:sqlite`**：所以存储是 JSON（一个人用足够了）
3. **SSE 推消息必须带 `file` 字段**，否则前端拿不到图片 url
4. **手机端口令必须走 cookie**：`<img src>` 发不出自定义 header
5. **选文件不能用 `window focus` 当取消信号**：会抢在 change 之前把结果清空
6. **Android 需要 `FLAG_GRANT_READ_URI_PERMISSION`**，否则 WebView 读不到文件
7. **Windows 通知标题会显示包名**：要设 `AppUserModelId`（本仓库已设）

## Android

```bash
cd android
gradle assembleRelease
```

需要 JDK 17 + SDK 34。**签名密钥仓库里没有**，自己生成并配置（见《使用笔记.md》4.5）。

## 许可

MIT
