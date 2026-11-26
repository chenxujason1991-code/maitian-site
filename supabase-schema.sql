-- 麦田网站 · Supabase 建表 SQL
--
-- 用途：万一 Supabase 项目需要重建，照这个文件在 SQL Editor 里执行即可。
-- 字段来源：逐行核对 maitian-supabase.js / maitian-space-sync.js / maitian-app.js
-- 里的读写字段，不是凭空写的。
--
-- 执行前请注意：
--   1. 这是"按代码推断"的结构，不是从线上数据库导出的。执行前先对比现有表，
--      避免覆盖。已有表就跳过 CREATE，只补缺的列。
--   2. 6 张表分两组：互动区 4 张（feed_posts / museum_posts / stories / profiles），
--      阅读空间 2 张（space_posts / space_replies）。
--   3. RLS（行级安全）不在这里写。当前前端用 publishable key 直接读写，
--      说明 RLS 大概率没开或全放行——这是待处理的安全问题，别在这份文件里
--      顺手打开，否则线上会立刻读不到数据。

-- ========== 互动区 ==========

-- 麦田动态：id 由前端 Date.now() 生成（毫秒时间戳），所以是 bigint 不是自增
create table if not exists feed_posts (
  id          bigint primary key,
  author      text,
  text        text,
  images      jsonb  default '[]'::jsonb,
  created_at  text,
  likes       integer default 0,
  liked_by    jsonb  default '[]'::jsonb,
  comments    jsonb  default '[]'::jsonb
);

-- 烦恼博物馆：text 字段存的是整条记录的 JSON 字符串（见 mtPushMuseum）
create table if not exists museum_posts (
  id          bigint primary key,
  author      text,
  text        text,
  created_at  text,
  likes       integer default 0,
  liked_by    jsonb  default '[]'::jsonb,
  comments    jsonb  default '[]'::jsonb,
  replies     jsonb  default '[]'::jsonb
);

-- 麦田故事：text 同样存整条 JSON 字符串，official 标记是否官方精选
create table if not exists stories (
  id          bigint primary key,
  author      text,
  text        text,
  images      jsonb  default '[]'::jsonb,
  created_at  text,
  likes       integer default 0,
  liked_by    jsonb  default '[]'::jsonb,
  comments    jsonb  default '[]'::jsonb,
  official    boolean default false
);

-- 用户：nickname 是主键（登录靠昵称），password 存的是 _simpleHash 的结果
-- 注意：当前是弱哈希（32 位、无加盐），不是明文，但也不可靠。待升级。
create table if not exists profiles (
  nickname    text primary key,
  password    text,
  avatar      text   default 'emoji',
  bio         text   default '',
  points      integer default 0,
  badges      jsonb  default '[]'::jsonb,
  task_joined jsonb  default '[]'::jsonb,
  task_done   jsonb  default '[]'::jsonb,
  exchanges   jsonb  default '[]'::jsonb,
  history     jsonb  default '[]'::jsonb
);

-- ========== 阅读空间 ==========

-- 空间记录：id 由云端生成（bigint 自增），pad 发布后拿回真实 id
create table if not exists space_posts (
  id          bigint generated always as identity primary key,
  space       text   default '小田阅读空间',
  body        text   default '',
  images      jsonb  default '[]'::jsonb,
  sign_label  text   default '',
  person      text   default '',
  created_at  timestamptz default now(),
  hidden      boolean default false
);

-- 回应：post_id 关联 space_posts.id
create table if not exists space_replies (
  id           bigint generated always as identity primary key,
  post_id      bigint references space_posts(id) on delete cascade,
  author       text default '',
  body         text default '',
  created_at   timestamptz default now(),
  from_outside boolean default false
);

-- ========== 索引 ==========

create index if not exists idx_space_posts_created  on space_posts(created_at desc);
create index if not exists idx_space_posts_hidden   on space_posts(hidden);
create index if not exists idx_space_replies_post   on space_replies(post_id);
