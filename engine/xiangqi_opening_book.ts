/**
 * xiangqi_opening_book.ts - 中国象棋开局库查表实现
 *
 * 数据见 ./openingBookData（《橘中秘》棋谱档，紧凑编码）。
 * 选着策略（与生产环境一致）：
 *   ① 棋谱分支 ≥3 → 在棋谱着法里等概率随机选一步（不按权重）；
 *   ② 棋谱分支不足 → 返回全部棋谱着法，由 ai.ts 用「合法着法 + 开局常识」
 *      自行构造多样性候选池（详见 ai.ts §开局候选池）；
 *   ③ 库未覆盖 → 返回空数组，交给搜索引擎。
 *
 * 左右镜像（关键）：
 *   《橘中秘》棋谱清一色是右路开局（炮二平五 / 马二进三 / 相三进五…），
 *   玩家走左路对称开局（炮八平五 / 马八进七 / 相七进五…）也必须命中。
 *   棋盘左右严格对称（列 c ↔ 8-c；九宫 3~5 列自对称），加载时把每条
 *   棋谱局面镜像后一并入表（对称局面自动去重合并）——覆盖翻倍、数据零膨胀。
 *
 * 防御性校验：对选中的每一步再用本引擎 legalMoves 校验，
 * 脏数据永不进对局；校验不过即跳过，最终回退正常搜索。
 */
import bookData, { type CompactBookEntry } from './openingBookData'
import { legalMoves, ROWS, COLS, type Move, type GameState } from './rules'

const BOOK_DATA: CompactBookEntry[] = bookData

/** 局面键字符表：格子编码 0-14 → 单字符 */
const ALPHA = '0123456789abcdef'

/** 构造局面键：turn + 90 个单字符格子值 */
function stateBoardKey(s: GameState): string {
  let k = s.turn
  for (let i = 0; i < ROWS * COLS; i++) k += ALPHA[s.board[i]]
  return k
}

/** 左右镜像一个局面键（列 c ↔ COLS-1-c，行不变；turn 不变） */
function mirrorKey(key: string): string {
  if (key.length !== ROWS * COLS + 1) return key
  const turn = key[0]
  const cells = key.slice(1)
  let out = turn
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) out += cells[r * COLS + (COLS - 1 - c)]
  }
  return out
}

/** 左右镜像一个格子下标（idx = r*COLS+c → r*COLS+(COLS-1-c)） */
function mirrorIdx(i: number): number {
  const r = Math.floor(i / COLS)
  const c = i % COLS
  return r * COLS + (COLS - 1 - c)
}

interface LineMove {
  from: number
  to: number
}

/**
 * 构建棋谱索引，加载时展开左右镜像。
 * 同一局面多次命中（原局面与镜像局面重合，如初始局面）时按 from/to 去重合并。
 */
function buildIndex(): Map<string, LineMove[]> {
  const map = new Map<string, LineMove[]>()
  const add = (key: string, moves: LineMove[]) => {
    const cur = map.get(key)
    if (cur) {
      for (const m of moves) {
        if (!cur.some((x) => x.from === m.from && x.to === m.to)) cur.push(m)
      }
    } else {
      map.set(key, [...moves])
    }
  }
  for (const e of BOOK_DATA) {
    if (e.m.length === 0) continue
    const ms = e.m.map((x) => ({ from: x.f, to: x.t }))
    add(e.k, ms)
    add(mirrorKey(e.k), ms.map((m) => ({ from: mirrorIdx(m.from), to: mirrorIdx(m.to) })))
  }
  return map
}

const BOOK_MAP = buildIndex()

/** 含棋谱着法的局面数（含镜像展开，供诊断/测试） */
export const LINE_BOOK_SIZE = BOOK_MAP.size

/** 原始棋谱条目数（镜像展开前） */
export const BOOK_SIZE = BOOK_DATA.length

/** 脏着法告警去重（同一脏数据只报一次，避免日志刷屏） */
const warnedDirty = new Set<string>()
function warnDirty(from: number, to: number): void {
  const k = `${from}->${to}`
  if (warnedDirty.has(k)) return
  warnedDirty.add(k)
  console.warn(`[xiangqi] 开局库脏着法已拦截: ${k}（回退搜索）`)
}

/** 把库内 (from,to) 下标列表转成引擎 Move，并逐条用 legalMoves 校验（脏数据永不进对局） */
function toLegalMoves(state: GameState, list: LineMove[] | undefined, legal: Set<string>): Move[] {
  if (!list || list.length === 0) return []
  const out: Move[] = []
  for (const s of list) {
    const move: Move = {
      from: { r: Math.floor(s.from / COLS), c: s.from % COLS },
      to: { r: Math.floor(s.to / COLS), c: s.to % COLS },
    }
    const key = `${move.from.r},${move.from.c}->${move.to.r},${move.to.c}`
    if (!legal.has(key)) {
      warnDirty(s.from, s.to)
      continue
    }
    if (out.some((m) => m.from.r === move.from.r && m.from.c === move.from.c && m.to.r === move.to.r && m.to.c === move.to.c)) {
      continue
    }
    out.push(move)
  }
  return out
}

/**
 * 查棋谱着法：返回该局面下《橘中秘》棋谱记录的全部应着（已用引擎 legalMoves 校验）。
 * 无棋谱记录时返回空数组 —— 此时开局多样性由 ai.ts 用「合法着法 + 开局常识」自行构造。
 */
export function lookupBookMoves(state: GameState): Move[] {
  const key = stateBoardKey(state)
  if (!BOOK_MAP.has(key)) return []
  const legal = new Set(
    legalMoves(state, state.turn).map((m) => `${m.from.r},${m.from.c}->${m.to.r},${m.to.c}`),
  )
  return toLegalMoves(state, BOOK_MAP.get(key), legal)
}

/** 查开局库（旧 API）：返回棋谱着法里随机一步，无棋谱则 null。 */
export function lookupBookMove(state: GameState): Move | null {
  const line = lookupBookMoves(state)
  if (line.length === 0) return null
  return line[Math.floor(Math.random() * line.length)]
}
