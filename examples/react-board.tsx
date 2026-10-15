"use client";

/**
 * react-board.tsx — 中国象棋人机对弈最小可运行示例（自包含，无 Tailwind / 无图片）
 *
 * 用法（Next.js / Vite / Remix 均可）：
 *   1. 把本技能包 engine/ 整个目录复制到项目里（如 src/xiangqi/engine）
 *   2. 修改下方 import 路径指向复制后的 rules / ai
 *   3. <XiangqiMini level="hard" /> 即可渲染一盘人机对局
 *
 * 生产环境建议（本示例为可读性简化，完整方案见 references/ui-integration.md）：
 *   - AI 搜索放服务端（easy/medium/hard 时限 0.5/1.5/2.5 秒，占用一个 CPU 核），
 *     前端只做合法落点预判，提交后服务端权威裁决
 *   - 把 useState<GameState> 换成带历史/时钟/认输求和的 state.ts 房间状态机
 */
import { useMemo, useState } from "react";
import {
  type GameState,
  type Move,
  type Color,
  createInitialState,
  applyMove,
  legalMoves,
  isInCheck,
  cellColor,
  cellType,
  idx,
  ROWS,
  COLS,
} from "../engine/rules";
import { chooseAiMove, type AiLevel } from "../engine/ai";

// ---------------------------------------------------------------------------
// 棋子汉字（红大写兵种 / 黑异体字）
// ---------------------------------------------------------------------------
const PIECE_TEXT: Record<string, { r: string; b: string }> = {
  K: { r: "帥", b: "將" },
  A: { r: "仕", b: "士" },
  B: { r: "相", b: "象" },
  N: { r: "馬", b: "馬" },
  R: { r: "車", b: "車" },
  C: { r: "炮", b: "炮" },
  P: { r: "兵", b: "卒" },
};

interface Pos {
  r: number;
  c: number;
}

export default function XiangqiMini({
  level = "medium",
  humanColor = "r",
}: {
  level?: AiLevel;
  humanColor?: Color;
}) {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [selected, setSelected] = useState<Pos | null>(null);
  const [thinking, setThinking] = useState(false);

  // 选中棋子的合法落点（前端预判，纯展示用途）
  const targets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      legalMoves(state, state.turn)
        .filter((m) => m.from.r === selected.r && m.from.c === selected.c)
        .map((m) => `${m.to.r},${m.to.c}`),
    );
  }, [state, selected]);

  const humanTurn = state.turn === humanColor && !state.result && !thinking;

  function applyAiReply(next: GameState) {
    if (next.result) {
      setState(next);
      return;
    }
    setThinking(true);
    // 放到宏任务里，让浏览器先绘制"思考中"状态；真实项目请改为服务端 API 调用
    setTimeout(() => {
      const reply = chooseAiMove(next, level);
      setState((cur) => {
        // 防止超时/重开后旧结果覆盖新状态
        if (cur !== next) return cur;
        setThinking(false);
        return reply ? applyMove(next, reply.move) : next;
      });
    }, 30);
  }

  function onCellClick(r: number, c: number) {
    if (!humanTurn) return;
    const cell = state.board[idx(r, c)];
    if (selected && targets.has(`${r},${c}`)) {
      const move: Move = { from: selected, to: { r, c } };
      setSelected(null);
      const next = applyMove(state, move);
      setState(next);
      applyAiReply(next);
      return;
    }
    if (cell !== 0 && cellColor(cell) === state.turn) {
      setSelected({ r, c });
    } else {
      setSelected(null);
    }
  }

  function restart() {
    setState(createInitialState());
    setSelected(null);
    setThinking(false);
  }

  const inCheck = !state.result && isInCheck(state, state.turn);
  const flip = humanColor === "b";
  const view = (r: number, c: number): Pos => (flip ? { r: ROWS - 1 - r, c: COLS - 1 - c } : { r, c });

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>
          {state.result
            ? state.result.winner === null
              ? "和棋"
              : `${state.result.winner === "r" ? "红方" : "黑方"}胜（${reasonText(state.result.reason)}）`
            : `${state.turn === "r" ? "红方" : "黑方"}行棋${inCheck ? " · 将军！" : ""}${thinking ? " · AI 思考中…" : ""}`}
        </strong>
        <button onClick={restart} style={{ padding: "4px 12px", cursor: "pointer" }}>
          重开
        </button>
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "9 / 10",
          background: "#e8c98f",
          borderRadius: 8,
          boxShadow: "inset 0 0 24px rgba(120,80,20,.35)",
          userSelect: "none",
        }}
      >
        {/* 棋盘线（SVG 百分比坐标系 9x10） */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 9 10" preserveAspectRatio="none">
          {Array.from({ length: 10 }, (_, r) => (
            <line key={`h${r}`} x1={0.5} y1={r + 0.5} x2={8.5} y2={r + 0.5} stroke="#5b3a1e" strokeWidth={0.05} />
          ))}
          {Array.from({ length: 9 }, (_, c) => (
            <g key={`v${c}`}>
              <line x1={c + 0.5} y1={0.5} x2={c + 0.5} y2={4.45} stroke="#5b3a1e" strokeWidth={0.05} />
              <line x1={c + 0.5} y1={5.55} x2={c + 0.5} y2={9.5} stroke="#5b3a1e" strokeWidth={0.05} />
            </g>
          ))}
          <line x1={3.5} y1={0.5} x2={5.5} y2={2.5} stroke="#5b3a1e" strokeWidth={0.045} />
          <line x1={5.5} y1={0.5} x2={3.5} y2={2.5} stroke="#5b3a1e" strokeWidth={0.045} />
          <line x1={3.5} y1={7.5} x2={5.5} y2={9.5} stroke="#5b3a1e" strokeWidth={0.045} />
          <line x1={5.5} y1={7.5} x2={3.5} y2={9.5} stroke="#5b3a1e" strokeWidth={0.045} />
        </svg>

        {/* 楚河汉界 */}
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <span style={{ letterSpacing: "1.2em", marginRight: "-1.2em", color: "rgba(91,58,30,.7)", fontWeight: 700, fontSize: "clamp(10px,3vw,15px)" }}>
            楚河　漢界
          </span>
        </div>

        {/* 交叉点：点击区 + 合法落点 */}
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const r = Math.floor(i / COLS);
          const c = i % COLS;
          const d = view(r, c);
          const isTarget = targets.has(`${r},${c}`);
          const occupied = state.board[i] !== 0;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r},${c}`}
              onClick={() => onCellClick(r, c)}
              style={{
                position: "absolute",
                left: `${((d.c + 0.5) / COLS) * 100}%`,
                top: `${((d.r + 0.5) / ROWS) * 100}%`,
                width: `${100 / COLS}%`,
                height: `${100 / ROWS}%`,
                transform: "translate(-50%,-50%)",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: humanTurn ? "pointer" : "default",
              }}
            >
              {isTarget && (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    margin: "auto",
                    width: occupied ? "90%" : "30%",
                    height: occupied ? "90%" : "30%",
                    borderRadius: "50%",
                    background: occupied ? "transparent" : "rgba(16,185,129,.75)",
                    border: occupied ? "3px solid rgba(239,68,68,.85)" : "none",
                  }}
                />
              )}
            </button>
          );
        })}

        {/* 棋子 */}
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const r = Math.floor(i / COLS);
          const c = i % COLS;
          const cell = state.board[i];
          if (cell === 0) return null;
          const color = cellColor(cell)!;
          const type = cellType(cell)!;
          const d = view(r, c);
          const isSel = selected?.r === r && selected?.c === c;
          return (
            <div
              key={`p-${r}-${c}-${type}`}
              style={{
                position: "absolute",
                left: `${((d.c + 0.5) / COLS) * 100}%`,
                top: `${((d.r + 0.5) / ROWS) * 100}%`,
                width: `${100 / COLS}%`,
                height: `${100 / ROWS}%`,
                transform: "translate(-50%,-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  width: "92%",
                  height: "92%",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "clamp(14px,4.5vw,26px)",
                  fontWeight: 700,
                  color: color === "r" ? "#b91c1c" : "#1c1917",
                  background: color === "r"
                    ? "radial-gradient(circle at 35% 30%, #fef2f2, #fecaca)"
                    : "radial-gradient(circle at 35% 30%, #fafaf9, #d6d3d1)",
                  border: `2px solid ${color === "r" ? "#991b1b" : "#1c1917"}`,
                  boxShadow: isSel
                    ? "0 0 0 3px rgba(251,191,36,.9), 0 2px 4px rgba(0,0,0,.35)"
                    : "0 2px 4px rgba(0,0,0,.35)",
                }}
              >
                {PIECE_TEXT[type][color]}
              </span>
            </div>
          );
        })}

        {/* 将军提示 */}
        {inCheck && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <span style={{ background: "rgba(220,38,38,.85)", color: "#fff", fontWeight: 700, padding: "6px 16px", borderRadius: 999, animation: "xk-pulse 1s infinite" }}>
              将军！
            </span>
          </div>
        )}
      </div>

      <p style={{ color: "#666", fontSize: 12, marginTop: 8 }}>
        人执{humanColor === "r" ? "红先手" : "黑后手"} · AI 难度 {level}；引擎零素材依赖，棋子棋盘全部 CSS/SVG 渲染。
      </p>
      <style>{`@keyframes xk-pulse{50%{opacity:.45}}`}</style>
    </div>
  );
}

function reasonText(reason: string): string {
  switch (reason) {
    case "CHECKMATE":
      return "将死";
    case "STALEMATE":
      return "困毙";
    case "DRAW_REPETITION":
      return "重复局面";
    case "DRAW_NATURAL":
      return "自然限着";
    case "DRAW_INSUFFICIENT":
      return "无子可胜";
    default:
      return reason;
  }
}
