-- ============================================================================
--  初始数据：把固定的几个群聊房间塞进去
--  这个文件可以重复执行（用了 INSERT IGNORE / ON DUPLICATE KEY）
-- ============================================================================

INSERT INTO `chat_rooms` (`code`, `name`, `kind`, `desc`, `sort`) VALUES
  ('age',      '同龄群', 'age',      '差不多年纪的人',   10),
  ('interest', '拾趣',   'interest', '喜欢同个东西的人', 20),
  ('province', '同省群', 'province', '离得近的人',       30),
  ('zodiac',   '星迹',   'zodiac',   '同一个星座的人',   40)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `kind` = VALUES(`kind`),
  `desc` = VALUES(`desc`),
  `sort` = VALUES(`sort`);

-- 系统欢迎消息（每个房间一条，只在房间里还没有任何消息时插入）
INSERT INTO `chat_messages` (`room_id`, `user_id`, `type`, `content`)
SELECT r.id, NULL, 'sys', CONCAT('这里是', r.name, '，先随便说两句吧')
  FROM `chat_rooms` r
 WHERE NOT EXISTS (
   SELECT 1 FROM `chat_messages` m WHERE m.room_id = r.id
 );
