# memory-system · 记忆系统

给自托管 AI 伴侣用的"她记得什么"。一个 HTTP 服务 + 一个 SQLite 库，不绑定任何聊天端。

```
记忆（五层：fact / episode / lesson / reflection / skill）
情绪（p/a/d 三维 + 标签，带半衰期）
生活（她此刻在干嘛、想不想说话）
表达（从真实对话里采样的语感）
反馈（被纠正 → 那条记忆降权）
人格防线（给人物卡做哈希基线，改了会报警）
```

## 跑起来

```bash
npm install
cp config.example.json config.json    # Windows: copy
node cli.mjs init
node cli.mjs serve                    # http://127.0.0.1:7331
```

完整步骤见仓库根目录的《使用笔记.md》。

## 目录

| 文件 | 作用 |
|---|---|
| `cli.mjs` | 命令行：init / serve / doctor / health / memory / emotion / life / snapshot / verify / eval / maintain / backup |
| `src/db.mjs` | 配置加载（展开 `{dataRoot}`）、SQLite 连接、建表迁移 |
| `src/memory.mjs` | 记忆写入：去重、合并、冲突检测、重要度、实体共现图 |
| `src/scoring.mjs` | 检索打分：语义 / 关键词 / 图 / 重要度 / 新鲜度 加权 |
| `src/recall.mjs` | 把各层拼成注入块（带 `⟦MEM:xxx:v1⟧` 标记，可幂等重入） |
| `src/emotion.mjs` | 情绪状态机（关键词 → 偏移 → 衰减） |
| `src/life.mjs` | 生活状态（活动权重、探索、笔记） |
| `src/expression.mjs` | 语感采样与清洗（去 AI 味、标点节奏） |
| `src/feedback.mjs` | 纠正检测、日检、评估 |
| `src/self.mjs` | 本体身份与"想不想主动说话"的决策 |
| `src/persona-guard.mjs` | 人格文件哈希基线（snapshot / verify） |
| `src/mindsea.mjs` + `mindsea/` | 记忆的三维可视化（vendored，见 `mindsea/VENDOR.md`） |
| `src/transcribe.mjs` | 语音转写（可选，需要 faster-whisper） |

## 配置要点

- `system.dataRoot`：所有数据的根目录。其它地方写 `{dataRoot}` 会自动展开
- `memory.recall.minScore`：召回门槛。返回总是不理想就调低（0.35 开始试）
- `persona.targets`：要守的人格文件路径。留空 = 不守任何人
- 没有 `config.json` 也能跑：按默认值，数据落到 `./data`

## 主要接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 活着没 |
| `POST /inject` | **取注入块**（`{key, query}` → `{text, ids, parts}`） |
| `POST /observe` | 观察一条入站消息（更新情绪/语感/纠错） |
| `POST /memory` | 写一条记忆 |
| `GET /memory/search?q=` | 检索 |
| `GET /memory/list` | 列表 |
| `POST /maintain` | 合并 / 归档 / 清理 |
| `GET /persona/verify` | 人格校验 |
| `POST /self/share` | 主动分享（要先配投递端） |

`key` 只是来源标识（`private:1` / `group:123` / `local:me`），检索是**全库**的 —— 换 key 不会隔离记忆。

## 注意

- 需要 **Node ≥ 22.5**（用内置 `node:sqlite`）
- 没有 embedding 模型会自动降级成关键词检索，能跑但不够聪明
- `data/` 里是你的真实记忆，**千万别提交到 git**（`.gitignore` 已经挡了）
