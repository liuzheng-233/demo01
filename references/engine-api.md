# 引擎 API 参考

三个层次：**规则层**（rules.ts，无依赖）→ **AI 层**（ai.ts + 开局库）→ **房间层**（state.ts，可选）。
所有逻辑都是纯函数 / 不可变更新（`applyMove` 返回新状态，不改原状态），可直接序列化存储。

## 1. 坐标与编码

- 棋盘 10 行 × 9 列：`ROWS=10, COLS=9`，`idx(r,c) = r*9+c`（0..89）
- `row 0` 黑方底线（屏幕顶部），`row 9` 红方底线（屏幕底部）；河界在 row4/row5 之间
- 九宫：红 rows7-9 / cols3-5；黑 rows0-2 / cols3-5
- 红兵过河 = `r <= 4`；黑卒过河 = `r >= 5`
- 格子编码（`Uint8Array(90)`）：
  - `0` 空
  - `1..7` 红方 K(帅) A(仕) B(相) N(马) R(车) C(炮) P(兵)
  - `8..14` 黑方 K(將) A(士) B(象) N(馬) R(車) C(砲/炮) P(卒)
- 辅助：`cellColor(cell) → 'r'|'b'|null`、`cellType(cell) → 'K'..'P'|null`、`cellOf(type,color) → number`
- 颜色：`type Color = 'r' | 'b'`；`opposite(c)`

## 2. GameState / Move / Result

```ts
interface GameState {
  board: Uint8Array         // 90 格
  turn: Color               // 当前行棋方
  halfMoveClock: number     // 无吃子半回合（吃子归零）
  fullMoveNumber: number    // 黑方走完 +1
  seen: Record<string, number> // 局面键出现次数（重复判和）
  result: GameResult | null
}
interface Move { from: Pos; to: Pos } // Pos = { r, c }
interface GameResult { winner: Color | null; reason: GameResultReason }
```

`GameResultReason`：

| reason | 含义 | winner |
|--------|------|--------|
| `CHECKMATE` | 将死（被将军且无合法着法） | 对方 |
| `STALEMATE` | 困毙（未被将军但无合法着法，**中国象棋判负**） | 对方 |
| `DRAW_REPETITION` | 同一局面出现 3 次 | null |
| `DRAW_NATURAL` | 120 半回合无吃子（60 回合自然限着） | null |
| `DRAW_INSUFFICIENT` | 双方无子可胜（无兵无车且马炮合计 ≤1） | null |
| `TIMEOUT` / `RESIGN` / `DRAW_AGREEMENT` | 由房间层产生，规则层不产生 | 房间层填 |

> 简化说明：长将/长捉按重复局面 3 次判和自动处理，与严格竞赛规则「长将判负」有差异。

## 3. rules.ts 核心 API

| API | 说明 |
|-----|------|
| `createInitialState()` | 初始局面（内部走 FEN 解析，会带 `seen` 初始计数与终局判定） |
| `fenToState(fen)` / `stateToFen(state)` | FEN 互通；回合符号沿用 `w`/`b`，内部 Color 为 `r`/`b` |
| `pseudoLegalMoves(state, color)` | 伪合法走法（不校验走后送将），UI/批量分析用 |
| `legalMoves(state, color)` | **合法走法**（单克隆走/回退过滤送将，含飞将）；UI 高亮与 AI 都用它 |
| `isLegalMove(state, move)` | 单步校验，服务端校验玩家提交时用 |
| `applyMove(state, move, opts?)` | 应用走子返回新状态；非法抛异常；自动切换回合/吃子钟/seen/终局 |
| `tryApplyMove(state, move)` | 合法返回新状态，非法返回 `null`（不抛异常版） |
| `isInCheck(state, color)` | 某方帅/将是否被将军 |
| `isSquareAttacked(board, pos, byColor, byKingPos?)` | 格点攻击检测（全兵种，含蹩腿/塞眼/炮架/飞将） |
| `getGameStatus(state, opts?)` | 终局判定（房间层在 applyMove 内已自动调用） |
| `hasInsufficientMaterial(board)` | 无子可胜判定 |
| `findKing(board, color)` | 找帅/将位置 |
| `boardKey(state)` | 局面键（盘面 + turn，不含时钟） |

常量：`INITIAL_FEN`、`NATURAL_DRAW_PLY=120`、`PIECE_TYPE_NAMES`。

### applyMove 的性能开关（只有 AI 搜索该用）

```ts
applyMove(state, move, {
  skipValidation: true, // 跳过合法性重校验（走法已来自 legalMoves）
  skipSeen: true,       // 跳过 seen 复制与重复检测
  skipStatus: true,     // 跳过 getGameStatus（终局由搜索的无着法分支识别）
})
```

房间层 / 根节点 / 业务代码**不要**传这些开关。实测搜索内省掉 `getGameStatus` 提速 2~3 倍。

## 4. ai.ts 核心 API

```ts
type AiLevel = 'easy' | 'medium' | 'hard'

chooseAiMove(state: GameState, level: AiLevel): AiSearchResult | null
// 无合法着法返回 null（此时 state.result 已能判定胜负）

interface AiSearchResult {
  move: Move           // AI 选择的着法
  score: number        // 当前行棋方视角分数（兵≈200 分）
  depth: number        // 实际完成深度；开局库命中为 0
  nodes: number        // 搜索节点数
  elapsedMs: number
  book?: boolean       // 是否来自开局库
}
```

| 档位 | 深度 | 时限 | 行为 |
|------|------|------|------|
| easy | 3（残局最多 +6） | 500ms | 只在**同分等价着法**间随机，不主动让分 |
| medium | 4（残局最多 +6） | 1500ms | 干净搜索 |
| hard | 6（残局最多 +6） | 2500ms | 迭代加深 + 快杀优先 |

导出常量：`AI_LEVELS`（含 name/maxDepth/jitter/timeLimitMs）、`AI_LEVEL_NAMES`（"AI-初级" 等）、`evaluate(state)`（红方视角局面分）、`isLosingCaptureInOpening(state, move)`（开局亏本兑换判定，测试用）。

搜索构成：negamax + alpha-beta + PVS + 静态吃子延伸（quiescence，上限 6 层）+ Zobrist 置换表 + killer moves + MVV-LVA 走法排序 + null-move 剪枝 + 残局自动加深。每次调用内部自建 TT/killer（模块级只有只读 Zobrist 常量表），可并发调用。

## 5. 开局库 API

```ts
lookupBookMove(state): Move | null   // 随机一手棋谱着法
lookupBookMoves(state): Move[]       // 该局面全部棋谱着法（已按 legalMoves 清洗）
BOOK_SIZE                            // 3283（镜像前）
LINE_BOOK_SIZE                       // 6543（左右镜像展开后）
```

未命中返回空，AI 自动回退搜索引擎。棋谱数据在 `openingBookData.ts`，紧凑键 = `turn 字符 + 90 个单字符格子`（字符表 `0123456789abcdef` 对应编码 0..14），着法 `{f,t,w}` 为起止格子下标与权重。

## 6. state.ts 房间状态机（可选层）

纯函数、零 DB 依赖。负责把规则层包装成完整对局：PVP/PVE、本机双人（passAndPlay）、双时钟（局时钟 + 步时钟，任一归零判负）、认输 / 求和 / 悔棋（PVP 需对方同意）、AI 同步应手、`viewFor` 选手/观战视图、history（含每步双方剩余时间，悔棋重放用）。

持久化字段与引擎一一对应（board 转 `number[]`，seen 直接存），你自己的存储层（DB/Redis/内存 Map）负责读写；参考原生产架构：房间层 API 只做 DB 读写，所有逻辑在本模块。

接入要点：

```ts
import { createRoomState, SEAT_RED, SEAT_BLACK } from './engine/state'
// 走子 / AI 应手 / 认输求和悔棋 / 超时扫描 / viewFor 详见文件内 JSDoc
```

时钟是服务端权威：前端只显示；每步走完由服务端用 `turnStartedAt` 结算。超时扫描需要一个定时器周期性调用房间层的超时检测函数。
