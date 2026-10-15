/**
 * 中国象棋规则引擎（纯函数，无 UI 依赖）
 *
 * 依据：中国象棋竞赛规则（2011 试行版）核心条款。
 * 坐标约定：
 *   - 棋盘 10 行 × 9 列，row 0 = 黑方底线（顶部），row 9 = 红方底线（底部）
 *   - col 0-8 从左到右；红方在下方（rows 5-9），黑方在上方（rows 0-4）
 *   - 河界位于 row 4 / row 5 之间；红兵过河 = row <= 4，黑卒过河 = row >= 5
 *   - 九宫：红 rows 7-9 / cols 3-5；黑 rows 0-2 / cols 3-5
 * 棋子符号（FEN，红大写黑小写）：
 *   K=帅/将 A=仕/士 B=相/象 N=马 R=车 C=炮 P=兵/卒
 *
 * 规则要点（与竞赛规则对齐）：
 *   - 帅将不能对脸；走子后己方帅/将不能被将军（禁送将）
 *   - 马蹩马腿、相塞象眼、相不过河、炮吃子需隔一个炮架
 *   - 兵过河前只能直进，过河后可横走，永不后退
 *   - 将死（被将军且无着可走）判负；困毙（无着可走但未被将军）同样判负（中国象棋特殊，与国际象棋不同）
 *   - 和棋：60 回合无吃子（120 半回合）、同一局面出现 3 次、双方无子可胜
 *   - [简化说明] 长将/长捉按「重复局面 3 次判和」自动处理，与竞赛规则「长将判负」有差异，
 *     休闲场景可接受；如需严格判负需后续补长将检测
 *
 * 性能设计（AI 搜索关键）：
 *   - Board 为扁平 Uint8Array(90)（index = r*9+c），棋子编码为数字，克隆 = slice()，访问比双层对象数组快 5-10 倍
 *   - legalMoves 单克隆 + 走/回退，避免每走法克隆
 *   - applyMove 支持 skipValidation / skipSeen / skipStatus（AI 搜索用）：
 *     skipStatus 跳过 getGameStatus（它内部会再跑一次 legalMoves，是最大单点开销），
 *     将死由搜索侧自行识别（见 ai.ts negamax/quiescence），实测搜索提速 2~3 倍
 */

export type Color = 'r' | 'b'
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P'

export interface Piece {
  type: PieceType
  color: Color
}

/**
 * 棋盘编码：0=空；1-7 = 红 K,A,B,N,R,C,P；8-14 = 黑 K,A,B,N,R,C,P
 * index = r * COLS + c
 */
export type Board = Uint8Array

export const CELL_EMPTY = 0
export const CELL_R_K = 1
export const CELL_R_A = 2
export const CELL_R_B = 3
export const CELL_R_N = 4
export const CELL_R_R = 5
export const CELL_R_C = 6
export const CELL_R_P = 7
export const CELL_B_K = 8
export const CELL_B_A = 9
export const CELL_B_B = 10
export const CELL_B_N = 11
export const CELL_B_R = 12
export const CELL_B_C = 13
export const CELL_B_P = 14

const PIECE_TYPES: PieceType[] = ['K', 'A', 'B', 'N', 'R', 'C', 'P']
const TYPE_INDEX: Record<PieceType, number> = { K: 0, A: 1, B: 2, N: 3, R: 4, C: 5, P: 6 }

export function cellColor(cell: number): Color | null {
  if (cell === CELL_EMPTY) return null
  return cell <= 7 ? 'r' : 'b'
}

export function cellType(cell: number): PieceType | null {
  if (cell === CELL_EMPTY) return null
  return PIECE_TYPES[(cell - 1) % 7]
}

/** 由类型与颜色构造编码 */
export function cellOf(type: PieceType, color: Color): number {
  return TYPE_INDEX[type] + (color === 'r' ? 1 : 8)
}

/** index = r * COLS + c */
export function idx(r: number, c: number): number {
  return r * COLS + c
}

export interface Pos {
  r: number
  c: number
}

export interface Move {
  from: Pos
  to: Pos
}

export type GameResultReason =
  | 'CHECKMATE' // 将死
  | 'STALEMATE' // 困毙（无子可动判负，中国象棋规则）
  | 'TIMEOUT' // 超时判负（由房间层产生）
  | 'RESIGN' // 认输（由房间层产生）
  | 'DRAW_AGREEMENT' // 双方同意和棋（由房间层产生）
  | 'DRAW_REPETITION' // 重复局面 3 次
  | 'DRAW_NATURAL' // 60 回合无吃子（120 半回合）
  | 'DRAW_INSUFFICIENT' // 双方无子可胜

export interface GameResult {
  winner: Color | null // null = 和棋
  reason: GameResultReason
}

export interface GameState {
  board: Board
  turn: Color
  /** 无吃子半回合计数（自然限着用，吃子重置） */
  halfMoveClock: number
  /** 整回合数，从 1 起，黑方走完 +1 */
  fullMoveNumber: number
  /** 局面键（盘面+轮到谁）出现次数 → 重复局面判和 */
  seen: Record<string, number>
  result: GameResult | null
}

export const ROWS = 10
export const COLS = 9

/** 自然限着：60 回合无吃子 = 120 半回合（竞赛规则） */
export const NATURAL_DRAW_PLY = 120

export const PIECE_TYPE_NAMES: Record<PieceType, string> = {
  K: '帅/将',
  A: '仕/士',
  B: '相/象',
  N: '马',
  R: '车',
  C: '炮',
  P: '兵/卒',
}

export const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - 0 1'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function opposite(color: Color): Color {
  return color === 'r' ? 'b' : 'r'
}

export function inBoard(r: number, c: number): boolean {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS
}

/** 是否在己方九宫内 */
export function inPalace(r: number, c: number, color: Color): boolean {
  if (c < 3 || c > 5) return false
  return color === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2
}

/** 是否在己方半场（未过河一侧）：红 rows 5-9，黑 rows 0-4 */
export function inOwnHalf(r: number, color: Color): boolean {
  return color === 'r' ? r >= 5 : r <= 4
}

/** 兵/卒是否已过河：红兵 row <= 4，黑卒 row >= 5 */
export function crossedRiver(r: number, color: Color): boolean {
  return color === 'r' ? r <= 4 : r >= 5
}

/** 棋子编码 → FEN 字符（红大写黑小写） */
export function pieceChar(cell: number): string {
  const type = cellType(cell)
  const color = cellColor(cell)
  if (!type || !color) return ''
  return color === 'r' ? type : type.toLowerCase()
}

export function findKing(board: Board, color: Color): Pos | null {
  const kingCell = color === 'r' ? CELL_R_K : CELL_B_K
  for (let i = 0; i < board.length; i++) {
    if (board[i] === kingCell) return { r: Math.floor(i / COLS), c: i % COLS }
  }
  return null
}

/** 盘面键（不含 halfmove/fullmove），用于重复局面检测 */
export function boardKey(state: Pick<GameState, 'board' | 'turn'>): string {
  return `${fenBoardPart(state.board)} ${state.turn}`
}

/** 同列 r1-r2 之间（不含两端）是否有子 */
function hasPieceBetween(board: Board, r1: number, r2: number, c: number): boolean {
  const lo = Math.min(r1, r2)
  const hi = Math.max(r1, r2)
  for (let r = lo + 1; r < hi; r++) {
    if (board[idx(r, c)] !== CELL_EMPTY) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 攻击检测（将军核心）
// ---------------------------------------------------------------------------

// ⚠️ 性能：这些偏移表原先是写在 isSquareAttacked / legalMoves 函数体内的字面量，
// 每次调用都重新分配数组（isSquareAttacked 是全站最热函数，legalMoves 一次要调 40+ 次）。
// 提到模块级常量后 GC 分配归零，中局 movegen 实测提速约 25%。
const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
]
const DIAG_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
]
const ORTHO_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
]
const ELEPHANT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-2, -2], [-2, 2], [2, -2], [2, 2],
]

/**
 * pos 是否被 byColor 方攻击。
 * 覆盖：兵/卒、马（含蹩腿）、帅/将（相邻 + 对脸）、仕/士、相/象（含塞象眼）、车、炮（隔架）
 * byKingPos：byColor 方将/帅位置（调用方已知时传入避免重复 findKing，性能关键）
 */
export function isSquareAttacked(
  board: Board,
  pos: Pos,
  byColor: Color,
  byKingPos?: Pos | null,
): boolean {
  const { r, c } = pos

  // 1) 兵/卒：直攻（攻击者向前一格）+ 过河后横攻
  const fwd = byColor === 'r' ? 1 : -1 // 攻击者视角：红兵攻击下方格？不——红兵向前=row 减小
  // 红兵在 (pr,pc) 攻击 (pr-1,pc)；因此 pos 被红兵攻击 ⇔ 红兵在 (r+1, c)
  const pr = r + fwd
  if (inBoard(pr, c)) {
    const cell = board[idx(pr, c)]
    if (cell === (byColor === 'r' ? CELL_R_P : CELL_B_P)) return true
  }
  for (const dc of [-1, 1]) {
    if (!inBoard(r, c + dc)) continue
    const cell = board[idx(r, c + dc)]
    if (cell === (byColor === 'r' ? CELL_R_P : CELL_B_P) && crossedRiver(r, byColor)) return true
  }

  // 2) 马（日字，检查蹩腿）
  const knightCell = byColor === 'r' ? CELL_R_N : CELL_B_N
  for (const [dr, dc] of KNIGHT_STEPS) {
    const mr = r + dr
    const mc = c + dc
    if (!inBoard(mr, mc)) continue
    if (board[idx(mr, mc)] !== knightCell) continue
    // 蹩腿点：马在 (mr,mc) 扑向目标 (r,c)，位移为 (-dr,-dc)。
    // 马腿紧邻马、朝目标方向一格：|位移行|=2 → (mr - dr/2, mc)；|位移列|=2 → (mr, mc - dc/2)
    // （历史 bug：曾写成 mr + dr/2，算成马背向目标的镜像格，导致老将能走进马口、马后炮将死不判负）
    const legR = mr - (Math.abs(dr) === 2 ? dr / 2 : 0)
    const legC = mc - (Math.abs(dc) === 2 ? dc / 2 : 0)
    if (board[idx(legR, legC)] === CELL_EMPTY) return true
  }

  // 3) 帅/将：相邻一格（九宫内）+ 对脸（同列无间隔）
  const oppKing = byKingPos !== undefined ? byKingPos : findKing(board, byColor)
  if (oppKing) {
    if (Math.abs(oppKing.r - r) + Math.abs(oppKing.c - c) === 1) return true
    if (oppKing.c === c && !hasPieceBetween(board, oppKing.r, r, c)) return true
  }

  // 4) 仕/士：斜一格（目标须在己方九宫内）
  const advisorCell = byColor === 'r' ? CELL_R_A : CELL_B_A
  for (const [dr, dc] of DIAG_STEPS) {
    const ar = r + dr
    const ac = c + dc
    if (!inBoard(ar, ac)) continue
    if (board[idx(ar, ac)] === advisorCell && inPalace(ar, ac, byColor)) return true
  }

  // 5) 相/象：田字（象眼须空、目标须在己方半场）
  const elephantCell = byColor === 'r' ? CELL_R_B : CELL_B_B
  for (const [dr, dc] of ELEPHANT_STEPS) {
    const br = r + dr
    const bc = c + dc
    if (!inBoard(br, bc)) continue
    if (board[idx(br, bc)] !== elephantCell) continue
    const eyeR = r + dr / 2
    const eyeC = c + dc / 2
    if (board[idx(eyeR, eyeC)] === CELL_EMPTY && inOwnHalf(br, byColor)) return true
  }

  // 6) 车 / 炮：直线扫描。第一个遇子若为对方车 → 攻击；跨过一个子后的第一个子若为对方炮 → 攻击
  const rookCell = byColor === 'r' ? CELL_R_R : CELL_B_R
  const cannonCell = byColor === 'r' ? CELL_R_C : CELL_B_C
  for (const [dr, dc] of ORTHO_STEPS) {
    let rr = r + dr
    let cc = c + dc
    let crossed = false // 是否已遇到第一个子（炮架候选）
    while (inBoard(rr, cc)) {
      const cell = board[idx(rr, cc)]
      if (cell !== CELL_EMPTY) {
        if (cellColor(cell) === byColor) {
          if (cell === rookCell && !crossed) return true // 车是第一个子 → 直线攻击
          if (cell === cannonCell && crossed) return true // 炮是第二个子 → 隔架攻击
        }
        if (!crossed) crossed = true
        else break
      }
      rr += dr
      cc += dc
    }
  }

  return false
}

/** color 方的帅/将是否正被将军 */
export function isInCheck(state: Pick<GameState, 'board'>, color: Color): boolean {
  const king = findKing(state.board, color)
  if (!king) return true // 无帅（异常局面）视为被将
  return isSquareAttacked(state.board, king, opposite(color))
}

// ---------------------------------------------------------------------------
// 走法生成
// ---------------------------------------------------------------------------

/** 伪合法走法：不校验「走子后送将」 */
export function pseudoLegalMoves(state: Pick<GameState, 'board'>, color: Color): Move[] {
  const { board } = state
  const moves: Move[] = []

  const tryAdd = (from: Pos, tr: number, tc: number) => {
    if (!inBoard(tr, tc)) return
    const cell = board[idx(tr, tc)]
    if (cell !== CELL_EMPTY && cellColor(cell) === color) return // 不能吃己方子
    if (cell !== CELL_EMPTY && cellType(cell) === 'K') return // 不能吃帅/将（将死即终局，无吃帅走法）
    moves.push({ from, to: { r: tr, c: tc } })
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[idx(r, c)]
      if (cell === CELL_EMPTY || cellColor(cell) !== color) continue
      const from: Pos = { r, c }

      switch (cellType(cell)) {
        case 'K': {
          for (const [dr, dc] of [
            [-1, 0], [1, 0], [0, -1], [0, 1],
          ] as Array<[number, number]>) {
            const tr = r + dr
            const tc = c + dc
            if (inPalace(tr, tc, color)) tryAdd(from, tr, tc)
          }
          break
        }
        case 'A': {
          for (const [dr, dc] of [
            [-1, -1], [-1, 1], [1, -1], [1, 1],
          ] as Array<[number, number]>) {
            const tr = r + dr
            const tc = c + dc
            if (inPalace(tr, tc, color)) tryAdd(from, tr, tc)
          }
          break
        }
        case 'B': {
          for (const [dr, dc] of [
            [-2, -2], [-2, 2], [2, -2], [2, 2],
          ] as Array<[number, number]>) {
            const tr = r + dr
            const tc = c + dc
            if (!inBoard(tr, tc) || !inOwnHalf(tr, color)) continue
            const eyeR = r + dr / 2
            const eyeC = c + dc / 2
            if (board[idx(eyeR, eyeC)] !== CELL_EMPTY) continue // 塞象眼
            tryAdd(from, tr, tc)
          }
          break
        }
        case 'N': {
          for (const [dr, dc] of [
            [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
          ] as Array<[number, number]>) {
            const tr = r + dr
            const tc = c + dc
            if (!inBoard(tr, tc)) continue
            const legR = r + (Math.abs(dr) === 2 ? dr / 2 : 0)
            const legC = c + (Math.abs(dc) === 2 ? dc / 2 : 0)
            if (board[idx(legR, legC)] !== CELL_EMPTY) continue // 蹩马腿
            tryAdd(from, tr, tc)
          }
          break
        }
        case 'R': {
          for (const [dr, dc] of [
            [-1, 0], [1, 0], [0, -1], [0, 1],
          ] as Array<[number, number]>) {
            let tr = r + dr
            let tc = c + dc
            while (inBoard(tr, tc) && board[idx(tr, tc)] === CELL_EMPTY) {
              tryAdd(from, tr, tc)
              tr += dr
              tc += dc
            }
            if (inBoard(tr, tc)) tryAdd(from, tr, tc) // 吃遇到的第一个子
          }
          break
        }
        case 'C': {
          for (const [dr, dc] of [
            [-1, 0], [1, 0], [0, -1], [0, 1],
          ] as Array<[number, number]>) {
            let tr = r + dr
            let tc = c + dc
            while (inBoard(tr, tc) && board[idx(tr, tc)] === CELL_EMPTY) {
              tryAdd(from, tr, tc) // 不吃子时走直线（不可越子）
              tr += dr
              tc += dc
            }
            if (!inBoard(tr, tc)) continue
            // 遇到第一个子（炮架），继续找炮架后的第一个子（可吃）
            tr += dr
            tc += dc
            while (inBoard(tr, tc) && board[idx(tr, tc)] === CELL_EMPTY) {
              tr += dr
              tc += dc
            }
            if (inBoard(tr, tc)) tryAdd(from, tr, tc)
          }
          break
        }
        case 'P': {
          const fwd = color === 'r' ? -1 : 1 // 红兵向前 = row 减小
          tryAdd(from, r + fwd, c) // 直进
          if (crossedRiver(r, color)) {
            tryAdd(from, r, c - 1) // 过河后横走
            tryAdd(from, r, c + 1)
          }
          break
        }
      }
    }
  }

  return moves
}

/** 合法走法：伪合法走法过滤掉「走子后己方帅/将被将军（含对脸）」 */
export function legalMoves(state: Pick<GameState, 'board'>, color: Color): Move[] {
  const { board } = state
  const pseudo = pseudoLegalMoves(state, color)
  if (pseudo.length === 0) return pseudo
  // 性能：只克隆一次棋盘，逐走法「走→检查→回退」，避免每走法克隆（AI 搜索每节点 40+ 走法）
  const nb = board.slice()
  const opp = opposite(color)
  const oppKing = findKing(nb, opp) // 走子不可能吃王，对方王位在整个循环中不变
  const myKing = findKing(nb, color)
  const kingCell = color === 'r' ? CELL_R_K : CELL_B_K
  const result: Move[] = []
  for (const m of pseudo) {
    const fromIdx = idx(m.from.r, m.from.c)
    const toIdx = idx(m.to.r, m.to.c)
    const fromP = nb[fromIdx]
    const toP = nb[toIdx]
    nb[toIdx] = fromP
    nb[fromIdx] = CELL_EMPTY
    const king = fromP === kingCell ? m.to : myKing
    const safe = king ? !isSquareAttacked(nb, king, opp, oppKing) : false
    // 回退
    nb[fromIdx] = fromP
    nb[toIdx] = toP
    if (safe) result.push(m)
  }
  return result
}

/** 某一步是否合法（房间层校验用） */
export function isLegalMove(state: GameState, move: Move): boolean {
  if (state.result) return false
  const cell = state.board[idx(move.from.r, move.from.c)]
  if (cell === CELL_EMPTY || cellColor(cell) !== state.turn) return false
  return legalMoves(state, state.turn).some(
    (m) => m.from.r === move.from.r && m.from.c === move.from.c && m.to.r === move.to.r && m.to.c === move.to.c,
  )
}

// ---------------------------------------------------------------------------
// 走子与终局判定
// ---------------------------------------------------------------------------

/**
 * 双方无子可胜（无争议例和）：
 *   - 有兵/卒 → 不判和（兵有杀棋可能）
 *   - 有车 → 不判和（单车必胜，可杀单将）
 *   - 马/炮合计 <= 1 → 判和（单马/单炮均无法杀单将，例和）
 *   - 双马/双炮等不判和（双马双炮例和但存在复杂变化，宁可继续下，玩家可求和）
 */
export function hasInsufficientMaterial(board: Board): boolean {
  let hasPawn = false
  let hasRook = false
  let attackCount = 0 // 马+炮
  for (let i = 0; i < board.length; i++) {
    const cell = board[i]
    if (cell === CELL_EMPTY) continue
    const type = cellType(cell)
    if (type === 'P') hasPawn = true
    else if (type === 'R') hasRook = true
    else if (type === 'N' || type === 'C') attackCount++
  }
  if (hasPawn || hasRook) return false
  return attackCount <= 1
}

/**
 * 当前局面终局判定：
 *   - 无合法走法：被将军 → 将死（对方胜）；未被将军 → 困毙（对方胜，中国象棋规则）
 *   - 自然限着（120 半回合无吃子）→ 和
 *   - 重复局面 3 次 → 和
 *   - 双方无子可胜 → 和
 */
export function getGameStatus(state: GameState, opts?: { skipSeen?: boolean }): GameResult | null {
  const { board, turn } = state
  const moves = legalMoves(state, turn)
  if (moves.length === 0) {
    const checked = isInCheck(state, turn)
    return { winner: opposite(turn), reason: checked ? 'CHECKMATE' : 'STALEMATE' }
  }
  if (state.halfMoveClock >= NATURAL_DRAW_PLY) return { winner: null, reason: 'DRAW_NATURAL' }
  // AI 搜索跳过重复局面检测（省 boardKey 生成与 seen 复制；搜索树内重复局面极少，且受深度限制）
  if (!opts?.skipSeen) {
    const key = boardKey(state)
    if ((state.seen[key] ?? 0) >= 3) return { winner: null, reason: 'DRAW_REPETITION' }
  }
  if (hasInsufficientMaterial(board)) return { winner: null, reason: 'DRAW_INSUFFICIENT' }
  return null
}

/**
 * 应用一步走子，返回新状态（纯函数，不改原状态）。
 * 会同步：回合切换、无吃子计数、重复局面计数、终局判定。
 * 走子非法时抛 Error（房间层应先 isLegalMove 校验）。
 * opts.skipValidation：跳过合法性重校验（AI 内部走法已过滤，性能关键）
 * opts.skipSeen：跳过 seen 复制与重复局面检测（AI 搜索用，共享 seen 对象——AI 内不修改它，安全）
 */
export function applyMove(
  state: GameState,
  move: Move,
  opts?: { skipValidation?: boolean; skipSeen?: boolean; skipStatus?: boolean },
): GameState {
  const { board, turn } = state
  const piece = board[idx(move.from.r, move.from.c)]
  if (piece === CELL_EMPTY || cellColor(piece) !== turn) throw new Error('非法走子：非本方回合或非本方棋子')
  if (state.result) throw new Error('对局已结束')
  // AI 内部走法已由 legalMoves 过滤（含送将检查），跳过重复校验可省 2/3 走法生成（性能关键）
  if (!opts?.skipValidation && !isLegalMove(state, move)) throw new Error('非法走子：不符合象棋规则')

  const newBoard = board.slice()
  const fromIdx = idx(move.from.r, move.from.c)
  const toIdx = idx(move.to.r, move.to.c)
  newBoard[toIdx] = newBoard[fromIdx]
  newBoard[fromIdx] = CELL_EMPTY
  const captured = board[toIdx]
  const next: GameState = {
    board: newBoard,
    turn: opposite(turn),
    halfMoveClock: captured !== CELL_EMPTY ? 0 : state.halfMoveClock + 1,
    fullMoveNumber: state.fullMoveNumber + (turn === 'b' ? 1 : 0),
    seen: opts?.skipSeen ? state.seen : { ...state.seen },
    result: null,
  }
  if (!opts?.skipSeen) {
    const key = boardKey(next)
    next.seen[key] = (next.seen[key] ?? 0) + 1
  }
  // ⚠️ skipStatus（2026-10-04 深夜，AI 搜索专用）：getGameStatus 内部会再跑一次完整
  // legalMoves —— 而 legalMoves 是全场最贵的函数（实测 52µs/次，open 中局），
  // 于是每个搜索节点白付 ~45µs（applyMove 总耗时 62.6µs 里占 72%），直接把搜索拖慢 3~4 倍，
  // 逼得 medium（1500ms）在中残局只跑出 depth 2~3 —— 正是「脱谱后越下越乱」的真凶。
  // 搜索内部改为不判终局：将死/困毙由 negamax「无合法走法」分支自行识别（见 ai.ts），
  // 和棋（120 回合/重复/无子可胜）在搜索树内极罕见且受深度限制，不判无碍。
  // 房间层/根节点仍走完整判定（不传 skipStatus）。
  if (!opts?.skipStatus) next.result = getGameStatus(next, { skipSeen: opts?.skipSeen })
  return next
}

/** 尝试走子：合法返回新状态，非法返回 null（房间层友好校验用） */
export function tryApplyMove(state: GameState, move: Move): GameState | null {
  try {
    return applyMove(state, move)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// FEN 序列化
// ---------------------------------------------------------------------------

function fenBoardPart(board: Board): string {
  const rows: string[] = []
  for (let r = 0; r < ROWS; r++) {
    let s = ''
    let empty = 0
    for (let c = 0; c < COLS; c++) {
      const cell = board[idx(r, c)]
      if (cell === CELL_EMPTY) {
        empty++
        continue
      }
      if (empty) {
        s += empty
        empty = 0
      }
      s += pieceChar(cell)
    }
    if (empty) s += empty
    rows.push(s)
  }
  return rows.join('/')
}

export function stateToFen(state: GameState): string {
  // FEN 回合符号：红方=w（沿袭国际象棋 white 先手习惯），黑方=b；内部 Color 用 r/b
  return `${fenBoardPart(state.board)} ${state.turn === 'r' ? 'w' : 'b'} - ${state.halfMoveClock} ${state.fullMoveNumber}`
}

const FEN_PIECE_TYPES: PieceType[] = ['K', 'A', 'B', 'N', 'R', 'C', 'P']

export function fenToState(fen: string): GameState {
  const parts = fen.trim().split(/\s+/)
  if (parts.length < 4) throw new Error(`FEN 格式错误: ${fen}`)
  const [boardPart, turnPart, , halfPart, fullPart] = parts
  const rows = boardPart.split('/')
  if (rows.length !== ROWS) throw new Error(`FEN 行数错误: ${fen}`)

  const board = new Uint8Array(ROWS * COLS)
  rows.forEach((row, r) => {
    let c = 0
    for (const ch of row) {
      if (/\d/.test(ch)) {
        c += Number(ch)
        continue
      }
      const upper = ch.toUpperCase()
      if (!FEN_PIECE_TYPES.includes(upper as PieceType)) throw new Error(`FEN 未知棋子: ${ch}`)
      board[idx(r, c)] = cellOf(upper as PieceType, ch === upper ? 'r' : 'b')
      c++
    }
    if (c !== COLS) throw new Error(`FEN 列数错误: ${fen}`)
  })

  const state: GameState = {
    board,
    turn: turnPart === 'b' ? 'b' : 'r',
    halfMoveClock: Number(halfPart) || 0,
    fullMoveNumber: Number(fullPart) || 1,
    seen: {},
    result: null,
  }
  state.seen[boardKey(state)] = 1
  state.result = getGameStatus(state)
  return state
}

export function createInitialState(): GameState {
  return fenToState(INITIAL_FEN)
}
