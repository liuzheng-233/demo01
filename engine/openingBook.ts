/**
 * 中国象棋 AI 开局库 — 对外入口
 *
 * 实际数据与查表实现见 ./xiangqi_opening_book（内联 BOOK_DATA，同步查表）。
 * 本文件仅做一层薄封装，供 ai.ts / 测试统一从 './openingBook' 导入。
 */
import { type GameState } from './rules'
import {
  lookupBookMove as doLookup,
  lookupBookMoves as doLookupAll,
  BOOK_SIZE,
  LINE_BOOK_SIZE,
} from './xiangqi_opening_book'

export { BOOK_SIZE, LINE_BOOK_SIZE }

/** 查开局库（棋谱着法）：命中返回随机一着，未命中返回 null（同步，供 AI 引擎调用） */
export function lookupBookMove(state: GameState) {
  return doLookup(state)
}

/** 查该局面的全部棋谱着法（供 AI 引擎判断棋谱分支是否充足） */
export function lookupBookMoves(state: GameState) {
  return doLookupAll(state)
}
