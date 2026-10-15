#!/usr/bin/env node
/**
 * selfcheck.mjs — 象棋引擎零依赖自检
 *
 * 运行：
 *   node scripts/selfcheck.mjs                 # Node >= 22.18
 *   node --experimental-strip-types scripts/selfcheck.mjs   # Node 22.6 ~ 22.17
 *
 * 检查内容：
 *   1. 初始局面常量（32 子 / 每方 44 合法着法 / FEN 往返一致）
 *   2. 规则要点：蹩马腿、塞象眼/象不过河、炮隔架吃子、帅将对脸（飞将）禁手
 *   3. 开局库：初始局面与左路镜像开局（炮八平五）均有棋谱应手
 *   4. AI 三档（easy/medium/hard）均能在时限内返回合法着法
 *   5. easy 自对弈完整一局：每步合法、FEN 往返一致、正常终局或达步数上限
 *
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
await register(pathToFileURL(join(here, 'ts-resolve-loader.mjs')))

const engineDir = pathToFileURL(join(here, '..', 'engine') + '/').href
const rules = await import(engineDir + 'rules.ts')
const ai = await import(engineDir + 'ai.ts')
const book = await import(engineDir + 'openingBook.ts')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  \u2713 ${name}`)
}

const {
  createInitialState,
  fenToState,
  stateToFen,
  legalMoves,
  applyMove,
  isInCheck,
  idx,
  CELL_EMPTY,
} = rules

console.log('\n[1/5] 初始局面与 FEN')
{
  const s0 = createInitialState()
  let pieces = 0
  for (const v of s0.board) if (v !== CELL_EMPTY) pieces++
  check('初始局面共 32 枚棋子', () => assert.equal(pieces, 32))
  check('红方初始合法着法 44 手', () => assert.equal(legalMoves(s0, 'r').length, 44))
  check('黑方初始合法着法 44 手', () => assert.equal(legalMoves(s0, 'b').length, 44))
  check('FEN 往返序列化一致', () => {
    const fen = stateToFen(s0)
    const back = fenToState(fen)
    assert.ok(Buffer.from(back.board).equals(Buffer.from(s0.board)))
    assert.equal(back.turn, s0.turn)
  })
}

console.log('\n[2/5] 规则要点')
{
  // 双方老将分置 c0/c1 避免飞将干扰；红马 (5,4)，红兵 (4,4) 蹩马腿
  const s = fenToState('k8/9/9/9/4P4/4N4/9/9/9/1K7 w - 0 1')
  const horseTargets = new Set(
    legalMoves(s, 'r').filter((m) => m.from.r === 5 && m.from.c === 4).map((m) => `${m.to.r},${m.to.c}`),
  )
  check('蹩马腿：(3,3)/(3,5) 不可达', () => {
    assert.ok(!horseTargets.has('3,3'))
    assert.ok(!horseTargets.has('3,5'))
  })
  check('蹩马腿：其余六个日字点可达', () => {
    for (const t of ['4,2', '4,6', '6,2', '6,6', '7,3', '7,5']) assert.ok(horseTargets.has(t), t)
  })
}

{
  // 红相 (7,2)；(8,1) 塞 (9,0) 象眼，(6,3) 塞 (5,4) 象眼
  const s = fenToState('k8/9/9/9/9/9/3P5/2B6/1P7/1K7 w - 0 1')
  const eleTargets = new Set(
    legalMoves(s, 'r').filter((m) => m.from.r === 7 && m.from.c === 2).map((m) => `${m.to.r},${m.to.c}`),
  )
  check('塞象眼：(9,0)/(5,4) 不可飞', () => {
    assert.ok(!eleTargets.has('9,0'))
    assert.ok(!eleTargets.has('5,4'))
  })
  check('象走田：(9,4)/(5,0) 可飞', () => {
    assert.ok(eleTargets.has('9,4'))
    assert.ok(eleTargets.has('5,0'))
  })
  // 红相在 (5,2)，(3,0)/(3,4) 已过河，必须排除
  const s2 = fenToState('k8/9/9/9/9/2B6/9/9/9/1K7 w - 0 1')
  const cross = legalMoves(s2, 'r').filter((m) => m.from.r === 5 && m.from.c === 2 && m.to.r <= 4)
  check('相不过河：没有落点越过河界', () => assert.equal(cross.length, 0))
}

{
  // 红炮 (5,4)：黑卒 (3,4) 为炮架，黑卒 (2,4) 可被隔架吃；(4,4) 可空走
  const s = fenToState('k8/9/4p4/4p4/9/4C4/9/9/9/1K7 w - 0 1')
  const cannonLandings = new Set(
    legalMoves(s, 'r').filter((m) => m.from.r === 5 && m.from.c === 4).map((m) => `${m.to.r},${m.to.c}`),
  )
  check('炮：空走 (4,4) 合法', () => assert.ok(cannonLandings.has('4,4')))
  check('炮：不能直接落在炮架 (3,4)', () => assert.ok(!cannonLandings.has('3,4')))
  check('炮：隔架吃子 (2,4) 合法', () => assert.ok(cannonLandings.has('2,4')))
}

{
  // 飞将：黑将 (0,3)、红帅 (9,3)，红车 (5,3) 是唯一间隔
  const s = fenToState('3k5/9/9/9/9/3R5/9/9/9/3K5 w - 0 1')
  const rookMoves = legalMoves(s, 'r').filter((m) => m.from.r === 5 && m.from.c === 3)
  check('帅将对脸：车离开 3 路的走法全部非法', () => {
    assert.ok(rookMoves.length > 0)
    assert.ok(rookMoves.every((m) => m.to.c === 3))
  })
}

console.log('\n[3/5] 开局库（《橘中秘》+ 左右镜像）')
{
  check(`棋谱条目 ${book.BOOK_SIZE} 条，镜像展开后 ${book.LINE_BOOK_SIZE} 局面`, () => {
    assert.ok(book.BOOK_SIZE > 3000)
    assert.ok(book.LINE_BOOK_SIZE > book.BOOK_SIZE)
  })
  check('初始局面有棋谱应手', () => assert.ok(book.lookupBookMoves(createInitialState()).length > 0))
  check('左路镜像开局（炮八平五）也能命中棋谱', () => {
    let s = createInitialState()
    s = applyMove(s, { from: { r: 7, c: 7 }, to: { r: 7, c: 4 } })
    assert.ok(book.lookupBookMoves(s).length > 0)
  })
}

console.log('\n[4/5] AI 三档选着')
{
  // 初始局面三档都走开局库（瞬时），验证选着合法
  const s0 = createInitialState()
  for (const level of ['easy', 'medium', 'hard']) {
    const t0 = Date.now()
    const r = ai.chooseAiMove(s0, level)
    const ms = Date.now() - t0
    const legalSet = new Set(legalMoves(s0, 'r').map((m) => `${m.from.r}${m.from.c}${m.to.r}${m.to.c}`))
    check(`${level} 初始局面返回棋谱着法（${ms}ms，book=${!!r.book}）`, () => {
      assert.ok(r, `${level} 应返回着法`)
      assert.ok(legalSet.has(`${r.move.from.r}${r.move.from.c}${r.move.to.r}${r.move.to.c}`))
    })
  }
  // 一个不在棋谱中的中局局面：逼 medium/hard 真正进入搜索引擎
  const mid = fenToState('3k5/9/9/4r4/9/2N1C4/9/3R5/9/3K5 w - 0 1')
  for (const level of ['medium', 'hard']) {
    const t0 = Date.now()
    const r = ai.chooseAiMove(mid, level)
    const ms = Date.now() - t0
    const legalSet = new Set(legalMoves(mid, 'r').map((m) => `${m.from.r}${m.from.c}${m.to.r}${m.to.c}`))
    check(`${level} 非棋谱局面走搜索（${ms}ms，depth=${r.depth}，nodes=${r.nodes}）`, () => {
      assert.ok(r && !r.book, `${level} 应来自搜索`)
      assert.ok(legalSet.has(`${r.move.from.r}${r.move.from.c}${r.move.to.r}${r.move.to.c}`))
      assert.ok(ms <= ai.AI_LEVELS[level].timeLimitMs + 800, '超时余量内')
      assert.ok(r.depth >= 2)
    })
  }
}

console.log('\n[5/5] easy 自对弈一局')
{
  let state = createInitialState()
  const MAX_PLIES = 100
  let ply = 0
  let checks = 0
  while (!state.result && ply < MAX_PLIES) {
    const level = 'easy'
    const choice = ai.chooseAiMove(state, level)
    assert.ok(choice, `第 ${ply + 1} 手 AI 未返回着法（但无终局结果）`)
    const legal = legalMoves(state, state.turn)
    assert.ok(
      legal.some((m) => m.from.r === choice.move.from.r && m.from.c === choice.move.from.c &&
        m.to.r === choice.move.to.r && m.to.c === choice.move.to.c),
      `第 ${ply + 1} 手 AI 着法不合法`,
    )
    state = applyMove(state, choice.move)
    // FEN 往返一致（seen/result 不参与 FEN）
    const rt = fenToState(stateToFen(state))
    assert.ok(Buffer.from(rt.board).equals(Buffer.from(state.board)), `第 ${ply + 1} 手 FEN 往返盘面不一致`)
    if (isInCheck(state, state.turn)) checks++
    ply++
  }
  check(`完成 ${ply} 半回合，期间出现 ${checks} 次将军局面`, () => assert.ok(ply > 30))
  if (state.result) {
    const who = state.result.winner === null ? '和棋' : state.result.winner === 'r' ? '红胜' : '黑胜'
    check(`对局正常终局：${who}（${state.result.reason}）`, () => true)
  } else {
    check(`到达 ${MAX_PLIES} 半回合上限仍无终局（引擎未报错即通过）`, () => true)
  }
}

console.log(`\n全部通过：${passed} 项检查 \u2714\n`)
