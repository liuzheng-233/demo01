-- ============================================================================
-- 往 products 表插入「中国象棋 AI 引擎技能包」SKILL 类型商品
-- 在 ECS 上执行（复制粘贴一段就行）：
--   docker exec -i postgres psql -U myqwb -d myqwb_cn
--   然后把下面 BEGIN..COMMIT 整块粘进去回车
-- ============================================================================

BEGIN;

-- 清理旧条目（如果有 slug 冲突）
DELETE FROM products WHERE slug = 'xiangqi-game-skill';

-- 插入（category_id 留 NULL 走默认"其他"分类，避免因 categories 表结构不同报错）
INSERT INTO products (
  id, type, title, title_en, slug, description, description_en,
  cover_image, price, currency, is_free, is_published, is_featured,
  author, category_id, file_url, file_size, custom_link,
  access_type, download_limit, validity_days,
  guest_access, user_access, member_access,
  metadata, seo_title, seo_description, language,
  agent_type, view_count,
  created_at, updated_at
) VALUES (
  gen_random_uuid()::text,
  'SKILL',
  '中国象棋 AI 引擎技能包',
  'Xiangqi Game Skill (Chinese Chess Engine + AI)',
  'xiangqi-game-skill',
  '零依赖 TypeScript 规则引擎 + 三档 AI + 《橘中秘》开局库 + React 棋盘示例。直接复制进项目即可构建象棋人机/对战功能，附完整自对弈自检。',
  'Zero-dependency TypeScript Xiangqi engine with 3-level AI, Jue Zhong Mi opening book, and React board example. Copy into your project and build a chess game immediately.',
  NULL,
  0, 'CNY',
  TRUE, TRUE, TRUE,
  'liuzheng-233',
  NULL,
  NULL, NULL,
  'https://github.com/liuzheng-233/demo01',
  'FREE',
  -1, NULL,
  'FREE', 'FREE', 'FREE',
  '{}',
  '中国象棋 AI 引擎 Skill 下载',
  '中国象棋 TypeScript 引擎、三档 AI、React 棋盘、零依赖、《橘中秘》开局库',
  'zh',
  'OPEN_SOURCE',
  0,
  now(), now()
);

COMMIT;

-- 验证：
SELECT id, title, slug, type, is_published, custom_link
  FROM products WHERE slug = 'xiangqi-game-skill';
-- 期望看到 1 行，custom_link = https://github.com/liuzheng-233/demo01
