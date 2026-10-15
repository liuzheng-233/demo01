# UI 与前后端集成指南

生产环境验证过的交互架构。最小可运行版见 `examples/react-board.tsx`，本文讲上线版本该怎么做。

## 1. 分工原则

```
玩家点击
  ↓
前端 legalMoves 本地预判 → 高亮合法落点 / 本地乐观渲染（手感：零延迟）
  ↓ POST /api/xiangqi/move { roomId, from, to }
服务端 isLegalMove 权威校验 → applyMove →（PVE）chooseAiMove → 落库
  ↓ 返回最新 GameState + result + AI 着法
前端以服务端状态为准重绘；非法提交丢弃乐观结果并拉取权威状态
```

- 前端预判**只用于交互反馈**，永远不要信任前端的合法性结论（防外挂/防并发双击）。
- AI 调用必须在服务端：搜索占满一个 CPU 核 0.5–2.5 秒；前端直跑会冻屏，且搜索引擎不应下发给客户端（可被刷接口滥用）。
- PVE 流程建议服务端在**同一个请求**里把 AI 应手走完再返回（人类玩家的步 + AI 步原子返回），避免前端轮询；AI 思考态可以在前端先显示假 loading。
- 给 AI 搜索加并发保护（如每房间互斥锁 + 3 秒总超时），2 核机器上避免多个搜索同时跑。

Next.js Route Handler 骨架：

```ts
// app/api/xiangqi/move/route.ts
import { applyMove, isLegalMove } from '@/xiangqi/engine/rules'
import { chooseAiMove } from '@/xiangqi/engine/ai'

export async function POST(req: Request) {
  const { roomId, from, to } = await req.json()
  const room = await loadRoom(roomId)                 // 你的存储层
  const state = hydrate(room)                         // number[] → Uint8Array
  const move = { from, to }
  if (!isLegalMove(state, move)) return Response.json({ error: 'ILLEGAL' }, { status: 400 })

  let next = applyMove(state, move)
  let aiReply = null
  if (room.mode === 'PVE' && !next.result) {
    const choice = chooseAiMove(next, room.aiLevel)   // 服务端 CPU 密集调用
    if (choice) { next = applyMove(next, choice.move); aiReply = choice }
  }
  await saveRoom(roomId, next)
  return Response.json({ state: serialize(next), aiReply, result: next.result })
}
```

序列化注意：`board` 是 `Uint8Array`，`JSON.stringify` 会变成 `{"type":"Buffer",...}`（Node）或普通数组（视环境）。落库/传输前显式 `Array.from(state.board)` 或 `[...state.board]`；恢复时 `new Uint8Array(arr)`。`seen` 是普通对象可直接存 JSONB。

## 2. 棋盘渲染（零素材，SVG + CSS）

`examples/react-board.tsx` 已给出完整可抄版本，要点：

- 外层 `aspect-ratio: 9/10`；横线 10 条贯通、竖线在河界断开（y 0.5–4.45 / 5.55–9.5）；九宫斜线 4 条；炮位/兵位用小十字或圆圈。
- 棋子是带汉字的圆 div：红方渐变朱红描深红边、黑方石灰描黑边；一个 `PIECE_TEXT` 映射表解决全部 32 子，不需要任何图片。
- 定位用**百分比 + transform 平移**，不要用 left/top 过渡：left/top 每帧触发 layout+paint，整盘动画会闪；transform 只走合成层。
- 执黑翻转：显示坐标 = `{ r: 9-r, c: 8-c }`，自己永远在屏幕下方；引擎坐标永远不翻，只翻渲染层。

生产版增强（来自线上组件的经验）：

- **稳定棋子 id**：棋子 React key 用「初始局面编号 0-31」而不是格子坐标；从初始局面重放 history 推导每枚子的当前位置，被吃即移除。这样走子时 DOM 节点复用，CSS transition 才能表现棋子平滑滑行、被吃子直接消失。
- 只给「真实发生位移」的棋子挂 transition：棋盘宽度因滚动条/容器查询变化时，未动棋子应瞬间吸附，否则全盘 32 子一起被动画成「呼吸抖动」。
- 合法落点：空位画实心绿点（约格子 30%），吃子位画红色圆环（约 92%）；选中棋子金色描环；上一步起终点加小蓝点。
- 轮询场景用「history 长度 + 末步坐标」做 useMemo 内容级缓存键，不要依赖数组引用，否则每轮询整盘重放。

## 3. 终局与将军反馈

- 将军：`isInCheck(state, state.turn)` 为 true 时棋盘中央脉冲「將軍！」。
- 将死/困毙：读 `state.result`。注意终局特效要是**瞬时事件**而非持久状态——只在 result「刚刚由空变非空」的那一次播放（视频/动画/音效），刷新页面或重进房间不能重播；给特效组件加自增事件 id，播完父组件清空。
- 绝杀视频类素材（如果要加）：进房时预加载（隐藏 video 元素真实缓冲），播放前等 `canplay`/readyState≥3 再加 1.5s 兜底，别用固定 CSS 延时，否则弱网全程黑屏；移动端视频必须 `muted + playsInline + autoplay`（带声自动播放会触发「要用流量播放？」弹窗），声音走独立音频。

## 4. 音效（可选）

事件清单：落子、吃子、將軍、绝杀、胜、负、选中。实现建议：

- 落子/吃子用真实木质采样（一个短 mp3/ogg 足够），按棋子重量调音量；將軍/吃子可加语音（中文「將軍！」注意 TTS 容易把 jiàng（军衔）读错，要第一声 jiāng）。
- 敌我音色区分：同一事件，我方用用户偏好音色、对方用相反音色，闭眼能听出谁吃的子。
- 全部音频文件 URL 带版本号 query（`?v=3`），换文件必须递增，否则 HTTP 缓存导致新声不生效；开关存 localStorage。
- 无素材时用 WebAudio 合成（短促木质敲击 = 噪声 burst + 快速衰减包络；锣声 = 两个失谐正弦 + 长衰减），生产代码里保留合成兜底。

## 5. 时钟与房间能力

引入 `engine/state.ts` 可直接获得：

- 双时钟：每方独立局时钟（开局 N 分钟）+ 步时钟（每步 M 秒）；走完一手扣本步用时并重置对方步时钟；任一归零判负。服务端权威，前端只做倒计时显示。
- 模式：PVP / PVE（AI 同步应手）/ passAndPlay（同设备双人）。
- 认输、求和（PVP 需对方同意，PVE 直接成和）、悔棋（PVE 直接撤，PVP 需对方同意；history 里存了每步双方时钟，撤步完整恢复）。
- `viewFor` 给选手/观战组装不同视图（观战不可操作、终局后可见完整信息）。
- 你需要自备：房间存储、按 roomId 互斥、周期性超时扫描器（定时扫「PLAYING 且 turnStartedAt + stepSeconds 已过」的房间）。

## 6. 性能与部署注意（低配 2 核 2G 服务器实测）

- AI 搜索是主要 CPU 开销：hard 中局约 1.8-2.5s。同机多房间时限制并发搜索数（如 1-2），超时降级而非排队堆积。
- 棋盘/棋子**不要**用 next/image 这类实时图片优化管道：每个棋子请求触发一次实时转码，首屏 32 个子能把 CPU 打满。棋子用 CSS 绘制或普通 `<img>` 静态文件。
- 运行时上传到 public 的静态图，standalone 服务器启动时才扫一次白名单；批量传图后需重启进程（与象棋无关，但同栈常见坑）。
- 开局库数据约 420KB，模块加载时构建索引（镜像展开到 6543 局面），只需一次；不要把建索引放进每次请求。

## 7. 交付自测清单

- [ ] 红/黑（翻转棋盘）两个视角都能完整下完一盘
- [ ] 拖时间/双击/落后状态下提交：非法走法返回 400，界面不花
- [ ] AI 思考期间禁点棋盘；PVE 玩家走完后 AI 应手自动出现
- [ ] 将军有提示；将死/困毙/三种和棋原因文案正确；刷新页面不重播绝杀特效
- [ ] 弱网（DevTools 限速）下音频/视频不误播、不阻塞下棋
- [ ] 手机 Safari/Chrome 竖屏棋盘比例正确、无横向滚动
