---
name: xiangqi-game
description: Build Chinese chess (Xiangqi/象棋) games, engines, or AI bots in TypeScript and React. Use for xiangqi boards, legal moves, checkmate, opening books, PVE or PVP rooms. Not for international chess or Go.
---

# Xiangqi Game Builder

构建中国象棋（象棋/Xiangqi）功能的完整工程包：零依赖规则引擎、三档 AI、《橘中秘》开局库、房间状态机、React 棋盘示例。引擎源码提取自一个线上生产站点并经过大量真人对局修正，**不是玩具实现**。

## 铁律（先读）

1. **直接复用 `engine/`，不要重写规则或搜索算法。** 蹩马腿方向、塞象眼、飞将、炮架、将死/困毙区分、PST 方向、quiescence、TT 绝杀分校正这些点在生产环境都踩过致命 bug，代码注释里保留了完整事故记录。需要功能时先读注释再改。
2. **坐标约定不可更改**：10 行 × 9 列，`row 0 = 黑方底线（顶部）`，`row 9 = 红方底线（底部）`；红方在下方；`index = r * 9 + c`。棋子编码 0 空 / 1-7 红 KABNRCP / 8-14 黑 KABNRCP。
3. **生产环境 AI 必须跑在服务端**（Worker/API route/独立进程）。搜索时限内占满一个 CPU 核（0.5–2.5 秒），放浏览器会卡死 UI。前端只做 `legalMoves` 本地预判高亮，提交后服务端权威裁决。
4. **并发安全**：不要把置换表（TT）、killer 表、开局库以外的任何搜索状态提升为模块级变量。每次 `chooseAiMove` 调用内部自建 TT/killer（引擎已经这么做了）。
5. 棋子/棋盘 UI **零图片素材即可**：SVG 画线 + CSS 圆形棋子（见示例）。不要引入 next/image 实时转码棋子图，会吃满低配服务器 CPU。

## 包内容

| 路径 | 作用 | 依赖 |
|------|------|------|
| `engine/rules.ts` | 规则引擎：棋盘编码、FEN、合法走法、将军/将死/困毙/和棋判定、走子应用 | 无 |
| `engine/ai.ts` | AI：negamax + alpha-beta(PVS) + 迭代加深 + quiescence + Zobrist TT + killer + null-move + 开局库 + 三档难度 | rules, openingBook |
| `engine/openingBook.ts` | 开局库对外入口（薄封装） | xiangqi_opening_book |
| `engine/xiangqi_opening_book.ts` | 棋谱查表 + 左右镜像展开 + 脏着法校验 | rules, openingBookData |
| `engine/openingBookData.ts` | 《橘中秘》棋谱 3283 局面/3581 着法（紧凑编码，约 420KB） | 无 |
| `engine/state.ts` | 房间状态机（可选）：PVP/PVE、双时钟、认输/求和/悔棋、超时判负、观战视图 | rules, ai |
| `examples/react-board.tsx` | 自包含人机对弈 React 组件（内联样式，复制即用） | react |
| `references/engine-api.md` | 规则/AI/房间 API 全量说明 | — |
| `references/ai-tuning.md` | 难度调参、评估表、性能优化事故档案 | — |
| `references/ui-integration.md` | 前后端分工、棋盘交互、音效、动画模式 | — |
| `scripts/selfcheck.mjs` | 零依赖自检（规则断言 + AI 自对弈） | Node ≥ 22.18 |

## 标准工作流

### A. 在已有项目里加象棋能力

1. 整个 `engine/` 目录复制到目标项目（保持文件相对关系；它们用无扩展名 ESM 导入，Next/Vite/webpack/esbuild 均原生支持）。
2. 需要 AI 就四个文件一起复制（rules/ai/openingBook/xiangqi_opening_book/openingBookData），只做规则校验可只复制 `rules.ts`。
3. 跑一次自检确认复制无误：
   ```bash
   node scripts/selfcheck.mjs
   # Node 22.6~22.17：node --experimental-strip-types scripts/selfcheck.mjs
   ```
   应输出 23 项检查全过，且自对弈一局正常终局。
4. 开始集成；API 速查见 `references/engine-api.md`。

### B. 从零做一个能玩的人机对局页

1. 复制 `engine/` 到项目；把 `examples/react-board.tsx` 复制为页面组件，修正其中 `../engine/*` 导入路径。
2. 先在客户端跑通（AI 放 setTimeout 里直接执行），验证交互。
3. 上线前把 `chooseAiMove` 移到服务端 API：前端提交 `{ from, to }` → 服务端 `isLegalMove` 校验 → `applyMove` → PVE 模式再 `chooseAiMove` → 返回新局面。完整模式照抄 `references/ui-integration.md`。
4. 需要计时/悔棋/认输/双人同屏时，引入 `engine/state.ts`（纯函数、零 DB 依赖，持久化由你自己的存储层负责）。

### C. 调棋力 / 改难度

读 `references/ai-tuning.md`。只允许动这几个旋钮：`AI_LEVELS` 的 `maxDepth` 与 `timeLimitMs`、`PIECE_VALUES`、各 PST 表。**不要**恢复 easy 的主动让分机制（代码里 `EASY_SLACK = 0` 有明确教训：棋力弱应由搜索深度体现，不能故意送子）。

## 引擎最小用法

```ts
import { createInitialState, legalMoves, applyMove, isInCheck } from './engine/rules'
import { chooseAiMove } from './engine/ai'

let state = createInitialState()
// 玩家走子：先校验再应用（非法会抛异常，用 tryApplyMove 可拿到 null）
const move = { from: { r: 9, c: 1 }, to: { r: 7, c: 2 } }
state = applyMove(state, move)
// AI 应手（level: 'easy' | 'medium' | 'hard'）
const reply = chooseAiMove(state, 'hard')
if (reply) state = applyMove(state, reply.move)
// 终局在 state.result：{ winner: 'r'|'b'|null, reason: 'CHECKMATE'|... }
```

FEN 与常见实现互通：`stateToFen` / `fenToState`，初始 `rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - 0 1`。

## 易错点（生产事故浓缩，扩展时自查）

- **马腿/象眼方向**：马腿点在「紧邻马、朝目标方向一格」，不是目标一侧。改攻击检测后必须跑 selfcheck。
- **PST 镜像方向是 `红 = r / 黑 = 9-r`**：写反会导致 AI 不推兵、大子不出击，表面现象是「AI 乱走」。
- **AI 搜索内一律 `applyMove(s, m, { skipValidation: true, skipSeen: true, skipStatus: true })`**：终局由 negamax 的「无合法走法」分支识别。搜索树里调 `getGameStatus` 会让性能掉 3 倍以上。
- **绝杀分编码 `INF - ply` 且置换表出入必须 toTT/fromTT 校正**，否则引擎会偏好慢杀甚至主动送子。
- **困毙在中国象棋里判负**（无着可走即负，不像国际象棋判和）；不能吃帅/将（将死即终局）。
- 长将/长捉按「重复局面 3 次判和」简化处理，非严格竞赛规则；需要严格长将判负时另行扩展。
- 开局库权重只表示棋谱次序，**不要按权重选着**；镜像展开是覆盖左路开局的关键。

## 交付前检查

- [ ] `node scripts/selfcheck.mjs` 全过
- [ ] AI 调用在服务端；前端有加载/思考态与失败重试
- [ ] 所有玩家提交的走法经服务端 `isLegalMove` 校验，不信任前端
- [ ] 移动端棋盘用普通 `<img>`/CSS 棋子，避免实时图片转码
- [ ] 若在 Node 直接运行 .ts（非打包器），使用 `scripts/ts-resolve-loader.mjs` 注册钩子
