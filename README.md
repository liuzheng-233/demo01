# xiangqi-game · 中国象棋引擎与 AI 技能包

一个**生产级**中国象棋（Xiangqi / 象棋）TypeScript 引擎 + AI + React 棋盘的 **Agent Skill 技能包**。
规则引擎零依赖、AI 在低配 2 核服务器即可流畅运行，附带经过真人对局反复修正的开局逻辑与完整事故注释。

---

### 🎯 想要「开箱即玩」的象棋对弈？

👉 **完整在线版请访问 「资源汇」官网 [www.51999888.com](https://www.51999888.com)**

- 在线象棋对弈：与 AI 三档难度对弈 / 观战
- 更多 Skill 与智能体下载：访问官网下载中心 → Skill 分类
- 小说阅读、AI 短剧工具、学习资料：全部免费

---

## 特性

- **完整规则**：将帅对脸（飞将）禁手、蹩马腿、塞象眼、相不过河、炮隔架吃子、兵过河横走、禁送将、将死与**困毙判负**、120 半回合自然限着、重复局面判和、无子可胜判和
- **三档 AI**：negamax + Alpha-Beta(PVS) + 迭代加深 + 静态吃子延伸（quiescence）+ Zobrist 置换表 + Killer moves + MVV-LVA + null-move；初级 / 中级 / 高级（0.5s / 1.5s / 2.5s 时限，超时自动降级）
- **《橘中秘》开局库**：3283 局面 / 3581 着法古谱棋谱，左右镜像自动展开覆盖对称开局（6543 索引局面），未命中自动回退搜索；开局多样性池 + 亏本兑换拦截，AI 不会「开局瞎走炮、重复乱走」
- **房间状态机**（可选）：PVP / PVE / 同机双人、局时钟 + 步时钟、认输 / 求和 / 悔棋、观战视图，纯函数零 DB 依赖
- **零素材 UI**：SVG 画线 + CSS 汉字棋子，自包含 React 示例复制即用
- **FEN 互通**：`fenToState` / `stateToFen`，初始局面标准 FEN
- **零依赖自检**：23 项规则/库/AI 断言 + AI 自对弈完整一局，`node scripts/selfcheck.mjs` 一键验证

---

> 💡 **关于本仓库的来源**：规则引擎源码提取自 [www.51999888.com](https://www.51999888.com) 象棋模块的线上生产实现，经过数月真人对局反复修正。在你的项目里如果遇到使用问题，欢迎到官网社区发帖交流。

## 目录结构

```
xiangqi-game/
├── SKILL.md                       # Agent 技能入口（含触发场景与工作流）
├── engine/                        # 可直接复制进项目的引擎源码（TypeScript，无第三方依赖）
│   ├── rules.ts                   # 规则引擎（棋盘编码/合法走法/将军终局/FEN）
│   ├── ai.ts                      # AI 搜索引擎 + 评估 + 三档难度
│   ├── state.ts                   # 房间状态机（时钟/认输/悔棋，可选）
│   ├── openingBook.ts             # 开局库入口
│   ├── xiangqi_opening_book.ts    # 棋谱查表 + 镜像展开
│   └── openingBookData.ts         # 《橘中秘》棋谱数据（紧凑编码，约 420KB）
├── examples/
│   └── react-board.tsx            # 人机对弈 React 组件（内联样式，无 Tailwind/无图片）
├── references/
│   ├── engine-api.md              # 全部 API 与坐标/编码约定
│   ├── ai-tuning.md               # 难度调参 + 性能优化事故档案
│   └── ui-integration.md          # 前后端分工/棋盘交互/音效/部署
└── scripts/
    ├── selfcheck.mjs              # 引擎自检（Node ≥ 22.18，无需 npm install）
    └── ts-resolve-loader.mjs      # Node 直跑 .ts 的极简 resolve 钩子
```

## 作为 Skill 安装

### Trae

```bash
# 项目级（随仓库共享给团队）
git clone https://github.com/liuzheng-233/demo01.git .trae/skills/xiangqi-game

# 或用户级（所有项目可用，Trae CN）
git clone https://github.com/liuzheng-233/demo01.git "$HOME/.trae-cn/skills/xiangqi-game"
# Trae 国际版：$HOME/.trae/skills/xiangqi-game
```

也可以下载本仓库 zip，把根目录（含 `SKILL.md` 的那一层）整个放进上述 skills 目录，重启或刷新助手即可。
安装后对助手说「帮我做一个中国象棋人机对弈页面」「加个象棋规则校验」之类的话即可触发。

### 其他 Agent / IDE

任何遵循「skills 目录 + SKILL.md」约定的助手，把本文件夹放进它的 skills 目录即可；
SKILL.md 是标准 YAML frontmatter + Markdown，正文引用的 `engine/`、`references/`、`examples/` 均为普通文件。

## 作为引擎库使用

### 1. 复制引擎

把 `engine/` 目录整个复制到你的项目（Next.js / Vite / Node 服务端均可，保持文件相对关系）。
只用规则校验可只复制 `rules.ts`；要 AI 则五个文件都要。

### 2. 验证

```bash
node scripts/selfcheck.mjs
# Node 22.6 ~ 22.17 需加 flag：
node --experimental-strip-types scripts/selfcheck.mjs
```

预期输出 23 项检查全部 ✓，并演示一局 easy 自对弈正常将死终局。无需 `npm install`。

### 3. 最小代码

```ts
import { createInitialState, legalMoves, applyMove } from './engine/rules'
import { chooseAiMove } from './engine/ai'

let state = createInitialState()

// 玩家提交一步
const move = { from: { r: 7, c: 1 }, to: { r: 7, c: 4 } } // 炮二平五
if (!legalMoves(state, state.turn).some(
  (m) => JSON.stringify(m) === JSON.stringify(move),
)) throw new Error('非法走法')
state = applyMove(state, move)

// AI 应手（'easy' | 'medium' | 'hard'）
const reply = chooseAiMove(state, 'hard')
if (reply) state = applyMove(state, reply.move)

console.log(state.result) // null 进行中；{ winner, reason } 终局
```

### 4. React 页面

复制 `examples/react-board.tsx` 到项目并修正 `../engine/*` 导入路径，然后：

```tsx
import XiangqiMini from './xiangqi/react-board'
export default function Page() {
  return <XiangqiMini level="hard" humanColor="r" />
}
```

> 上线建议把 AI 移到服务端 API（搜索会占满一个 CPU 核 0.5–2.5 秒），前端只做合法落点预判。
> 完整的前后端分工、时钟、音效、动画与部署要点见 [references/ui-integration.md](references/ui-integration.md)。

## 坐标与 FEN 速查

- 10×9 棋盘，`row 0` 黑方底线（顶部）/ `row 9` 红方底线（底部），`index = r*9+c`
- 格子编码：0 空；1-7 红 K A B N R C P；8-14 黑 K A B N R C P
- 初始 FEN：`rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - 0 1`

完整 API 见 [references/engine-api.md](references/engine-api.md)，调棋力见 [references/ai-tuning.md](references/ai-tuning.md)。

## 技术说明与边界

- 引擎是休闲对局强度（hard 约等于有一定棋力的业余爱好者；评估表为子力 + 位置表 + 威胁，非职业引擎），目标是在极低算力下给出稳定、像人、不胡闹的应手。
- 长将 / 长捉按「重复局面 3 次判和」简化处理，未实现严格竞赛规则的「长将判负」裁决；正式赛事场景需自行扩展。
- AI 搜索无 WebAssembly / Worker 依赖，直接跑在 JS 主线程；生产部署请放服务端并加并发互斥。
- 代码注释中保留了完整的线上事故记录（马腿方向 bug、PST 镜像方向、开局只动炮修复、TT 绝杀分校正等），改动引擎前请先读注释。

## 致谢

- 开局棋谱源自明代古谱《橘中秘》（公有领域传统文化遗产）。
- 引擎源码整理自 [www.51999888.com](https://www.51999888.com) 象棋模块的生产实现。

## License

[MIT](LICENSE)
