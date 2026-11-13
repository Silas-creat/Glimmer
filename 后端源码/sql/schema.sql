-- ============================================================================
--  「陪着」数据库表结构
--  说明：这个文件只负责建表，建库由 scripts/init-db.js 负责
--  字符集统一 utf8mb4，才能正常存 emoji（🍾♥ 这些）
-- ============================================================================
-- 注意：这里不需要写 SET NAMES —— init-db.js 建立连接时已经指定了 utf8mb4，
-- 而且 scripts/init-db.js 是按分号切分 SQL 的，加了会多出一条独立语句。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. users 用户主表
--    手机号即账号。手机号是登录凭据，绝对不能给别人看，
--    所以对外展示一律用 uid（随机号），不用手机号。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部主键',
  `phone`       VARCHAR(11)  NOT NULL                COMMENT '手机号（登录用，私密）',
  `uid`         VARCHAR(16)  NOT NULL                COMMENT '对外展示的ID，如 34954130101',
  `nickname`    VARCHAR(32)  NOT NULL DEFAULT ''     COMMENT '昵称',
  `status`      ENUM('normal','muted','banned') NOT NULL DEFAULT 'normal' COMMENT 'normal正常 muted禁言 banned封禁',
  `last_login`  DATETIME(3)     NULL                    COMMENT '最后登录时间',
  `session_version` INT UNSIGNED NOT NULL DEFAULT 0     COMMENT '每次登录 +1；token 里带着它，旧设备立刻失效',
  `session_device`  VARCHAR(64)  NULL                    COMMENT '最后一次登录的设备标识（同设备重登不踢自己）',
  `created_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_phone` (`phone`),
  UNIQUE KEY `uk_uid` (`uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户主表';

-- ----------------------------------------------------------------------------
-- 2. user_profiles 用户资料（和 users 一对一，拆开是因为很多字段可以不填）
--    zodiac 星座、province 省份 —— 这两个决定用户进哪个群聊房间
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_profiles` (
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `avatar`      VARCHAR(255) NOT NULL DEFAULT ''  COMMENT '头像URL或dataURL',
  `signature`   VARCHAR(255) NOT NULL DEFAULT ''  COMMENT '个性签名',
  `addr`        VARCHAR(64)  NOT NULL DEFAULT ''  COMMENT '用户自己填的地址',
  `gender`      ENUM('unknown','male','female') NOT NULL DEFAULT 'unknown',
  `birth_year`  SMALLINT     NULL                 COMMENT '出生年份，用来算同龄群',
  `zodiac`      VARCHAR(8)   NOT NULL DEFAULT ''  COMMENT '星座：白羊/金牛/...',
  `province`    VARCHAR(32)  NOT NULL DEFAULT ''  COMMENT '省份，用来进同省群',
  `cover`       VARCHAR(255) NOT NULL DEFAULT ''  COMMENT '个人主页背景图',
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`),
  KEY `idx_zodiac` (`zodiac`),
  KEY `idx_province` (`province`),
  CONSTRAINT `fk_profile_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户资料';

-- ----------------------------------------------------------------------------
-- 3. sms_codes 验证码
--    开发期用万能码，这张表是为了以后接真实短信服务用的，
--    现在也照常写入，方便你在数据库里看到"谁什么时候发了码"。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sms_codes` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone`       VARCHAR(11) NOT NULL,
  `code`        VARCHAR(6)  NOT NULL,
  `used`        TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '是否已被使用',
  `expires_at`  DATETIME(3)    NOT NULL,
  `created_at`  DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_phone_time` (`phone`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='手机验证码';

-- ----------------------------------------------------------------------------
-- 4. diaries 日记  ← 对应前端 data.js 里的 DIARY_DATA + localStorage 的 diary_entries
--    is_public=1 公开（能被看到、能评论），0 私密（只有自己看）
--    date_key 是 '2026-10-16' 这种格式，一个人一天一篇（唯一索引保证）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `diaries` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `text`        TEXT         NOT NULL              COMMENT '日记正文',
  `img`         VARCHAR(255) NOT NULL DEFAULT ''   COMMENT '配图URL',
  `is_public`   TINYINT(1)   NOT NULL DEFAULT 0    COMMENT '1公开 0私密',
  `date_key`    CHAR(10)     NOT NULL              COMMENT 'YYYY-MM-DD，一天一篇',
  `like_count`  INT UNSIGNED NOT NULL DEFAULT 0    COMMENT '点赞数（冗余字段，查列表快）',
  `comment_count` INT UNSIGNED NOT NULL DEFAULT 0  COMMENT '评论数（冗余字段）',
  `view_count`  INT UNSIGNED NOT NULL DEFAULT 0    COMMENT '浏览数',
  `created_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_date` (`user_id`, `date_key`),
  KEY `idx_public_time` (`is_public`, `created_at`),
  CONSTRAINT `fk_diary_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日记';

-- Companion drafts persist across processes. Preparation never writes diaries.
CREATE TABLE IF NOT EXISTS `ai_diary_drafts` (
  `id` CHAR(36) NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `date_key` CHAR(10) NOT NULL,
  `text` TEXT NOT NULL,
  `sources_json` JSON NOT NULL,
  `provider` ENUM('local','deepseek') NOT NULL,
  `status` ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  `diary_id` BIGINT UNSIGNED NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `confirmed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_draft_owner` (`user_id`, `created_at`),
  KEY `idx_draft_expiry` (`status`, `expires_at`),
  CONSTRAINT `fk_draft_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_draft_diary` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='本人确认前的私密日记草稿';

-- ----------------------------------------------------------------------------
-- 5. likes 点赞     ← 替代 localStorage 的 my_likes
-- 6. favorites 收藏 ← 替代 my_saves
-- 7. follows 关注   ← 替代 my_follows
--    三张表结构几乎一样：(谁) 对 (哪篇日记/哪个人) 做了动作
--    唯一索引保证同一人不能重复点赞
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `likes` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL COMMENT '谁点的',
  `diary_id`   BIGINT UNSIGNED NOT NULL COMMENT '点的哪篇',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_diary` (`user_id`, `diary_id`),
  KEY `idx_diary` (`diary_id`),
  CONSTRAINT `fk_like_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_like_diary` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日记点赞';

CREATE TABLE IF NOT EXISTS `favorites` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `diary_id`   BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_diary` (`user_id`, `diary_id`),
  KEY `idx_diary` (`diary_id`),
  CONSTRAINT `fk_fav_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_fav_diary` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日记收藏';

CREATE TABLE IF NOT EXISTS `follows` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '关注发起人',
  `target_id`   BIGINT UNSIGNED NOT NULL COMMENT '被关注的人',
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_target` (`user_id`, `target_id`),
  KEY `idx_target` (`target_id`),
  CONSTRAINT `fk_follow_user`   FOREIGN KEY (`user_id`)   REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_follow_target` FOREIGN KEY (`target_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='关注关系';

-- ----------------------------------------------------------------------------
-- 8. comments 评论  ← 对应 diary-public.html 里的评论面板（前端现在只在本地假加一条）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `comments` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `diary_id`      BIGINT UNSIGNED NOT NULL,
  `user_id`       BIGINT UNSIGNED NOT NULL COMMENT '评论者',
  `parent_id`     BIGINT UNSIGNED NULL     COMMENT '回复哪条评论，NULL表示直接评论日记',
  `content`       VARCHAR(500) NOT NULL,
  `like_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `status`        ENUM('normal','hidden') NOT NULL DEFAULT 'normal' COMMENT '被举报后置为hidden',
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_diary_time` (`diary_id`, `created_at`),
  CONSTRAINT `fk_comment_diary` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comment_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='评论';

-- ----------------------------------------------------------------------------
-- 9. blessings 祝福
--    from_user → to_user：我给别人留的鼓励（前端 bless.html / bless-sent.html）
--    is_read 用来做"我收到的祝福"红点
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `blessings` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_user`  BIGINT UNSIGNED NOT NULL COMMENT '送出祝福的人',
  `to_user`    BIGINT UNSIGNED NOT NULL COMMENT '收到祝福的人',
  `content`    VARCHAR(1000) NOT NULL,
  `is_read`    TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_to_read` (`to_user`, `is_read`),
  KEY `idx_from` (`from_user`),
  CONSTRAINT `fk_bless_from` FOREIGN KEY (`from_user`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bless_to`   FOREIGN KEY (`to_user`)   REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='祝福留言';

-- ----------------------------------------------------------------------------
-- 10. bottles 漂流瓶  ← 对应 weiguang.html
--     user_id 是"扔瓶子的人"
--     status: floating 还在海里漂 / removed 被扔的人或管理员撤回
--     is_anon 匿名：漂流瓶本来就是扔给陌生人的，很多平台都允许匿名
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `bottles` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '扔瓶子的人',
  `content`     VARCHAR(1000) NOT NULL,
  `is_anon`     TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1匿名（漂流瓶默认匿名）',
  `pick_count`  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '被捞次数',
  `status`      ENUM('floating','removed') NOT NULL DEFAULT 'floating' COMMENT '漂着/被撤回',
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_status_time` (`status`, `created_at`),
  KEY `idx_user` (`user_id`),
  CONSTRAINT `fk_bottle_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='漂流瓶';

-- ----------------------------------------------------------------------------
-- 10-2. bottle_picks 捞瓶记录
--
--  为什么要单独一张表，而不是在 bottles 上放一个 picked_by？
--    放在 bottles 上意味着【一个瓶子只能被一个人捞到】。
--    但这个产品是"把心愿扔进海里，随机推送给别人"——
--    一条温暖的留言被 10 个人看到，比只被 1 个人看到要好。
--    所以设计成"一个瓶子可以被多人捞到"，每次捞记一行。
--
--  顺便解决的问题：
--    1. 同一个人不会反复捞到同一个瓶子（唯一索引保证）
--    2. 能查询"我捞到过哪些瓶子"
--    3. bottles.pick_count 是这里的冗余计数，查列表快
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `bottle_picks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bottle_id`  BIGINT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NOT NULL COMMENT '谁捞的',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bottle_user` (`bottle_id`, `user_id`),
  KEY `idx_user_time` (`user_id`, `created_at`),
  CONSTRAINT `fk_pick_bottle` FOREIGN KEY (`bottle_id`) REFERENCES `bottles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pick_user`   FOREIGN KEY (`user_id`)   REFERENCES `users` (`id`)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='捞漂流瓶记录';

-- ----------------------------------------------------------------------------
-- 11. chat_rooms 群聊房间（固定 4 个，也支持以后加）
--     同龄群 / 拾趣 / 同省群 / 星迹
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_rooms` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(32)  NOT NULL COMMENT '房间代号，如 age',
  `name`        VARCHAR(64)  NOT NULL COMMENT '显示名，如 同龄群',
  `kind`        ENUM('age','interest','province','zodiac','custom') NOT NULL DEFAULT 'custom',
  `desc`        VARCHAR(255) NOT NULL DEFAULT '',
  `sort`        INT NOT NULL DEFAULT 0,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='群聊房间';

-- ----------------------------------------------------------------------------
-- 12. chat_members 群里的人
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_members` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `room_id`    INT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `joined_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_read_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已读到哪条消息，用来算未读数',
  `muted_until` DATETIME(3) NULL COMMENT '被机器人禁言到什么时候',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_room_user` (`room_id`, `user_id`),
  CONSTRAINT `fk_member_room` FOREIGN KEY (`room_id`) REFERENCES `chat_rooms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_member_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='群成员';

-- ----------------------------------------------------------------------------
-- 13. chat_messages 群消息
--     type=sys 是系统提示（"这里是同龄群，先随便说两句吧"），
--     type=violation_notice 是机器人判定违规后的提示
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `room_id`    INT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NULL COMMENT 'NULL 表示系统消息',
  `type`       ENUM('text','sys') NOT NULL DEFAULT 'text',
  `content`    VARCHAR(1000) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_room_id` (`room_id`, `id`),
  CONSTRAINT `fk_msg_room` FOREIGN KEY (`room_id`) REFERENCES `chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='群聊消息';

-- ----------------------------------------------------------------------------
-- 14. messages 私信（一对一）
--     前端 diary-public.html 的"发私信"面板
--     约定 user_a < user_b，保证一对人只有一行会话，不会重复
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `conversations` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_a`      BIGINT UNSIGNED NOT NULL COMMENT '小的那个 user_id',
  `user_b`      BIGINT UNSIGNED NOT NULL COMMENT '大的那个 user_id',
  `last_msg`    VARCHAR(255) NOT NULL DEFAULT '',
  `last_from`   BIGINT UNSIGNED NULL COMMENT '最后一条消息的发送者',
  `last_time`   DATETIME(3) NULL,
  `unread_a`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'a 的未读数',
  `unread_b`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'b 的未读数',
  `blocked_by`  BIGINT UNSIGNED NULL COMMENT '谁拉黑了这段会话（NULL=没拉黑）',
  `deleted_by_a` DATETIME(3) NULL COMMENT 'a 什么时候把会话从自己列表里删了',
  `deleted_by_b` DATETIME(3) NULL COMMENT 'b 什么时候把会话从自己列表里删了',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pair` (`user_a`, `user_b`),
  CONSTRAINT `fk_conv_a` FOREIGN KEY (`user_a`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_conv_b` FOREIGN KEY (`user_b`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信会话';

CREATE TABLE IF NOT EXISTS `messages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conv_id`     BIGINT UNSIGNED NOT NULL,
  `from_user`   BIGINT UNSIGNED NOT NULL,
  `to_user`     BIGINT UNSIGNED NOT NULL,
  `content`     VARCHAR(2000) NOT NULL,
  `is_sys`      TINYINT(1) NOT NULL DEFAULT 0
                COMMENT '1=系统提示消息（加好友后的问候，渲染成灰色居中）',
  `is_read`     TINYINT(1) NOT NULL DEFAULT 0,
  `status`      ENUM('normal','blocked') NOT NULL DEFAULT 'normal'
                COMMENT 'blocked=被机器人拦下的内容（留痕但不展示给对方）',
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_conv_time` (`conv_id`, `id`),
  KEY `idx_from` (`from_user`),
  CONSTRAINT `fk_msg_conv` FOREIGN KEY (`conv_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信消息';

-- ----------------------------------------------------------------------------
-- 15. friends 好友关系（互相关注 / 打招呼后成为好友）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `friends` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '发起方',
  `friend_id`   BIGINT UNSIGNED NOT NULL COMMENT '对方',
  `remark`      VARCHAR(32) NOT NULL DEFAULT '' COMMENT '备注名',
  `status`      ENUM('pending','accepted','blocked') NOT NULL DEFAULT 'pending',
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pair` (`user_id`, `friend_id`),
  KEY `idx_friend` (`friend_id`),
  CONSTRAINT `fk_fr_user`   FOREIGN KEY (`user_id`)   REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fr_friend` FOREIGN KEY (`friend_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='好友关系';

-- ----------------------------------------------------------------------------
-- 16. ai_messages AI 聊天记录  ★关键★
--     "同一个号换一个设备还能继续聊天"就靠这张表：
--     聊天不再存浏览器，而是存服务器，按 user_id 取。
--     role: system / user / assistant
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `ai_messages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `role`        ENUM('system','user','assistant') NOT NULL,
  `content`     TEXT NOT NULL,
  `token_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`, `id`),
  CONSTRAINT `fk_ai_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI聊天记录（记忆）';

-- ----------------------------------------------------------------------------
-- 17. ai_profiles AI 对每个人的长期记忆摘要
--     聊天记录太多塞不进大模型，就定期压缩成一段摘要放这里
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `ai_profiles` (
  `user_id`     BIGINT UNSIGNED NOT NULL,
  `summary`     TEXT NOT NULL COMMENT '关于这个人的记忆摘要',
  `msg_count`   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '累计聊了多少轮',
  `summary_until_id` BIGINT UNSIGNED NOT NULL DEFAULT 0
                COMMENT '已压缩进 summary 的最后一条消息 id（游标，别用条数当游标）',
  `last_chat`   DATETIME(3) NULL,
  `updated_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_aip_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI长期记忆';

-- ----------------------------------------------------------------------------
-- 18. reports 举报记录（设置页有"举报记录"入口）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `reports` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '举报人',
  `target_type` ENUM('diary','comment','user','message') NOT NULL,
  `target_id`   BIGINT UNSIGNED NOT NULL,
  `reason`      VARCHAR(255) NOT NULL DEFAULT '',
  `status`      ENUM('pending','handled','rejected') NOT NULL DEFAULT 'pending',
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  CONSTRAINT `fk_report_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='举报';

-- ----------------------------------------------------------------------------
-- 19. view_logs 浏览记录（"我的 - 浏览记录"）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `view_logs` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `diary_id`   BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_diary` (`user_id`, `diary_id`),
  KEY `idx_user_time` (`user_id`, `created_at`),
  CONSTRAINT `fk_view_user`  FOREIGN KEY (`user_id`)  REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_view_diary` FOREIGN KEY (`diary_id`) REFERENCES `diaries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='浏览记录';

-- ----------------------------------------------------------------------------
--  互动消息（点赞 / 收藏 / 评论的通知）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `to_user_id`   BIGINT UNSIGNED NOT NULL COMMENT '收到通知的人',
  `from_user_id` BIGINT UNSIGNED NOT NULL COMMENT '发起互动的人',
  `type`         ENUM('like','favorite','comment','mention','reply','bless','message') NOT NULL,
  `diary_id`     BIGINT UNSIGNED NULL COMMENT '点赞/评论等指向某篇日记；祝福类通知为空',
  `comment_id`   BIGINT UNSIGNED NULL,
  `content`      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '评论正文',
  `is_read`      TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_to_time` (`to_user_id`, `created_at`),
  CONSTRAINT `fk_n_to`    FOREIGN KEY (`to_user_id`)   REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_n_from`  FOREIGN KEY (`from_user_id`) REFERENCES `users` (`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_n_diary` FOREIGN KEY (`diary_id`)     REFERENCES `diaries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='互动消息';
