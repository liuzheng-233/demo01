/**
 * 中国象棋 AI 引擎（服务端运行，纯函数）
 *
 * 算法：negamax + alpha-beta 剪枝 + 迭代加深 + 走法排序（MVV-LVA 吃子优先）
 * 评估：子力价值 + 位置价值表（兵/马/炮/车），红方视角正分
 * 难度三档：
 *   - easy（初级）：深度 3；走完搜索后在「与最优差距 ≤100 分」的着法里随机取前 3
 *     （2026-10-04 重写：原实现是从「吃子价值排序」前 3 里随机，与搜索无关 ⇒ 反复空挪车、
 *      贪吃送子，被玩家实测吐槽「棋力评测就是扯淡」；
 *      2026-10-04 深夜再把深度 2→3、容差 150→100：depth 2 连「对手下一手吃回」都看不清，
 *      选着观感仍是「乱走」，实测对局（8WB8Y2）黑方第二手就走炮沉底换马）
 *   - medium（中级）：深度 4，干净搜索
 *   - hard（高级）：深度 4-6 迭代加深 + 快杀优先（浅层将死分数更高）
 * 终局：将死/困毙 = ±INF（快杀加分），和棋 = 0
 * 时间限制：迭代加深逐层加深，超时用已完成的最深层结果（自动降级）
 *
 * 开局亏本兑换拦截（2026-10-04 深夜，所有难度生效）：
 *   开局阶段（双方子力 ≥30 且 ≤10 回合）在**根节点**直接剔除「用大子吃对方有保护的小子」
 *   的着法（如第二手炮沉底吃有车/炮保护的马：换回必亏子，但浅层搜索的奇偶震荡会把它排到
 *   第一 —— 实测 medium 10 次采样 5 次选它）。人类棋手的「开局不乱兑子」规则的代码化；
 *   中残局不生效（兑子是正常战术），若开局全部着法都属此类则不过滤（保留可走性）。
 *
 * 开局多样性（2026-10-09，老板反馈「开局频繁瞎走炮、重复乱走」）：
 *   现象：《橘中秘》是单主变棋谱，92.7% 的棋谱局面只有唯一着法，"等概率随机"退化成固定
 *   着法 —— 玩家走「马八进七 / 马二进三 / 相三进五」后 AI 应手实测 40/40 全是同一手炮。
 *   三层修复：① 棋谱分支 ≥3 时仍纯棋谱随机；② 分支不足且在前 2 回合时，用
 *   「合法着法 + 棋谱常识筛选 + 类型配额」自行构造池并**等概率随机**；③ 修炮位置表
 *   （旧的「行6 全 10 分 / 行7 全 0 分」在鼓励炮无脑前拱）。详见 §开局候选池。
 *
 * ⚠️ 修改引擎前必读：「位置表方向」与「初级扰动」两处都有 2026-10-04 的回归测试锁死，
 *    见 ai.test.ts（位置表方向 / easy 不走亏子吃法）。
 */

import {
  type GameState,
  type Move,
  type Color,
  type PieceType,
  legalMoves,
  applyMove,
  opposite,
  cellColor,
  cellType,
  idx,
  CELL_EMPTY,
  ROWS,
  COLS,
  getGameStatus,
  isSquareAttacked,
  isInCheck,
  boardKey,
} from './rules'
import { lookupBookMoves } from './openingBook'

export type AiLevel = 'easy' | 'medium' | 'hard'

export const AI_LEVELS: Record<AiLevel, { name: string; maxDepth: number; jitter: boolean; timeLimitMs: number }> = {
  // easy：2026-10-04 深夜由 depth 2 提到 3、时限 300→500ms。
  // depth 2 连「我吃子 → 对手回吃」的净结果都算不清（叶层评估振荡），
  // 是实测对局里「第二手炮沉底换马」「随手挪边马」观感乱的根源之一。
  // 500ms 在 2 核 ECS 上足够跑完 depth 3（实测本地 <120ms，服务器按 4 倍余量估），
  // 仍远小于并发锁 AI_SEARCH_TIMEOUT_MS=3000 的保护线。
  easy: { name: '初级', maxDepth: 3, jitter: true, timeLimitMs: 500 },
  medium: { name: '中级', maxDepth: 4, jitter: false, timeLimitMs: 1500 },
  // 高级：2026-10-03 由 maxDepth 5 提到 6。此前哈希用字符串（每节点 1.75µs），
  // depth 5 就吃掉 1.3 秒；换 Zobrist 后同样时间少花 80%（实测 824ms / 41 万节点），
  // 省下的预算刚好够多搜一层。2 核 ECS 实测 depth 6 约 1.8s，仍在 3s 并发锁预算内。
  // depth 7 实测跑不完（平均只到 5.2 层就超时），不提。
  hard: { name: '高级', maxDepth: 6, jitter: false, timeLimitMs: 2500 },
}

export const AI_LEVEL_NAMES: Record<AiLevel, string> = {
  easy: 'AI-初级',
  medium: 'AI-中级',
  hard: 'AI-高级',
}

const INF = 1_000_000_000

// 静态吃子延伸（quiescence）递归上限。仅延伸吃子走法，节点受控，避免水平裁剪 / 白送子。
const MAX_QUIESCENCE_DEPTH = 6

// 初级（easy）扰动容许的分数落差（我方视角，单位 ≈ 子力分：兵 200 / 马 400 / 炮 450 / 车 900）。
// 2026-10-09：由 100 收紧到 0 —— 老板明确要求「不要故意让」，初级不再"主动挑次优着法送礼"。
// 现在 jitter 只在**分数完全相同的等价着法**之间随机（换一种走法，但不让分），
// 难度梯度改由搜索深度体现（easy depth 3 / medium 4 / hard 6），棋力是"天然弱"而非"故意输"。
// 若将来要让初级更容易被新手战胜，调低 AI_LEVELS.easy.maxDepth 即可，不要恢复本常量。
const EASY_SLACK = 0

// 根节点「反空挪子」惩罚（2026-10-04 深夜）：
// 走完后若回到**本局已经出现过的局面**（第 2 次重复），给该着法扣分。
// 目的：打散「车/炮来回走同一格」这类等价闲棋（实测对局 5EJ3BV 第 9~10 手红车
// 3,5→1,5→3,5 空挪两步，玩家观感即「乱下」）。分值取 50（≈1/4 兵）：只作等价着法间的
// 择优偏置，绝不会压过真正的战术收益（吃子/得势动辄 200+）；第 3 次重复由判和（0 分）覆盖。
const REPEAT_PENALTY = 50

// ---------------------------------------------------------------------------
// 开局候选池（2026-10-09 修复「开局一直动炮 / 重复乱走」）
// ---------------------------------------------------------------------------
// 背景（实测数据）：《橘中秘》是单主变棋谱，92.7% 的棋谱局面只有唯一着法
// （3283 个棋谱局面里 3044 个只有 1 手），"等概率随机"实际上无分支可选 ——
// 玩家走「马八进七 / 马二进三 / 相三进五」后，AI 应手 40/40 全是同一手炮
// （炮2平5 / 炮8平5），玩家观感就是「开局频繁瞎走炮、重复乱走」。
//
// 解决：把「浅层候选」（gen_book.ts depth≤2 全展开，每局面约 28~30 手）并进池子，
// 但**不按库权重排序**（权重只编码着法类型的粗偏好，照它排必然全是炮），
// 而是用一次浅搜索打分 + 等概率随机：
//   ① 棋谱分支 ≥ BOOK_BRANCH_MIN → 只用棋谱（分支已够多，保持纯棋谱随机，零成本）
//   ② 棋谱分支不足（含 0）→ 池 = 棋谱 ∪ 浅层候选 → 打分后取「与最优差距 ≤ SLACK」的
//     前 TOP 手，等概率随机 ⇒ 既不会只剩炮、也不会走到明显亏子的着法
/** 棋谱分支数达到该值即认为"够随机"，只用棋谱（不付出打分成本） */
const BOOK_BRANCH_MIN = 3
/** 扩池后快速打分的搜索深度（我方 1 步 + 对方 1 步） */
const OPENING_POOL_DEPTH = 2
/**
 * 扩池后的**安全阈值**（不是择优阈值！）：只剔除"明显亏"的着法（低于最优 150 ≈ 3/4 个兵）。
 * ⚠️ 教训：最初这里写成 40（≈1/5 个兵）想"只留等价好棋"，结果适得其反 ——
 * 位置表对同一着法的分差动辄 90~120（推兵 +120 / 炮前进 +60），紧阈值把马、卒、相
 * 这些正常着法全挤出去，池子里只剩位置分最高的炮，实测「兵七进一」后 AI 应手
 * 100% 是炮（40/40）。开局的"多样性"必须靠安全阈值 + 类型均衡实现，不能靠择优。
 */
const OPENING_POOL_SAFE_MARGIN = 150
/**
 * 开局选着的**类型配额**（每种棋子最多保留几手进入随机池）。
 * 为什么需要：炮在开局的活动性最强（能横走 8 格 + 竖走），合法着法里炮的候选数
 * 天然是马/车/相的 5~6 倍；不设配额的话随机池必然被炮占满 —— 实测扩池后开局
 * 应手炮占比一度升到 42%，正是老板抱怨的「开局一直在动炮」。
 * 配额按人类开局习惯定：炮/车/相 1 手，马/兵卒 2 手，仕 1 手，帅 0 手（开局不动帅）。
 */
const OPENING_TYPE_QUOTA: Record<PieceType, number> = { C: 1, N: 2, P: 2, B: 1, R: 1, A: 0, K: 0 }
/**
 * 自行构造开局池的最大回合数（仅当棋谱分支不足时生效）。
 * 取 2 = 双方各 2 手以内（AI 的第 1~2 手）—— 老板反馈的「开局瞎走炮 / 重复乱走」
 * 就集中在这几手；再往后交回搜索引擎（搜索比"随机"强，不该长期压制棋力）。
 * 棋谱分支充足（≥3 手）时不受此限制，任何阶段都按棋谱随机。
 */
const OPENING_POOL_MAX_FULLMOVE = 2

// 开局着法修正分（只用于开局池筛选，**不进搜索评估** —— 不影响中局棋力）
/** 首次出动（马/炮/车 从初始格出发）：鼓励把没动过的子调出来 */
const OPENING_FIRST_DEVELOP = 40
/** 重复动子（同一个子本局已经动过一次又动）：开局最忌讳，也是玩家说的「重复乱走」 */
const OPENING_REPEAT_MOVE = 60
/** 开局前 6 回合，炮/车 一次纵移 ≥3 格（奔袭）扣分 */
const OPENING_DEEP_RAID = 80
/** 开局前 6 回合，炮横移到边线（距中线 ≥3 列）扣分 */
const OPENING_WIDE_CANNON = 50
/** 扩池打分的搜索预算（毫秒）——比正式思考短，开局不值当多花时间 */
const OPENING_POOL_BUDGET_MS = 600

const PIECE_VALUES: Record<PieceType, number> = {
  K: 0,
  A: 120,
  B: 120,
  N: 400,
  C: 450,
  R: 900,
  P: 200,
}

// ---------------------------------------------------------------------------
// 位置价值表（红方视角：行 0 = 红方底线，行 9 = 黑方底线；黑方按行/列镜像）
// 数值参考常见中国象棋开源评估，仅做难度区分用，非最强引擎
// ---------------------------------------------------------------------------

const PAWN_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0], // 行0（黑底线，兵可深入的最远）
  [90, 90, 110, 120, 130, 120, 110, 90, 90],
  [70, 70, 80, 90, 100, 90, 80, 70, 70],
  [50, 50, 60, 70, 70, 70, 60, 50, 50],
  [30, 30, 40, 50, 50, 50, 40, 30, 30],
  [20, 20, 25, 30, 30, 30, 25, 20, 20],
  [10, 10, 10, 10, 15, 10, 10, 10, 10],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const HORSE_TABLE = [
  [4, 8, 16, 12, 4, 12, 16, 8, 4],
  [4, 10, 28, 16, 8, 16, 28, 10, 4],
  [12, 14, 16, 20, 18, 20, 16, 14, 12],
  [8, 24, 18, 24, 20, 24, 18, 24, 8],
  [6, 16, 14, 18, 16, 18, 14, 16, 6],
  [4, 12, 16, 14, 12, 14, 16, 12, 4],
  [2, 6, 8, 6, 10, 6, 8, 6, 2],
  [4, 2, 8, 8, 4, 8, 8, 2, 4],
  [0, 2, 4, 4, 0, 4, 4, 2, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const CANNON_TABLE = [
  [6, 4, 0, 0, 0, 0, 0, 4, 6],
  [2, 2, 0, 0, 0, 0, 0, 2, 2],
  [2, 8, 6, 4, 0, 4, 6, 8, 2],
  [4, 6, 4, 8, 10, 8, 4, 6, 4],
  [4, 4, 6, 8, 8, 8, 6, 4, 4],
  [6, 6, 8, 8, 10, 8, 8, 6, 6],
  // 行6：2026-10-09 由「全列 10」改为「中路略高、边路无价值」。
  // 旧表让红炮从行7 前进到行6 白得 10×6=60 分（黑炮对称），引擎因此**开局无脑前拱炮**
  // （实测「炮2进4 / 炮8进4」被当成好棋）——玩家反馈的「开局频繁瞎走炮」的引擎级根因之一。
  [0, 2, 4, 6, 6, 6, 4, 2, 0],
  // 行7：2026-10-09 由「全列 0」改为「士角炮 8 / 中炮 10 / 原位 0」。
  // 旧的 0 分让「炮二平五」这种公认最好的开局着法在评估里毫无收益（原位和落点同分），
  // 于是任何"挪一下炮"的闲棋都和正经中炮等价。
  [2, 0, 8, 6, 10, 6, 8, 0, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const ROOK_TABLE = [
  [14, 14, 12, 18, 16, 18, 12, 14, 14],
  [16, 20, 18, 24, 26, 24, 18, 20, 16],
  [12, 12, 12, 18, 18, 18, 12, 12, 12],
  [12, 18, 16, 22, 22, 22, 16, 18, 12],
  [12, 14, 12, 18, 18, 18, 12, 14, 12],
  [12, 16, 14, 20, 20, 20, 14, 16, 12],
  [6, 10, 8, 14, 14, 14, 8, 10, 6],
  [4, 8, 6, 14, 12, 14, 6, 8, 4],
  [8, 4, 8, 16, 8, 16, 8, 4, 8],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const ADVISOR_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 3, 0, 0, 0, 0, 0, 3, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const KING_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 3, 0, 3, 0, 0, 0],
  [0, 0, 0, 0, 4, 0, 0, 0, 0],
]

const ELEPHANT_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 2, 0, 0, 0, 2, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const TABLE_BONUS: Record<PieceType, number[][]> = {
  K: KING_TABLE,
  A: ADVISOR_TABLE,
  B: ELEPHANT_TABLE,
  N: HORSE_TABLE,
  R: ROOK_TABLE,
  C: CANNON_TABLE,
  P: PAWN_TABLE,
}

// 位置价值放大系数：相对子力（车 900）增加中局中心/兵形/王的权重，
// 让 AI 不再"只数子力"，会主动出子、控制中心、拒送随手。
const PST_SCALE = {
  K: 8,
  A: 10,
  B: 10,
  N: 6,
  R: 6,
  C: 6,
  P: 6,
}

// ---------------------------------------------------------------------------
// 威胁评估与残局阶段调整
// ---------------------------------------------------------------------------

/** 被攻击且无保护的棋子，罚其子力价值的比例（白送子惩罚） */
const THREAT_PENALTY = 0.25
/** 子力数超过该值不做威胁评估（开局节点省性能，开局由开局库覆盖） */
const THREAT_MAX_PIECES = 24
/** 残局阈值：≤12 子视为残局 */
const ENDGAME_PIECES = 12
/** 中局阈值：≤20 子开始降低位置表权重、提升兵价值 */
const MIDGAME_PIECES = 20
/** 残局时兵（卒）的额外价值：兵到底线/将帅助攻价值大增 */
const ENDGAME_PAWN_BONUS = 120

function countPieces(board: Uint8Array): number {
  let n = 0
  for (let i = 0; i < board.length; i++) if (board[i] !== CELL_EMPTY) n++
  return n
}

/**
 * 攻击覆盖图（伪合法，性能优化版）：color 方所有棋子一步能攻击到的格子。
 * 不生成走法、不验证禁送将（威胁评估无需精确到王安全），纯棋盘扫描，比 legalMoves 快 5-10 倍。
 * 覆盖：马（含蹩腿）/车（射线）/炮（隔一子吃）/兵（过河横走）/帅（邻格）。
 */
function attackMap(state: GameState, color: Color): boolean[] {
  const map = new Array<boolean>(ROWS * COLS).fill(false)
  const board = state.board
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) map[idx(r, c)] = true
  }
  for (let i = 0; i < board.length; i++) {
    const cell = board[i]
    if (cell === CELL_EMPTY || cellColor(cell) !== color) continue
    const type = cellType(cell)!
    const r = Math.floor(i / 9)
    const c = i % 9
    switch (type) {
      case 'N': {
        // 8 个日位 + 蹩腿检查
        const jumps = [
          [-2, -1], [-2, 1], [-1, -2], [-1, 2],
          [1, -2], [1, 2], [2, -1], [2, 1],
        ]
        for (const [dr, dc] of jumps) {
          if (r + dr < 0 || r + dr >= ROWS || c + dc < 0 || c + dc >= COLS) continue
          const leg = Math.abs(dr) === 2 ? board[idx(r + (dr > 0 ? 1 : -1), c)] : board[idx(r, c + (dc > 0 ? 1 : -1))]
          if (leg !== CELL_EMPTY) continue
          mark(r + dr, c + dc)
        }
        break
      }
      case 'R': {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nr = r + dr
          let nc = c + dc
          while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
            mark(nr, nc)
            if (board[idx(nr, nc)] !== CELL_EMPTY) break // 遇子停（含吃子位）
            nr += dr
            nc += dc
          }
        }
        break
      }
      case 'C': {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nr = r + dr
          let nc = c + dc
          let jumped = false
          while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
            if (!jumped) {
              if (board[idx(nr, nc)] !== CELL_EMPTY) jumped = true // 第一个子只作炮架，不吃不越
              else mark(nr, nc)
            } else {
              mark(nr, nc)
              if (board[idx(nr, nc)] !== CELL_EMPTY) break // 隔一子吃，吃后停
            }
            nr += dr
            nc += dc
          }
        }
        break
      }
      case 'P': {
        // 红兵向前（r 减），过河（r<=4）后可横；黑卒镜像
        if (color === 'r') {
          mark(r - 1, c)
          if (r <= 4) {
            mark(r, c - 1)
            mark(r, c + 1)
          }
        } else {
          mark(r + 1, c)
          if (r >= 5) {
            mark(r, c - 1)
            mark(r, c + 1)
          }
        }
        break
      }
      case 'K': {
        mark(r - 1, c)
        mark(r + 1, c)
        mark(r, c - 1)
        mark(r, c + 1)
        break
      }
      // A(仕/士) B(相/象)：攻击受限且极少吃大子，不参与威胁评估（省成本）
    }
  }
  return map
}

/**
 * 位置表索引（2026-10-04 修正方向）。
 *
 * 各 PST 表都是**按红方真实行号**编写的：行 0 = 黑方底线（红兵推进的最远处），行 9 = 红方底线。
 * 证据：PAWN_TABLE 行 0 自带注释「行0（黑底线，兵可深入的最远）」；KING_TABLE 的非零值（3 / 4）
 * 落在行 8、行 9 —— 正是己方九宫最后两排；(9,4)=4 是帅最稳的底线中心。
 *
 * ⚠️ 历史 bug：原实现是 `红 = 9-r / 黑 = r`，即**把上下镜像加在了红方身上**，导致红方读到的
 * 是一张颠倒的表（黑方反而读到正表）：
 *   ① 红兵每前进一步自身评估 −120 分 ⇒ 红方全程不肯推兵（实测 兵五进一 使红方评估 -120）；
 *   ② 红帅位置项恒为 0（九宫坐标全落在表的零区）⇒ 帅的安全完全没有评估；
 *   ③ 红车在自家二路拿最高分（26）而敌阵二路只有 16 ⇒ 大子不愿出击。
 *   外部表现正是「AI 不推兵、反复动炮/空挪子、像乱走」——玩家实测反馈的主因。
 *   修正为 `红 = r / 黑 = 9-r` 后所有表回到作者本意：己方后三排 0 分（原地不动不奖励）、
 *   越推进分越高、底线兵 0 分（只能横走，本就近乎废子）。
 */
function viewRow(r: number, color: Color): number {
  return color === 'r' ? r : ROWS - 1 - r
}
function viewCol(c: number, color: Color): number {
  return color === 'r' ? c : COLS - 1 - c
}

// ---------------------------------------------------------------------------
// 开局亏本兑换拦截（2026-10-04 深夜）
// ---------------------------------------------------------------------------

/** 开局阶段判定：双方子力 ≥30（至多 2 个子已交换/掉落）且 ≤10 回合 */
function isOpeningPhase(state: GameState): boolean {
  return countPieces(state.board) >= 30 && state.fullMoveNumber <= 10
}

/**
 * 是否「开局亏本兑换」：用价值高的子，去吃一个**走后会被对方回吃**的价值低的子。
 * 例：第二手炮沉底吃有车/炮保护的马（+400 收进、-450 交出，净亏 50，但浅层搜索的
 * 奇偶层震荡会把它排到第一 —— 实测 medium 10 次采样 5 次选它，观感即「乱走送子」）。
 * 只拦「吃了必被回吃且净亏」的：白吃（目标无保护）与等价/赚价兑换不拦。
 * （export 仅供回归测试直接断言；业务代码请走 rootCandidateMoves。）
 */
export function isLosingCaptureInOpening(state: GameState, m: Move): boolean {
  const target = state.board[idx(m.to.r, m.to.c)]
  if (target === CELL_EMPTY) return false
  const mover = state.board[idx(m.from.r, m.from.c)]
  const gain = PIECE_VALUES[cellType(target)!]
  const cost = PIECE_VALUES[cellType(mover)!]
  if (gain >= cost) return false // 吃大子 / 等价兑换：不拦
  const next = applyMove(state, m, { skipValidation: true, skipSeen: true, skipStatus: true })
  // 落点被对方攻击 ⇒ 必被回吃（近似 SEE：不递归算多子回收，开局阶段够用且成本极低）
  return isSquareAttacked(next.board, m.to, opposite(state.turn))
}

/** 根节点候选走法：开局阶段剔除亏本兑换（若剔除后为空则保留原列表） */
function rootCandidateMoves(state: GameState, moves: Move[]): Move[] {
  if (!isOpeningPhase(state)) return moves
  const filtered = moves.filter((m) => !isLosingCaptureInOpening(state, m))
  return filtered.length > 0 ? filtered : moves
}

/**
 * 开局候选池：棋谱着法 ∪「引擎合法着法里符合开局常识的着法」
 * （去重 + 剔除开局亏本兑换 + 剔除会走进重复局面的着法）。
 *
 * ⚠️ 为什么池子要用 legalMoves 而不是库里的浅层数据：见 xiangqi_opening_book.ts
 * §为什么不再用浅层全展开库（浅层候选 29 手里炮 24 手、马 0 手，做池子必然只剩炮）。
 */
function openingCandidatePool(state: GameState, legal: Move[]): { line: Move[]; pool: Move[] } {
  const line = lookupBookMoves(state)
  const pool: Move[] = []
  const push = (m: Move) => {
    if (!pool.some((x) => sameMove(x, m))) pool.push(m)
  }
  for (const m of line) push(m)
  for (const m of legal) push(m)
  // 过滤 ①：开局亏本兑换（用大子吃有保护的小子）；全被拦则不过滤，保留可走性
  let filtered = pool.filter((m) => !isLosingCaptureInOpening(state, m))
  if (filtered.length === 0) filtered = pool
  // 过滤 ②：走完后若局面在本局已出现过 2 次（再走即第 3 次判和）则剔除
  const noRepeat = filtered.filter((m) => {
    const nx = applyMove(state, m, { skipValidation: true, skipSeen: false })
    return !nx.result && (nx.seen[boardKey(nx)] ?? 0) < 2
  })
  return { line, pool: noRepeat.length > 0 ? noRepeat : filtered }
}

/**
 * 开局池打分：对每个候选做一次浅搜索（我方 1 步 + 对方 1 步），返回其真实分数。
 * 用于把「浅层候选」里的废棋筛掉，只留下与最优着法差距 ≤ OPENING_POOL_SLACK 的手。
 */
function scoreOpeningPool(
  state: GameState,
  moves: Move[],
  budgetMs: number,
): { list: { m: Move; s: number }[]; nodes: number } {
  const tt = makeTT()
  const killers = makeKillers()
  const deadlineMs = Date.now() + budgetMs
  const out: { m: Move; s: number }[] = []
  let nodes = 0
  for (const m of moves) {
    const next = applyMove(state, m, { skipValidation: true, skipSeen: false })
    if (next.result) {
      // 直接终局（将死/困毙/和棋）：按胜负给分，肯定优选
      const w = next.result.winner
      out.push({ m, s: w === null ? 0 : w === state.turn ? INF - 1 : -INF + 1 })
      continue
    }
    try {
      const [ns, nnc] = negamax(
        next,
        opposite(state.turn),
        OPENING_POOL_DEPTH - 1,
        -INF,
        INF,
        killers,
        0,
        deadlineMs,
        tt,
        () => false,
        1,
      )
      nodes += nnc
      let s = -ns + openingMoveBonus(state, m)
      // 与主循环一致：走进重复局面（第 2 次）轻微减分
      if ((next.seen[boardKey(next)] ?? 0) >= 2) s -= REPEAT_PENALTY
      out.push({ m, s })
    } catch (e) {
      if (e !== SEARCH_TIMEOUT) throw e
      break // 超时：用已打完分的候选（开局不值得为完整打分拖延）
    }
  }
  return { list: out, nodes }
}

/** 走法键（from->to），用于去重/集合判定 */
function moveKey(m: Move): string {
  return `${m.from.r},${m.from.c}->${m.to.r},${m.to.c}`
}

/** 棋子初始格判定（用于「首次出动 / 重复动子」） */
const INIT_SQUARES: { type: PieceType; color: Color; r: number; c: number }[] = (() => {
  const out: { type: PieceType; color: Color; r: number; c: number }[] = []
  const add = (type: PieceType, color: Color, r: number, cs: number[]) => {
    for (const c of cs) out.push({ type, color, r, c })
  }
  for (const [color, back] of [
    ['r', 9],
    ['b', 0],
  ] as [Color, number][]) {
    add('R', color, back, [0, 8])
    add('N', color, back, [1, 7])
    add('B', color, back, [2, 6])
    add('A', color, back, [3, 5])
    add('K', color, back, [4])
  }
  add('C', 'r', 7, [1, 7])
  add('C', 'b', 2, [1, 7])
  add('P', 'r', 6, [0, 2, 4, 6, 8])
  add('P', 'b', 3, [0, 2, 4, 6, 8])
  return out
})()

function isInitialSquare(type: PieceType, color: Color, r: number, c: number): boolean {
  return INIT_SQUARES.some((s) => s.type === type && s.color === color && s.r === r && s.c === c)
}

/**
 * 开局着法修正分（只用于开局池打分，不进 evaluate/搜索）。
 * 把「人类开局常识」低成本地代码化，专门压制浅层候选里的闲棋：
 *   ① 首次出动加分 / 重复动子扣分（老板反馈的「重复乱走」）；
 *   ② 开局不后退；
 *   ③ 前 6 回合炮/车不奔袭、炮不摆边线（老板反馈的「开局频繁瞎走炮」）。
 */
function openingMoveBonus(state: GameState, m: Move): number {
  const cell = state.board[idx(m.from.r, m.from.c)]
  const type = cellType(cell)!
  const color = cellColor(cell)!
  let b = 0
  if (type === 'N' || type === 'C' || type === 'R') {
    if (isInitialSquare(type, color, m.from.r, m.from.c)) b += OPENING_FIRST_DEVELOP
    else b -= OPENING_REPEAT_MOVE
    const forward = color === 'r' ? -1 : 1
    const dr = m.to.r - m.from.r
    if (dr * forward < 0) b -= 60 // 后退
    if (state.fullMoveNumber <= 6) {
      if (Math.abs(dr) >= 3) b -= OPENING_DEEP_RAID
      if (type === 'C' && Math.abs(m.to.c - 4) >= 3) b -= OPENING_WIDE_CANNON
    }
  }
  // 开局最前几手：相/象应飞中象（落点中路）护住中卒，别飞边象（观感像乱走）
  if (type === 'B' && state.fullMoveNumber <= OPENING_POOL_MAX_FULLMOVE && m.to.c !== 4) b -= 100
  return b
}

/**
 * 开局选着：棋谱优先 + 池内等概率随机。返回 null = 库未覆盖，交回常规搜索。
 *   ① 棋谱分支 ≥ BOOK_BRANCH_MIN：纯棋谱随机（零搜索成本，保持「随机按棋谱走」）
 *   ② 棋谱分支不足（含 0，如玩家走「兵七进一 / 马八进七」）：扩池打分 + 类型均衡后随机
 * 详见文件头 §开局候选池。
 */
function chooseOpeningMove(state: GameState, legal: Move[]): AiSearchResult | null {
  const { line, pool } = openingCandidatePool(state, legal)
  if (pool.length === 0) return null
  // ① 棋谱分支充足：纯棋谱随机（零搜索成本，保持「随机按棋谱走」；任何阶段都适用）
  if (line.length >= BOOK_BRANCH_MIN) {
    const m = line[Math.floor(Math.random() * line.length)]
    return { move: m, score: 0, depth: 0, nodes: 0, elapsedMs: 0, book: true }
  }
  // ② 棋谱分支不足：只有**开局最前几手**才自行构造多样性池，其余一律交回搜索（搜索更强）
  if (!isOpeningPhase(state) || state.fullMoveNumber > OPENING_POOL_MAX_FULLMOVE) return null
  if (pool.length === 1) {
    return { move: pool[0], score: 0, depth: 0, nodes: 0, elapsedMs: 0, book: true }
  }
  const start = Date.now()
  const { list, nodes } = scoreOpeningPool(state, pool, OPENING_POOL_BUDGET_MS)
  if (list.length === 0) return null
  list.sort((a, b) => b.s - a.s)
  const best = list[0].s
  // 安全阈值：只剔除明显亏的着法（详见 OPENING_POOL_SAFE_MARGIN 的教训注释）
  const safe = list.filter((x) => x.s >= best - OPENING_POOL_SAFE_MARGIN)
  // 类型配额：见 OPENING_TYPE_QUOTA 注释。棋谱着法不受配额限制，永远保留。
  const lineKeys = new Set(line.map(moveKey))
  const perType = new Map<PieceType, number>()
  const balanced: { m: Move; s: number }[] = []
  for (const x of safe) {
    if (lineKeys.has(moveKey(x.m))) {
      balanced.push(x)
      continue
    }
    const t = cellType(state.board[idx(x.m.from.r, x.m.from.c)])!
    const used = perType.get(t) ?? 0
    if (used >= (OPENING_TYPE_QUOTA[t] ?? 0)) continue
    perType.set(t, used + 1)
    balanced.push(x)
  }
  const finalPool = balanced.length > 0 ? balanced : safe
  const chosen = finalPool[Math.floor(Math.random() * finalPool.length)].m
  return {
    move: chosen,
    score: best,
    depth: OPENING_POOL_DEPTH,
    nodes,
    elapsedMs: Date.now() - start,
    book: true,
  }
}

/** 局面评估（红方视角正分，单位约等于子力分）
 * 组成：子力基础分 + 位置表分（按阶段缩放） + 残局兵价值提升 + 中残局威胁修正
 */
export function evaluate(state: GameState): number {
  let score = 0
  const board = state.board
  const pieceCount = countPieces(board)
  // 阶段缩放：子力越少，位置表权重越低（残局棋子位置价值让位于子力推进），兵价值越高
  let pstFactor = 1
  let pawnBonus = 0
  if (pieceCount <= ENDGAME_PIECES) {
    pstFactor = 0.5
    pawnBonus = ENDGAME_PAWN_BONUS
  } else if (pieceCount <= MIDGAME_PIECES) {
    pstFactor = 0.8
  }
  for (let i = 0; i < board.length; i++) {
    const cell = board[i]
    if (cell === CELL_EMPTY) continue
    const color = cellColor(cell)!
    const type = cellType(cell)!
    const r = Math.floor(i / 9)
    const c = i % 9
    const vr = viewRow(r, color)
    const vc = viewCol(c, color)
    const bonus = TABLE_BONUS[type]?.[vr]?.[vc] ?? 0
    const v = PIECE_VALUES[type] + (type === 'P' ? pawnBonus : 0) + bonus * (PST_SCALE[type] ?? 1) * pstFactor
    score += color === 'r' ? v : -v
  }
  // 威胁修正（中残局启用）：被攻击且无保护的子罚子力分，让 AI 不把大子往对方嘴边送
  if (pieceCount <= THREAT_MAX_PIECES) {
    const redAtt = attackMap(state, 'r')
    const blackAtt = attackMap(state, 'b')
    for (let i = 0; i < board.length; i++) {
      const cell = board[i]
      if (cell === CELL_EMPTY) continue
      const color = cellColor(cell)!
      const protectedByOwn = color === 'r' ? redAtt[i] : blackAtt[i]
      const attackedByEnemy = color === 'r' ? blackAtt[i] : redAtt[i]
      if (attackedByEnemy && !protectedByOwn) {
        const v = PIECE_VALUES[cellType(cell)!] + (cellType(cell)! === 'P' ? pawnBonus : 0)
        score += (color === 'r' ? -1 : 1) * v * THREAT_PENALTY
      }
    }
  }
  return score
}

// ---------------------------------------------------------------------------
// 置换表（Transposition Table）：按 (turn, board) 哈希暂存已搜节点，避免同局面重复计算。
// ⚠️ 必须在 chooseAiMove 内部构造，禁止模块级变量（并发请求会互相污染）。
// ---------------------------------------------------------------------------
type TTFlag = 'EXACT' | 'LOWER' | 'UPPER'
interface TTEntry {
  depth: number
  score: number
  flag: TTFlag
  /** 该节点上次搜索得到的最佳着法（用于「置换表着法优先」排序，大幅提升剪枝效率） */
  move?: Move
}

// Zobrist 哈希表：90 格 × 15 种棋子 + 1 个行棋方位。
// 为什么弃用字符串哈希（2026-10-03）：旧实现每节点拼接 91 字符再做 Map<string> 查找，
// 微基准实测单节点哈希成本 1.75µs（字符串计算 1.72µs + Map 查找 0.03µs），
// 而数值版只要 0.16µs —— 11.7 倍差距。旧实现下 depth-5 搜索 45 万节点的耗时
// 有八成花在拼字符串上，等于白白浪费思考时间。换成 Zobrist 后同样的时间预算能多搜一层。
// 用两张表各取 32 位，组合成 52 位安全整数（< 2^53，double 精确表示）作为 Map 键。
const ZOB_A = new Int32Array(15 * 90 + 1)
const ZOB_B = new Int32Array(15 * 90 + 1)
;(() => {
  // 确定性 xorshift32 —— 固定种子保证每次构建的表一致（同局面同哈希，便于调试与测试）
  let x = 0x9e3779b9 | 0
  const next = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x | 0
  }
  for (let i = 0; i < ZOB_A.length; i++) {
    ZOB_A[i] = next()
    ZOB_B[i] = next()
  }
})()
const Z_TURN = 15 * 90

/**
 * 局面哈希：返回 52 位整数（棋盘 + 行棋方）。
 * 52 位空间下 45 万节点的碰撞期望约 4e-5，可忽略；TT 命中还要满足 depth >= 当前深度。
 */
function hashState(state: GameState): number {
  const b = state.board
  let h1 = 0
  let h2 = 0
  for (let i = 0; i < 90; i++) {
    const c = b[i]
    if (c !== 0) {
      const k = c * 90 + i
      h1 ^= ZOB_A[k]
      h2 ^= ZOB_B[k]
    }
  }
  if (state.turn === 'b') {
    h1 ^= ZOB_A[Z_TURN]
    h2 ^= ZOB_B[Z_TURN]
  }
  return (h1 >>> 0) * 1048576 + (h2 >>> 12)
}

// 256K entries。数值键每条约 100 字节 ≈ 26MB，2G ECS 可承受；
// 旧的 1M 条字符串键（每条 ~300 字节）才是 OOM 元凶，不能退回那个量级。
const TT_SIZE = 1 << 18
function makeTT(): Map<number, TTEntry> {
  return new Map<number, TTEntry>()
}
function ttGet(tt: Map<number, TTEntry>, h: number): TTEntry | undefined {
  return tt.get(h)
}
function ttPut(tt: Map<number, TTEntry>, h: number, d: number, s: number, f: TTFlag, move?: Move): void {
  const existing = tt.get(h)
  // 新条目 或 同 key 更深的记录：写入（更深结果更可靠）
  if (!existing || existing.depth <= d) {
    // 表满时：未命中才触发淘汰（已命中直接覆盖同 key）
    if (tt.size >= TT_SIZE && !existing) {
      const firstKey = tt.keys().next().value as number
      tt.delete(firstKey)
    }
    tt.set(h, { depth: d, score: s, flag: f, move: move ?? existing?.move })
  }
}

// --- 绝杀分的置换表校正（2026-10-03）---
// 绝杀分编码为 INF - ply（距根步数），这个值**依赖调用它的 ply**。置换表按局面哈希存取，
// 同一个局面可能在完全不同的 ply 被访问到。若不校正，把「ply=2 时的绝杀分」原样存进表、
// 再到 ply=6 读出来，引擎就会把「2 步杀」误当「6 步杀」，进而**优先选择更慢的杀法、
// 甚至为了一个虚假的『更快杀』主动送掉大子**（本文件 §修复记录 2026-10-03 记录的挂车事故）。
// 标准做法：入表时剥掉 ply 分量（存成与 ply 无关的值），出表时再加回当前 ply。
const MATE_BAND = INF - 1000 // |score| 达到此量级即视为绝杀分
function toTT(score: number, ply: number): number {
  if (score >= MATE_BAND) return score + ply
  if (score <= -MATE_BAND) return score - ply
  return score
}
function fromTT(score: number, ply: number): number {
  if (score >= MATE_BAND) return score - ply
  if (score <= -MATE_BAND) return score + ply
  return score
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/** 走法排序分：吃子按 MVV-LVA（吃价值大的子优先，用小子吃大子） */
function moveOrderScore(state: GameState, m: Move): number {
  const target = state.board[idx(m.to.r, m.to.c)]
  if (target === CELL_EMPTY) return 0
  const src = state.board[idx(m.from.r, m.from.c)]
  return PIECE_VALUES[cellType(target)!] * 10 - PIECE_VALUES[cellType(src)!]
}

/**
 * 杀手走法（killer moves）：同级剪枝走法，排序时优先，减少搜索节点。
 * ⚠️ 必须在 chooseAiMove 内部构造，禁止模块级变量（并发请求会互相污染）。
 */
function makeKillers(): Move[][] {
  return []
}

function resetKillers(killers: Move[][]): void {
  killers.length = 0
}

function getKillers(killers: Move[][], depth: number): Move[] {
  return killers[depth] ?? []
}

function recordKiller(killers: Move[][], m: Move, depth: number): void {
  let arr = killers[depth]
  if (!arr) {
    killers[depth] = arr = []
  }
  const same = arr.find((k) => k.from.r === m.from.r && k.from.c === m.from.c && k.to.r === m.to.r && k.to.c === m.to.c)
  if (same) return
  arr.unshift(m)
  if (arr.length > 2) arr.length = 2
}

function isKiller(m: Move, killers: Move[]): boolean {
  return killers.some((k) => k.from.r === m.from.r && k.from.c === m.from.c && k.to.r === m.to.r && k.to.c === m.to.c)
}

/** 两个着法是否相同（同起点同终点） */
function sameMove(a: Move, b: Move): boolean {
  return a.from.r === b.from.r && a.from.c === b.from.c && a.to.r === b.to.r && a.to.c === b.to.c
}

/**
 * 走法排序。优先级：置换表/PV 着法 (1e9) > 杀手着法 (5e5) > MVV-LVA 吃子。
 *
 * ⚠️ 2026-10-04 深夜新增 `first`：此前根节点每层都用 MVV-LVA 重排、内部也从不把
 * 置换表里的着法放最前 —— alpha-beta 最忌讳「最可能最好的着法排在后面」。实测
 * 20~26 子的开阔中局里 depth 4 要 1500ms+ 才跑完，逼得 medium 掉回 depth 3，
 * 表现为「脱谱后越下越乱」。把上次迭代/置换表的最优着法排到最前，同样的时限能多搜一层。
 */
function orderMoves(state: GameState, moves: Move[], killers: Move[][], depth?: number, first?: Move): Move[] {
  const depthKillers = depth !== undefined ? getKillers(killers, depth) : []
  return moves
    .map((m) => ({
      m,
      s:
        moveOrderScore(state, m) +
        (first && sameMove(m, first) ? 1_000_000_000 : 0) +
        (depthKillers.length && isKiller(m, depthKillers) ? 500_000 : 0),
    }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m)
}

const SEARCH_TIMEOUT = Symbol('search-timeout')

/** 搜索超时检查（每 2048 节点一次，成本可忽略） */
function checkTimeout(nodeCounter: number, deadlineMs: number): void {
  if ((nodeCounter & 2047) === 0 && Date.now() > deadlineMs) {
    throw SEARCH_TIMEOUT
  }
}

/**
 * negamax + alpha-beta + PVS + TT + null-move。color = 当前行棋方（negamax 视角）。
 * 返回 color 视角的分数。
 * 性能要点：直接用 applyMove 已算好的 state.result（不重复调 getGameStatus）；
 * 无合法走法 = 将死或困毙（中国象棋规则均判负），无需区分。
 * TT 参数：查 / 写入同状态表，depth ≥ stored 时才覆盖。
 */
function negamax(
  state: GameState,
  color: Color,
  depth: number,
  alpha: number,
  beta: number,
  killers: Move[][],
  nodeCounter: number,
  deadlineMs: number,
  tt: Map<number, TTEntry>,
  isKillerMove: (m: Move) => boolean,
  ply: number,
): [number, number] {
  nodeCounter++
  checkTimeout(nodeCounter, deadlineMs)
  const status = state.result
  if (status) {
    if (status.winner === null) return [0, nodeCounter] // 和棋
    // 绝杀分必须编码「距根步数 ply」，不能编码剩余深度 depth —— 见文件头 §修复记录 2026-10-03
    return [status.winner === color ? INF - ply : -INF + ply, nodeCounter]
  }
  if (depth <= 0) {
    return quiescence(state, color, alpha, beta, MAX_QUIESCENCE_DEPTH, killers, nodeCounter, deadlineMs, tt, ply)
  }

  // === TT 命中：只返回 EXACT / LOWER（>= beta）/ UPPER（<= alpha）===
  const h = hashState(state)
  const hit = ttGet(tt, h)
  if (hit && hit.depth >= depth) {
    const hs = fromTT(hit.score, ply)
    if (hit.flag === 'EXACT') return [hs, nodeCounter]
    if (hit.flag === 'LOWER' && hs >= beta) return [hs, nodeCounter]
    if (hit.flag === 'UPPER' && hs <= alpha) return [hs, nodeCounter]
  }

  // === null-move（不走路，把回合让给对方）===
  // 前提：非将军、非只剩王（残局 null-move 无效）。
  // null-move 收益：让对方先走但自己不退让，快速剪枝。
  let nullScore: number | undefined = undefined
  if (depth >= 3) {
    const pc = countPieces(state.board)
    if (pc > 4) {
      const nullNext: GameState = {
        board: state.board.slice(),
        turn: opposite(state.turn),
        halfMoveClock: state.halfMoveClock + 1,
        fullMoveNumber: state.fullMoveNumber + (state.turn === 'b' ? 1 : 0),
        seen: { ...state.seen },
        result: null,
      }
      nullNext.result = getGameStatus(nullNext, { skipSeen: true })
      if (!nullNext.result) {
        // 递归：对手视角搜索 depth-2（null-move 消耗 1 层 + 对手必须应答 1 层）
        const [ns, nnc] = negamax(nullNext, opposite(state.turn), depth - 2, -beta, -alpha, killers, nodeCounter, deadlineMs, tt, isKillerMove, ply + 1)
        nullScore = -ns
        nodeCounter = nnc
        if (nullScore >= beta) {
          // null-move 剪枝：对手能赢我（即我方 null 后被反杀）→ 本节点分数 >= beta，return
          ttPut(tt, h, depth, toTT(beta, ply), 'LOWER')
          return [beta, nodeCounter]
        }
        if (nullScore > alpha) alpha = nullScore
      }
    }
  }

  // 置换表着法优先：上次在这个局面搜出的最佳着法排最前（剪枝效率关键）
  const moves = orderMoves(state, legalMoves(state, color), killers, depth, hit?.move)
  if (moves.length === 0) {
    // 将死或困毙均判负（中国象棋规则）
    ttPut(tt, h, depth, toTT(-INF + ply, ply), 'UPPER')
    return [-INF + ply, nodeCounter]
  }

  let best = -INF
  let bestMove: Move | undefined
  let first = true
  for (const m of moves) {
    const next = applyMove(state, m, { skipValidation: true, skipSeen: true, skipStatus: true })
    let score: number
    if (first) {
      const [s0, nc0] = negamax(next, opposite(color), depth - 1, -beta, -alpha, killers, nodeCounter, deadlineMs, tt, isKillerMove, ply + 1)
      score = -s0
      nodeCounter = nc0
      first = false
    } else {
      const [s1, nc1] = negamax(next, opposite(color), depth - 1, -alpha - 1, -alpha, killers, nodeCounter, deadlineMs, tt, isKillerMove, ply + 1)
      score = -s1
      nodeCounter = nc1
      if (score > alpha && score < beta) {
        const [s2, nc2] = negamax(next, opposite(color), depth - 1, -beta, -alpha, killers, nodeCounter, deadlineMs, tt, isKillerMove, ply + 1)
        score = -s2
        nodeCounter = nc2
      }
    }
    if (score > best) {
      best = score
      bestMove = m
    }
    if (best > alpha) alpha = best
    if (alpha >= beta) {
      recordKiller(killers, m, depth)
      ttPut(tt, h, depth, toTT(beta, ply), 'LOWER', m)
      break
    }
  }

  const flag: TTFlag = best <= alpha ? 'UPPER' : best >= beta ? 'LOWER' : 'EXACT'
  ttPut(tt, h, depth, toTT(best, ply), flag, bestMove)
  return [best, nodeCounter]
}

/**
 * 静态吃子延伸：只搜索吃子走法，消除水平裁剪效应（叶节点被吃子价值蒙骗）。
 * 返回 color（当前行棋方）视角分数。任一节点先取静态评估作下界（stand-pat），
 * 再枚举吃子走法看能否改善；无吃子或达到层数上限即返回。MVV-LVA 排序剪枝高效。
 */
function quiescence(
  state: GameState,
  color: Color,
  alpha: number,
  beta: number,
  qDepth: number,
  killers: Move[][],
  nodeCounter: number,
  deadlineMs: number,
  tt: Map<number, TTEntry>,
  ply: number,
): [number, number] {
  nodeCounter++
  checkTimeout(nodeCounter, deadlineMs)

  const status = state.result
  if (status) {
    if (status.winner === null) return [0, nodeCounter]
    return [status.winner === color ? INF - ply : -INF + ply, nodeCounter]
  }

  // skipStatus 后搜索内部不再判终局（见 rules.applyMove）：这里补「被将军且无解」的将死检测，
  // 否则视界处的将死局面会被 stand-pat 当普通局面打分 ⇒ 引擎漏杀 / 走出送杀。仅在被将时多跑
  // 一次 legalMoves（概率低），非被将局面直接跳过（省成本）。
  if (isInCheck(state, color) && legalMoves(state, color).length === 0) {
    return [-INF + ply, nodeCounter]
  }

  const h = hashState(state)
  // TT 命中（仅 EXACT 或 LOWER 可当 beta 截断）
  const hit = ttGet(tt, h)
  if (hit && hit.depth >= qDepth) {
    const hs = fromTT(hit.score, ply)
    if (hit.flag === 'EXACT') return [hs, nodeCounter]
    if (hit.flag === 'LOWER' && hs >= beta) return [hs, nodeCounter]
  }

  const e = evaluate(state)
  const standPat = color === 'r' ? e : -e
  if (standPat >= beta) {
    ttPut(tt, h, qDepth, toTT(beta, ply), 'LOWER')
    return [beta, nodeCounter]
  }
  if (standPat > alpha) alpha = standPat

  // 只延伸吃子走法
  const captures = legalMoves(state, color).filter((m) => state.board[idx(m.to.r, m.to.c)] !== CELL_EMPTY)
  if (captures.length === 0 || qDepth <= 0) return [standPat, nodeCounter]

  let best = standPat
  let bestMove: Move | undefined
  let score: number
  for (const m of orderMoves(state, captures, killers, undefined, hit?.move)) {
    const next = applyMove(state, m, { skipValidation: true, skipSeen: true, skipStatus: true })
    const [qs, qnc] = quiescence(next, opposite(color), -beta, -alpha, qDepth - 1, killers, nodeCounter, deadlineMs, tt, ply + 1)
    score = -qs
    nodeCounter = qnc
    if (score > best) {
      best = score
      bestMove = m
    }
    if (best > alpha) alpha = best
    if (alpha >= beta) {
      ttPut(tt, h, qDepth, toTT(beta, ply), 'LOWER', m)
      break
    }
  }
  const flag: TTFlag = best >= beta ? 'LOWER' : best <= alpha ? 'UPPER' : 'EXACT'
  ttPut(tt, h, qDepth, toTT(best, ply), flag, bestMove)
  return [best, nodeCounter]
}

export interface AiSearchResult {
  move: Move
  score: number // 当前行棋方视角
  depth: number // 实际完成的搜索深度（开局库命中为 0）
  nodes: number
  elapsedMs: number
  /** 是否来自开局库（book 着，非搜索得出） */
  book?: boolean
}

/** 给定局面选 AI 走法；无合法走法返回 null */
export function chooseAiMove(state: GameState, level: AiLevel): AiSearchResult | null {
  const cfg = AI_LEVELS[level]
  const legal = legalMoves(state, state.turn)
  if (legal.length === 0) return null
  if (legal.length === 1) {
    return { move: legal[0], score: 0, depth: 0, nodes: 0, elapsedMs: 0 }
  }
  // 开局选着：棋谱优先 + 池内随机（详见文件头 §开局候选池）。
  // 覆盖范围内直接返回，覆盖范围外（库未命中）回退下面的常规搜索。
  const opening = chooseOpeningMove(state, legal)
  if (opening) return opening
  // 开局亏本兑换拦截（详见文件头说明）：仅根节点、仅开局阶段
  const moves = rootCandidateMoves(state, legal)

  // 阶段性放宽搜索深度上限（2026-10-03）：
  // 残局子力少 → 分支因子小，同样的时间预算能多搜好几层。原来的固定 depth 6 让
  // 「大子基本兑完」的残局只用掉几百毫秒就停下来，等于把思考预算白白扔掉，
  // 表现为「残局水平菜」。这里**只放宽上限**，时间限制仍是 timeLimitMs 不放松
  // （2 核 ECS 的保护线不动），迭代加深自然会停在时间耗尽的那一层。
  // easy 不参与放宽：初级必须保持可被新手战胜。
  const pieceCountNow = countPieces(state.board)
  // 2026-10-04 深夜：阈值由「≤12→+6 / ≤20→+3」放宽为三档（+2/+4/+6）。
  // 线上复盘（5EJ3BV）显示 AI 崩盘发生在 **22~26 子**（红 14 + 黑 10）的阶段，
  // 而旧阈值要到 20 子以下才加成 ⇒ 「脱谱后的中盘」完全没拿到额外深度。
  const extraDepth =
    level === 'easy'
      ? 0
      : pieceCountNow <= ENDGAME_PIECES
        ? 6
        : pieceCountNow <= 18
          ? 4
          : pieceCountNow <= 24
            ? 2
            : 0
  const maxDepth = cfg.maxDepth + extraDepth

  const start = Date.now()
  const deadlineMs = start + cfg.timeLimitMs
  let nodeCounter = 0
  const killers = makeKillers()
  resetKillers(killers)
  const tt = makeTT()
  let bestMove: Move = moves[0]
  let bestScore = -INF
  let completedDepth = 0
  /** 上一层迭代的最优根着法：下一层最先搜它（PV 优先，极大提升 alpha-beta 剪枝效率） */
  let prevBest: Move | undefined
  /** 最后一层**完整完成**的迭代里，每个根着法的分数（用于 easy 扰动按真实分数挑候选） */
  let rootScores: { m: Move; s: number }[] = []

  // 迭代加深：逐层加深；某层超时则整层作废（避免部分搜索污染），用上一层完整结果
  for (let depth = 1; depth <= maxDepth; depth++) {
    if (Date.now() - start > cfg.timeLimitMs) break

    const ordered = orderMoves(state, moves, killers, undefined, prevBest)
    let alpha = -INF
    let curBest: Move | null = null
    let curScore = -INF
    const layerScores: { m: Move; s: number }[] = []

    try {
      for (const m of ordered) {
        // skipSeen:false → 顶层感知重复局面（第 3 次出现判和），AI 不会主动走向重复
        const next = applyMove(state, m, { skipValidation: true, skipSeen: false })
        let score: number
        const [ns, nnc] = negamax(next, opposite(state.turn), depth - 1, -INF, -alpha, killers, nodeCounter, deadlineMs, tt, (m) => isKiller(m, killers[depth] ?? []), 1)
        score = -ns
        nodeCounter = nnc
        // 反空挪子：走完后回到本局出现过的局面（第 2 次）→ 轻微减分（详见 REPEAT_PENALTY）
        if (!next.result && (next.seen[boardKey(next)] ?? 0) >= 2) score -= REPEAT_PENALTY
        layerScores.push({ m, s: score })
        if (score > curScore) {
          curScore = score
          curBest = m
        }
        if (curScore > alpha) alpha = curScore
        if (Date.now() - start > cfg.timeLimitMs) break // 本层提前结束（部分走法已搜完，可用）
      }
    } catch (e) {
      if (e !== SEARCH_TIMEOUT) throw e
      break // 递归中超时：整层作废，用上一层结果
    }

    if (curBest) {
      bestMove = curBest
      bestScore = curScore
      completedDepth = depth
      rootScores = layerScores
      prevBest = curBest
    }
  }

  // 初级扰动（2026-10-04 重写）：
  // 旧实现 `orderMoves(...).slice(0,3)` 是**按「吃子价值优先」排序**取前 3 —— 与搜索结果无关，
  // 且非吃子着法的排序分全是 0（顺序 = legalMoves 原始顺序）。后果：
  //   ① 有吃子时它总在「最贪的吃子」里随机 → 常选中亏子吃法（实测中局 29% 概率走「炮五进四」，
  //      即白送一个炮 —— 玩家反馈的「送炮吃」就是这个）；
  //   ② 没吃子时 = 按棋子生成顺序随机摸一步 → 「随便乱走、反复空挪车」。
  // 现在改为：取主循环**最后一层完整迭代**的根着法分数排前 4（最优必然在内，其分数是满窗精确值），
  // 对这 4 手用满窗复核一次真实分数，再在「与最优差距 ≤ EASY_SLACK」的着法里随机取前 3。
  // 既保留「初级会失误、新手能赢」，又绝不白送大子（SLACK 100 ≈ 半个兵，远小于马 400 / 炮 450 / 车 900）。
  // 只复核 4 手而非全部着法：全量满窗重搜会把 easy 单步从 30ms 抬到 ~380ms（无谓开销）。
  if (cfg.jitter && completedDepth >= 1 && rootScores.length > 0) {
    const d = completedDepth
    const cands = rootScores
      .slice()
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
    const exact: { m: Move; s: number }[] = []
    try {
      for (const c of cands) {
        // skipSeen:false → 与主循环一致，感知重复局面
        const next = applyMove(state, c.m, { skipValidation: true, skipSeen: false })
        const [ns, nnc] = negamax(
          next,
          opposite(state.turn),
          d - 1,
          -INF,
          INF,
          killers,
          nodeCounter,
          deadlineMs,
          tt,
          (mm) => isKiller(mm, killers[d] ?? []),
          1,
        )
        nodeCounter = nnc
        exact.push({ m: c.m, s: -ns })
      }
    } catch (err) {
      if (err !== SEARCH_TIMEOUT) throw err
      exact.length = 0 // 超时则放弃扰动，沿用迭代加深的结果（不冒险用半截分数）
    }
    if (exact.length > 0) {
      exact.sort((a, b) => b.s - a.s)
      const topScore = exact[0].s
      const pool = exact.filter((x) => x.s >= topScore - EASY_SLACK).slice(0, 3)
      bestMove = pool[Math.floor(Math.random() * pool.length)].m
    }
  }

  return {
    move: bestMove,
    score: bestScore,
    depth: completedDepth,
    nodes: nodeCounter,
    elapsedMs: Date.now() - start,
  }
}
