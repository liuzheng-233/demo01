/**
 * 象棋房间状态机（纯函数，零 DB 依赖，可单测）
 *
 * 房间层（room.ts）负责 DB 读写，本模块负责所有对局逻辑：
 *   - 开局（双 ready 判定 / PVE 直接开局）
 *   - 走子（服务端合法性校验 + 双时钟结算 + 将军/终局检测）
 *   - AI 应手（PVE 同步返回）
 *   - 认输 / 求和 / 悔棋（PVP 需对方同意，PVE 直接撤）
 *   - 超时检测（局时钟 + 步时钟，任一并零判负）
 *   - viewFor 数据组装（选手/观战视图）
 *
 * 时钟模型（§4 计时规则）：
 *   - 局时钟：每方独立，开局 = gameMinutes 分钟
 *   - 步时钟：每步独立，轮到谁重置为 stepSeconds 秒（由 turnStartedAt 推算）
 *   - 走完一手：自己局时钟扣本步用时 → 切回合 → 对方步时钟重置
 *   - 任一时钟归零即判负（服务端权威，前端只做显示）
 */

import {
  type GameState as EngineState,
  type Move,
  type Color,
  type GameResult,
  type GameResultReason,
  createInitialState,
  applyMove,
  isInCheck,
  getGameStatus,
  legalMoves,
  pseudoLegalMoves,
  stateToFen,
  boardKey,
} from './rules'
import { chooseAiMove, evaluate, type AiLevel, AI_LEVEL_NAMES } from './ai'

export const SEAT_RED = 1 // 红
export const SEAT_BLACK = 2 // 黑

export function seatOf(color: Color): number {
  return color === 'r' ? SEAT_RED : SEAT_BLACK
}
export function colorOf(seat: number): Color {
  return seat === SEAT_RED ? 'r' : 'b'
}

export interface HistoryEntry {
  from: [number, number]
  to: [number, number]
  /** 该步走完后的双方局时钟（ms），悔棋重放恢复用 */
  redMs: number
  blackMs: number
  /** 走子方；观战渲染 / 悔棋校验用 */
  by: number
}

export interface ChatMsg {
  userId: string
  name: string
  seat: number | null // 1 红 | 2 黑 | null 观战
  text: string
  time: number
}

export type RoomPhase = 'WAITING' | 'PLAYING' | 'FINISHED'

export interface XiangqiState {
  phase: RoomPhase
  mode: 'PVP' | 'PVE'
  aiLevel: AiLevel | null // PVE 有效
  /** 本机双人（同一设备轮流下，单一账号占红+黑两席） */
  passAndPlay: boolean
  // 引擎状态（持久化：board 转 number[]，seen 直接存）
  board: number[]
  turn: Color
  halfMoveClock: number
  fullMoveNumber: number
  seen: Record<string, number>
  result: { winner: Color | null; reason: GameResultReason } | null
  // 时钟
  clockRedMs: number
  clockBlackMs: number
  turnStartedAt: number | null
  // 开局确认（PVP）
  readyRed: boolean
  readyBlack: boolean
  // 操作请求（PVP）
  drawOffer: number | null // 提出求和的 seat
  undoRequest: number | null // 提出悔棋的 seat
  undoable: number | null // 有悔棋权的 seat（走完棋后设置，对方可以悔自己的那步）
  // 历史与消息
  history: HistoryEntry[]
  messages: ChatMsg[]
  startedAt: number | null
  endedAt: number | null
  lastMove: Move | null
  /** 当前行棋方是否被将军（前端提示 + 声音） */
  check: boolean
  /** 评测伪装房（matchType=EVALUATE 的 PVE）：AI 所在席位。
   *  拟人延时判断用；普通 PVE/PVP 无此字段。 */
  aiSeat?: number | null
  /** 评测伪装房：AI 应手的最早时刻（epoch ms）。
   *  到达该时刻前轮询不判 AI 超时；null/缺省 = 维持旧版“同步秒回”。 */
  aiThinkUntil?: number | null
  /** AI 求和决策时刻（epoch ms）：到点前显示「AI 考虑中」，到点后异步写入结果 */
  aiDrawUntil?: number | null
}

// ---------------------------------------------------------------------------
// 状态构造 / 持久化
// ---------------------------------------------------------------------------

export function createRoomState(mode: 'PVP' | 'PVE', aiLevel: AiLevel | null): XiangqiState {
  const eng = createInitialState()
  return {
    phase: 'WAITING',
    mode,
    aiLevel,
    passAndPlay: false,
    board: Array.from(eng.board),
    turn: eng.turn,
    halfMoveClock: eng.halfMoveClock,
    fullMoveNumber: eng.fullMoveNumber,
    seen: {},
    result: null,
    clockRedMs: 15 * 60 * 1000,
    clockBlackMs: 15 * 60 * 1000,
    turnStartedAt: null,
    readyRed: false,
    readyBlack: false,
    drawOffer: null,
    undoRequest: null,
    undoable: null,
    history: [],
    messages: [],
    startedAt: null,
    endedAt: null,
    lastMove: null,
    check: false,
  }
}

export function toEngineState(s: XiangqiState): EngineState {
  return {
    board: Uint8Array.from(s.board),
    turn: s.turn,
    halfMoveClock: s.halfMoveClock,
    fullMoveNumber: s.fullMoveNumber,
    seen: s.seen,
    result: s.result,
  }
}

// ---------------------------------------------------------------------------
// 开局
// ---------------------------------------------------------------------------

export interface StartResult {
  ok: boolean
  started?: boolean
  error?: string
}

/** PVP：选手点「开始」，双方都 ready 才开局；设置变更后 ready 已由 settings 重置 */
export function applyReady(s: XiangqiState, seat: number, wantReady: boolean): StartResult {
  if (s.phase !== 'WAITING') return { ok: false, error: '对局已开始' }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能开始' }
  const ready = { readyRed: s.readyRed, readyBlack: s.readyBlack }
  if (wantReady) {
    if (seat === SEAT_RED) ready.readyRed = true
    else ready.readyBlack = true
  } else {
    if (seat === SEAT_RED) ready.readyRed = false
    else ready.readyBlack = false
  }
  if (ready.readyRed && ready.readyBlack) {
    // 开局：红方先行，双时钟初始化
    s.phase = 'PLAYING'
    s.readyRed = true
    s.readyBlack = true
    s.turn = 'r'
    s.turnStartedAt = Date.now()
    s.startedAt = Date.now()
    s.history = []
    return { ok: true, started: true }
  }
  s.readyRed = ready.readyRed
  s.readyBlack = ready.readyBlack
  return { ok: true, started: false }
}

/** PVE：玩家点开始即开局（AI 自动 ready）。中国象棋红方先手。
 *  turn 始终设为 'r'（红先），AI 是否先走由 readyGame 中的状态判断决定。 */
export function applyPveStart(s: XiangqiState, seat: number): StartResult {
  if (s.phase !== 'WAITING') return { ok: false, error: '对局已开始' }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能开始' }
  s.phase = 'PLAYING'
  s.readyRed = true
  s.readyBlack = true
  s.turn = 'r' // 红方先行（中国象棋规则）
  s.turnStartedAt = Date.now()
  s.startedAt = Date.now()
  s.history = []
  return { ok: true, started: true }
}

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

export interface TimeoutInfo {
  /** 超时方座位 */
  seat: number
  reason: 'GAME_CLOCK' | 'STEP_CLOCK'
}

/** 检测当前行棋方是否超时（局时钟 + 步时钟）。nowMs 由调用方传入（测试可控） */
export function checkTimeout(s: XiangqiState, nowMs: number, stepSeconds: number): TimeoutInfo | null {
  if (s.phase !== 'PLAYING' || !s.turnStartedAt) return null
  const seat = seatOf(s.turn)
  const clock = seat === SEAT_RED ? s.clockRedMs : s.clockBlackMs
  if (clock <= 0) return { seat, reason: 'GAME_CLOCK' }
  const elapsed = nowMs - s.turnStartedAt
  if (elapsed >= stepSeconds * 1000) return { seat, reason: 'STEP_CLOCK' }
  // 局时钟理论上每步走子时已结算，这里兜底防御
  if (elapsed >= clock) return { seat, reason: 'GAME_CLOCK' }
  return null
}

/** 结算一步：扣行棋方局时钟，返回剩余；<=0 视为超时 */
export function settleClock(s: XiangqiState, nowMs: number): number {
  const seat = seatOf(s.turn)
  const elapsed = Math.max(0, nowMs - (s.turnStartedAt ?? nowMs))
  const remain = Math.max(0, (seat === SEAT_RED ? s.clockRedMs : s.clockBlackMs) - elapsed)
  if (seat === SEAT_RED) s.clockRedMs = remain
  else s.clockBlackMs = remain
  return remain
}

// ---------------------------------------------------------------------------
// 走子（PVP / PVE 玩家走子共用）
// ---------------------------------------------------------------------------

export interface MoveResult {
  ok: boolean
  error?: string
  /** PVE：玩家走完后 AI 的应手（含思考），AI 无合法走法时为 null */
  aiMove?: Move | null
  aiElapsedMs?: number
  aiLevel?: AiLevel | null
  /** 终局结果（走子或 AI 应手触发的） */
  final?: { winner: Color | null; reason: GameResultReason }
  timedOut?: { seat: number; reason: 'GAME_CLOCK' | 'STEP_CLOCK' }
  state: XiangqiState
}

/**
 * 玩家走子（服务端权威）：
 * 1. 校验回合/合法性
 * 2. 结算自己局时钟（超时判负）
 * 3. applyMove + 终局检测
 * 4. PVE：未结束时——若 opts.aiThinkMs>0（拟人延时模式）则记下 AI 应手时刻、不立即应手；
 *    否则同步计算 AI 应手并走完（旧行为）
 */
export function applyPlayerMove(
  s: XiangqiState,
  seat: number,
  move: Move,
  nowMs: number,
  stepSeconds: number,
  opts?: { aiThinkMs?: number }
): MoveResult {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (s.result) return { ok: false, error: '对局已结束', state: s }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能走子', state: s }
  const myColor = colorOf(seat)
  if (s.turn !== myColor) return { ok: false, error: '还没轮到你走子', state: s }

  // 走子前超时检查（防御：轮询应已判负，这里兜底）
  const timeout = checkTimeout(s, nowMs, stepSeconds)
  if (timeout) {
    s.phase = 'FINISHED'
    s.endedAt = nowMs
    s.result = { winner: myColor === 'r' ? 'b' : 'r', reason: 'TIMEOUT' }
    return { ok: false, error: '已超时判负', timedOut: timeout, final: s.result, state: s }
  }

  // 合法性校验 + 时钟结算
  const eng = toEngineState(s)
  let next: EngineState
  try {
    next = applyMove(eng, move)
  } catch {
    // 区分「送将」：走法本身成立（伪合法）但不合法 → 走完后己方将/帅被将军或将帅对脸
    const pseudo = pseudoLegalMoves(eng, myColor).some(
      (m) => m.from.r === move.from.r && m.from.c === move.from.c && m.to.r === move.to.r && m.to.c === move.to.c,
    )
    if (pseudo) return { ok: false, error: '不能送将：走这步后你的将（帅）会被对方吃掉', state: s }
    return { ok: false, error: '非法走子', state: s }
  }
  settleClock(s, nowMs)
  s.lastMove = move
  s.history.push({
    from: [move.from.r, move.from.c],
    to: [move.to.r, move.to.c],
    redMs: s.clockRedMs,
    blackMs: s.clockBlackMs,
    by: seat,
  })
  s.turn = next.turn
  s.board = Array.from(next.board)
  s.halfMoveClock = next.halfMoveClock
  s.fullMoveNumber = next.fullMoveNumber
  s.seen = next.seen
  s.result = next.result
  s.check = !next.result ? isInCheck(next, next.turn) : false
  s.undoable = seat // 走完棋后设置悔棋权（对方可以悔）
  // 切回合：重置步时钟起点（对手 / AI 从此刻计时）
  s.turnStartedAt = nowMs

  // 终局？
  if (s.result) {
    s.phase = 'FINISHED'
    s.endedAt = nowMs
    return { ok: true, final: s.result, state: s }
  }

  // PVE：AI 应手（玩家走完后 AI 自动走一步）
  if (s.mode === 'PVE' && s.aiLevel) {
    const aiThinkMs = opts?.aiThinkMs
    // 拟人延时模式（评测伪装房）：不立即应手，只登记 AI 应手席位与最早时刻，
    // 落子由服务端轮询/定时器在 aiThinkUntil 到点后执行（见 room.ts tryDelayedAiMove）
    if (aiThinkMs != null && aiThinkMs > 0) {
      s.aiSeat = seat === SEAT_RED ? SEAT_BLACK : SEAT_RED
      s.aiThinkUntil = nowMs + aiThinkMs
      return { ok: true, aiMove: null, aiElapsedMs: 0, aiLevel: s.aiLevel, state: s }
    }
    const aiRes = applyAiMove(s, nowMs)
    if (aiRes) {
      return {
        ok: true,
        aiMove: aiRes.aiMove,
        aiElapsedMs: aiRes.aiElapsedMs,
        aiLevel: s.aiLevel,
        state: s,
      }
    }
    // AI 走子后对局结束（将死/困毙/超时）
    return {
      ok: true,
      aiMove: null,
      aiElapsedMs: 0,
      aiLevel: s.aiLevel,
      final: s.result ?? undefined,
      state: s,
    }
  }

  return { ok: true, state: s }
}

/**
 * PVE：AI 自动走子（开局先手或玩家走子后的应手）。
 * 返回 null 表示对局已结束。
 */
export function applyAiMove(s: XiangqiState, nowMs: number): { aiMove: Move | null; aiElapsedMs: number } | null {
  if (s.mode !== 'PVE' || !s.aiLevel) return null
  const aiStart = Date.now()
  const aiRes = chooseAiMove(toEngineState(s), s.aiLevel)
  const aiElapsed = Date.now() - aiStart
  if (!aiRes) {
    // AI 无合法走法：困毙，玩家胜
    s.phase = 'FINISHED'
    s.endedAt = nowMs
    s.result = { winner: s.turn === 'r' ? 'b' : 'r', reason: 'STALEMATE' }
    return null
  }
  const aiSeat = seatOf(s.turn)
  settleClock(s, nowMs + aiElapsed)
  const engineNow = toEngineState(s)
  let appliedMove = aiRes.move
  let nextAi: EngineState
  try {
    nextAi = applyMove(engineNow, appliedMove)
  } catch {
    // 兜底（2026-10-03）：AI 若给出非法着法，applyMove 会抛错。此处**绝不能再判和终局** ——
    // 历史开局库含马腿被挡的脏马步（加权命中概率 1.09%），一旦命中玩家就会看到棋局莫名中止，
    // 这正是「象棋功能缺失」的现场。数据层已清洗（fix-book-illegal.ts）+ 查表二次校验
    // （xiangqi_opening_book.ts），这里是第三道防线：退化为「任取一个合法着法」让对局继续。
    const legal = legalMoves(engineNow, s.turn)
    let recovered: EngineState | null = null
    for (const m of legal) {
      try {
        recovered = applyMove(engineNow, m)
        appliedMove = m
        break
      } catch {
        // 该着法仍不可用，试下一个
      }
    }
    if (!recovered) {
      // 连一个合法着法都走不出 → 确实是困毙，判当前行棋方负
      s.phase = 'FINISHED'
      s.endedAt = nowMs + aiElapsed
      s.result = { winner: s.turn === 'r' ? 'b' : 'r', reason: 'STALEMATE' }
      return null
    }
    console.warn('[xiangqi] AI 着法非法已兜底为合法着法，对局继续')
    nextAi = recovered
  }
  s.lastMove = appliedMove
  s.history.push({
    from: [appliedMove.from.r, appliedMove.from.c],
    to: [appliedMove.to.r, appliedMove.to.c],
    redMs: s.clockRedMs,
    blackMs: s.clockBlackMs,
    by: aiSeat,
  })
  s.turn = nextAi.turn
  s.board = Array.from(nextAi.board)
  s.halfMoveClock = nextAi.halfMoveClock
  s.fullMoveNumber = nextAi.fullMoveNumber
  s.seen = nextAi.seen
  s.result = nextAi.result
  s.check = !nextAi.result ? isInCheck(nextAi, nextAi.turn) : false
  s.undoable = SEAT_BLACK // AI 走完后，黑棋有悔棋权
  s.turnStartedAt = nowMs + aiElapsed
  if (s.result) {
    s.phase = 'FINISHED'
    s.endedAt = nowMs + aiElapsed
    return null
  }
  return { aiMove: appliedMove, aiElapsedMs: aiElapsed }
}

// ---------------------------------------------------------------------------
// 终局处理（认输 / 求和 / 超时）
// ---------------------------------------------------------------------------

export function applyResign(s: XiangqiState, seat: number, nowMs: number): MoveResult {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能认输', state: s }
  s.phase = 'FINISHED'
  s.endedAt = nowMs
  s.result = { winner: colorOf(seat) === 'r' ? 'b' : 'r', reason: 'RESIGN' }
  return { ok: true, final: s.result, state: s }
}

export interface DrawResult {
  ok: boolean
  accepted?: boolean // PVP 对方同意 / PVE 直接生效
  error?: string
  final?: { winner: Color | null; reason: GameResultReason }
  state: XiangqiState
}

/**
 * AI 和棋评估（PVE）：局面评分决定是否接受。
 * - AI 明显占优（> +200）→ 拒绝
 * - AI 明显劣势（< -200）→ 接受
 * - 均势（-200 ~ +200）→ 约 50% 接受
 * 延时 3–6s 制造「AI 在思考」拟人感。
 */
export function aiDrawDecision(state: XiangqiState, aiSeat: number): { accept: boolean; thinkMs: number } {
  const aiColor = colorOf(aiSeat)
  const eng = toEngineState(state)
  const score = evaluate(eng)
  // AI 视角：红方 + 分，黑方 - 分；aiColor 转正
  const aiScore = aiColor === 'r' ? score : -score
  const thinkMs = 3000 + Math.floor(Math.random() * 3000) // 3–6s
  if (aiScore > 200) return { accept: false, thinkMs }
  if (aiScore < -200) return { accept: true, thinkMs }
  return { accept: Math.random() < 0.5, thinkMs }
}

/** 求和：PVP 首次提出挂起等对方；对方再次调用同意即和棋。PVE 由 AI 评估后延时生效 */
export function applyDraw(s: XiangqiState, seat: number, nowMs: number): DrawResult {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能求和', state: s }
  if (s.mode === 'PVE') {
    // AI 求和决策：到点前显示「考虑中」，到点后异步判和/拒绝
    const aiSeat = seat === SEAT_RED ? SEAT_BLACK : SEAT_RED
    const { accept, thinkMs } = aiDrawDecision(s, aiSeat)
    s.aiDrawUntil = nowMs + thinkMs
    return { ok: true, accepted: false, state: s }
  }
  if (s.drawOffer === seat) {
    // 自己重复点求和 → 取消
    s.drawOffer = null
    return { ok: true, accepted: false, state: s }
  }
  if (s.drawOffer === null) {
    s.drawOffer = seat
    return { ok: true, accepted: false, state: s }
  }
  // 对方已提出 → 同意
  s.phase = 'FINISHED'
  s.endedAt = nowMs
  s.result = { winner: null, reason: 'DRAW_AGREEMENT' }
  return { ok: true, accepted: true, final: s.result, state: s }
}

/** 拒绝求和（PVP：对方已发请求，本方点「不同意」） */
export function applyDrawReject(
  s: XiangqiState,
  seat: number
): { ok: boolean; error?: string; state: XiangqiState } {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (s.drawOffer === null) return { ok: false, error: '当前没有待处理的求和请求', state: s }
  if (s.drawOffer === seat) return { ok: false, error: '不能拒绝自己的求和请求', state: s }
  s.drawOffer = null
  return { ok: true, state: s }
}

export interface UndoResult {
  ok: boolean
  accepted?: boolean // PVP 对方同意后真正撤子
  error?: string
  state: XiangqiState
}

/**
 * 悔棋：
 *   PVE：直接撤 2 手（AI 1 + 玩家 1；若玩家只走 1 手则撤 1 手）
 *   PVP：首次提出挂起等对方；对方同意后撤 2 手（双方各一手）
 * 实现：从 history 重放重建局面（seen/时钟天然正确），无需快照
 */
export function applyUndo(s: XiangqiState, seat: number, nowMs: number, gameMinutes?: number): UndoResult {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (seat !== SEAT_RED && seat !== SEAT_BLACK) return { ok: false, error: '观战者不能悔棋', state: s }
  if (s.result) return { ok: false, error: '对局已结束', state: s }

  if (s.mode === 'PVE') {
    return doUndo(s, 2, nowMs, gameMinutes ? gameMinutes * 60 * 1000 : undefined)
  }

  // PVP：同意/拒绝逻辑优先
  if (s.undoRequest !== null) {
    if (s.undoRequest === seat) {
      s.undoRequest = null // 自己重复点 → 取消
      return { ok: true, accepted: false, state: s }
    }
    // 对方同意 → PVP 只撤 1 步（自己刚走的那步）
    return doUndo(s, 1, nowMs, gameMinutes ? gameMinutes * 60 * 1000 : undefined)
  }

  // PVP：发起悔棋请求 — 只有刚走完棋的一方才能发起（撤回自己刚走的那1步）
  if (s.history.length < 1 || colorOf(seat) === s.turn) {
    return { ok: false, error: '该悔棋时才能发起悔棋', state: s }
  }
  s.undoRequest = seat
  return { ok: true, accepted: false, state: s }
}

/** 拒绝悔棋（PVP：对方已发请求，本方点「拒绝」） */
export function applyUndoReject(s: XiangqiState, seat: number): { ok: boolean; error?: string; state: XiangqiState } {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  if (s.undoRequest === null) return { ok: false, error: '当前没有待处理的悔棋请求', state: s }
  if (s.undoRequest === seat) return { ok: false, error: '不能拒绝自己的请求', state: s }
  s.undoRequest = null
  return { ok: true, state: s }
}

/** 从 history 重放 n 步（实际撤销步数 = min(n, history.length)），重建局面与时钟 */
function doUndo(s: XiangqiState, n: number, nowMs: number, initialMs?: number): UndoResult {
  const drop = Math.min(n, s.history.length)
  if (drop === 0) return { ok: false, error: '还没有可悔的棋', state: s }
  const keep = s.history.slice(0, s.history.length - drop)
  const remaining = s.history[s.history.length - drop - 1] // 撤销后最后一步（时钟恢复参考）

  // 重放：初始局面 → 依次走 keep 中的每步
  let eng = createInitialState()
  for (const h of keep) {
    eng = applyMove(eng, { from: { r: h.from[0], c: h.from[1] }, to: { r: h.to[0], c: h.to[1] } })
  }

  s.board = Array.from(eng.board)
  s.turn = eng.turn
  s.halfMoveClock = eng.halfMoveClock
  s.fullMoveNumber = eng.fullMoveNumber
  s.seen = eng.seen
  s.result = eng.result // 重放后不可能有终局（保持 keep 时未终局）
  s.history = keep
  s.lastMove = remaining ? { from: { r: remaining.from[0], c: remaining.from[1] }, to: { r: remaining.to[0], c: remaining.to[1] } } : null
  // 时钟恢复到撤销前最后一步结束时的状态；若撤到开局，恢复初始局时
  s.clockRedMs = remaining ? remaining.redMs : (initialMs ?? 15 * 60 * 1000)
  s.clockBlackMs = remaining ? remaining.blackMs : (initialMs ?? 15 * 60 * 1000)
  s.turnStartedAt = nowMs
  s.check = isInCheck(eng, eng.turn)
  s.undoRequest = null
  s.undoable = null // 悔棋后清除悔棋权
  s.drawOffer = null
  return { ok: true, accepted: true, state: s }
}

/** 超时判负（轮询时调用） */
export function applyTimeout(s: XiangqiState, timeout: TimeoutInfo, nowMs: number): MoveResult {
  if (s.phase !== 'PLAYING') return { ok: false, error: '对局未进行中', state: s }
  s.phase = 'FINISHED'
  s.endedAt = nowMs
  s.result = { winner: timeout.seat === SEAT_RED ? 'b' : 'r', reason: 'TIMEOUT' }
  return { ok: true, final: s.result, state: s }
}

// ---------------------------------------------------------------------------
// 聊天
// ---------------------------------------------------------------------------

export function addMessage(s: XiangqiState, msg: ChatMsg): XiangqiState {
  s.messages = [...s.messages, msg].slice(-50)
  return s
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export interface PlayerView {
  seat: number | null
  name: string
  isSelf: boolean
  role: string // PLAYER | SPECTATOR
  ready: boolean
}

export interface RoomView {
  code: string
  status: string
  /** 房间标记：EVALUATE=评测对战 | COIN=金币竞技场 | null=普通房（人机 PVE 不设标） */
  matchType: string | null
  /** 房间状态版本号（单调递增：任何棋盘/消息/成员/设置变更都会 +1）。
   *  前端用途：① 丢弃乱序晚到的旧响应（防棋子弹回）② 轮询版本短路（未变化不传全量）。 */
  version: number
  hostUserId: string
  xiangqiCode: string | null
  mode: 'PVP' | 'PVE'
  aiLevel: AiLevel | null
  aiLevelName: string | null
  isHost: boolean
  mySeat: number | null
  myRole: string
  /** 本机双人：当前账号占用的所有席位（[1,2]）；普通对局即 [mySeat] 或 [] */
  mySeats: number[]
  /** 本机双人模式（同一设备轮流下） */
  passAndPlay: boolean
  players: PlayerView[]
  gameMinutes: number
  stepSeconds: number
  game: {
    phase: RoomPhase
    board: number[]
    turn: Color
    result: { winner: Color | null; reason: GameResultReason } | null
    lastMove: Move | null
    check: boolean
    clockRedMs: number
    clockBlackMs: number
    turnStartedAt: number | null
    stepSeconds: number
    myTurn: boolean
    canMove: boolean // 选手 + 轮到 + 未结束
    readyRed: boolean
    readyBlack: boolean
    drawOffer: number | null
    undoRequest: number | null
    /** 有悔棋权的 seat（对方走完棋后设置，我方可请求悔那步） */
    undoable: number | null
    messages: ChatMsg[]
    history: HistoryEntry[]
    startedAt: number | null
    endedAt: number | null
  } | null
}

export function buildView(
  room: { code: string; status: string; gameMinutes: number; stepSeconds: number; hostUserId: string; xiangqiCode?: string | null; matchType?: string | null; version: number },
  players: { userId: string; seat: number | null; role: string; name: string }[],
  userId: string | null,
  state: XiangqiState | null
): RoomView {
  const me = players.find((p) => p.userId === userId)
  const mySeat = me?.seat ?? null
  const myRole = me?.role ?? (userId ? 'SPECTATOR' : 'GUEST')
  const myPlayers = players.filter((p) => p.userId === userId)
  const mySeats = myPlayers.map((p) => p.seat).filter((s): s is number => s !== null)
  const playerViews: PlayerView[] = players.map((p) => ({
    seat: p.seat,
    name: p.name,
    isSelf: p.userId === userId,
    role: p.role,
    ready: state ? (p.seat === SEAT_RED ? state.readyRed : p.seat === SEAT_BLACK ? state.readyBlack : false) : false,
  }))

  const game = state
    ? {
        phase: state.phase,
        board: state.board,
        turn: state.turn,
        result: state.result,
        lastMove: state.lastMove,
        check: state.check,
        clockRedMs: state.clockRedMs,
        clockBlackMs: state.clockBlackMs,
        turnStartedAt: state.turnStartedAt,
        stepSeconds: room.stepSeconds,
        myTurn: state.phase === 'PLAYING' && mySeat !== null && mySeat !== undefined
          && state.turn === colorOf(mySeat) && !state.result,
        canMove: myRole === 'PLAYER' && state.phase === 'PLAYING' && mySeat !== null && mySeat !== undefined
          && state.turn === colorOf(mySeat) && !state.result,
        readyRed: state.readyRed,
        readyBlack: state.readyBlack,
        drawOffer: state.drawOffer,
        undoRequest: state.undoRequest,
        undoable: state.undoable,
        messages: state.messages,
        history: state.history,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
      }
    : null

  return {
    code: room.code,
    status: room.status,
    matchType: room.matchType ?? null,
    version: room.version,
    hostUserId: room.hostUserId,
    xiangqiCode: room.xiangqiCode ?? null,
    mode: state?.mode ?? 'PVP',
    aiLevel: state?.aiLevel ?? null,
    aiLevelName: state?.aiLevel ? AI_LEVEL_NAMES[state.aiLevel] : null,
    isHost: room.hostUserId === userId,
    mySeat,
    myRole,
    mySeats,
    passAndPlay: state?.passAndPlay ?? false,
    players: playerViews,
    gameMinutes: room.gameMinutes,
    stepSeconds: room.stepSeconds,
    game,
  }
}

// ---------------------------------------------------------------------------
// FEN 导出（战绩记录 / 调试）
// ---------------------------------------------------------------------------

export function fenOfState(s: XiangqiState): string {
  return stateToFen(toEngineState(s))
}

export function keyOfState(s: XiangqiState): string {
  return boardKey(toEngineState(s))
}
