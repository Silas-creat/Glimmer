// ==========================================
//  统一数据层
//  以后接后端，只要改这个文件里的 fetchData 就行
// ==========================================

const DIARY_DATA = [
  // —— 林小满（5条）——
  {
    id: 'd001', nick: '林小满', avatar: 'https://i.pravatar.cc/80?img=1',
    uid: '34954130101', ip: '陕西',
    likes: 12, follows: 539, fans: 44,
    time: '3分钟前',
    text: '今天出门，看见楼下的猫在晒太阳。\n突然觉得，活着也没那么难。',
    img: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=600'
  },
  {
    id: 'd009', nick: '林小满', avatar: 'https://i.pravatar.cc/80?img=1',
    uid: '34954130101', ip: '陕西',
    likes: 8, follows: 539, fans: 44,
    time: '昨天',
    text: '今天的晚霞是粉色的。',
    img: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=600'
  },
  {
    id: 'd010', nick: '林小满', avatar: 'https://i.pravatar.cc/80?img=1',
    uid: '34954130101', ip: '陕西',
    likes: 21, follows: 539, fans: 44,
    time: '3天前',
    text: '买了一杯热奶茶，暖手也暖心。',
    img: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=600'
  },
  {
    id: 'd013', nick: '林小满', avatar: 'https://i.pravatar.cc/80?img=1',
    uid: '34954130101', ip: '陕西',
    likes: 45, follows: 539, fans: 44,
    time: '5天前',
    text: '其实今天什么都没做，但依然觉得有点累。',
    img: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=600'
  },
  {
    id: 'd021', nick: '林小满', avatar: 'https://i.pravatar.cc/80?img=1',
    uid: '34954130101', ip: '陕西',
    likes: 105, follows: 539, fans: 44,
    time: '3周前',
    text: '买了一束花送给自己。',
    img: 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=600'
  },

  // —— 阿树（3条）——
  {
    id: 'd002', nick: '阿树', avatar: 'https://i.pravatar.cc/80?img=5',
    uid: '87123045210', ip: '四川',
    likes: 34, follows: 210, fans: 88,
    time: '2小时前',
    text: '很久没给家里打电话了。',
    img: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=600'
  },
  {
    id: 'd011', nick: '阿树', avatar: 'https://i.pravatar.cc/80?img=5',
    uid: '87123045210', ip: '四川',
    likes: 15, follows: 210, fans: 88,
    time: '前天',
    text: '我妈寄的腊肠到了。',
    img: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=600'
  },
  {
    id: 'd016', nick: '阿树', avatar: 'https://i.pravatar.cc/80?img=5',
    uid: '87123045210', ip: '四川',
    likes: 73, follows: 210, fans: 88,
    time: '1周前',
    text: '希望明天醒来，是一个有太阳的好天气。',
    img: 'https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?w=600'
  },

  // —— 半糖（2条）——
  {
    id: 'd003', nick: '半糖', avatar: 'https://i.pravatar.cc/80?img=8',
    uid: '55778899001', ip: '广东',
    likes: 56, follows: 102, fans: 156,
    time: '昨天',
    text: '今天没做成什么事。但我想，能撑过今天，也算数。',
    img: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=600'
  },
  {
    id: 'd017', nick: '半糖', avatar: 'https://i.pravatar.cc/80?img=8',
    uid: '55778899001', ip: '广东',
    likes: 120, follows: 102, fans: 156,
    time: '1周前',
    text: '刚刚吃完一顿热乎乎的饭，感觉自己活过来了。',
    img: 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=600'
  },

  // —— 小满（3条）——
  {
    id: 'd004', nick: '小满', avatar: 'https://i.pravatar.cc/80?img=12',
    uid: '33221144556', ip: '北京',
    likes: 21, follows: 88, fans: 23,
    time: '昨天',
    text: '下班路上的晚霞，拍给你看。',
    img: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=600'
  },
  {
    id: 'd012', nick: '小满', avatar: 'https://i.pravatar.cc/80?img=12',
    uid: '33221144556', ip: '北京',
    likes: 9, follows: 88, fans: 23,
    time: '4天前',
    text: '周末去了趟公园，人不多，很安静。',
    img: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=600'
  },
  {
    id: 'd020', nick: '小满', avatar: 'https://i.pravatar.cc/80?img=12',
    uid: '33221144556', ip: '北京',
    likes: 60, follows: 88, fans: 23,
    time: '2周前',
    text: '窗外的风很大，但是屋里很暖和。',
    img: 'https://images.unsplash.com/photo-1475924156734-496f6cac6ec1?w=600'
  },

  // —— 木木（3条）——
  {
    id: 'd005', nick: '木木', avatar: 'https://i.pravatar.cc/80?img=15',
    uid: '66778811223', ip: '江苏',
    likes: 43, follows: 300, fans: 66,
    time: '2天前',
    text: '一个人吃了顿火锅，也没那么惨。',
    img: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=600'
  },
  {
    id: 'd014', nick: '木木', avatar: 'https://i.pravatar.cc/80?img=15',
    uid: '66778811223', ip: '江苏',
    likes: 19, follows: 300, fans: 66,
    time: '5天前',
    text: '在路边捡到了一片很好看的落叶。',
    img: 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=600'
  },
  {
    id: 'd022', nick: '木木', avatar: 'https://i.pravatar.cc/80?img=15',
    uid: '66778811223', ip: '江苏',
    likes: 28, follows: 300, fans: 66,
    time: '3周前',
    text: '今天在街上看到一只很像以前养过的小狗。',
    img: 'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=600'
  },

  // —— 晚风（2条）——
  {
    id: 'd006', nick: '晚风', avatar: 'https://i.pravatar.cc/80?img=20',
    uid: '99887766554', ip: '山东',
    likes: 18, follows: 55, fans: 12,
    time: '3天前',
    text: '雨停了。空气很好。\n想出去走走。',
    img: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=600'
  },
  {
    id: 'd015', nick: '晚风', avatar: 'https://i.pravatar.cc/80?img=20',
    uid: '99887766554', ip: '山东',
    likes: 88, follows: 55, fans: 12,
    time: '6天前',
    text: '刚刚发呆了十分钟，觉得脑子终于清净了。',
    img: 'https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=600'
  },

  // —— 小七（2条）——
  {
    id: 'd007', nick: '小七', avatar: 'https://i.pravatar.cc/80?img=25',
    uid: '11223344556', ip: '浙江',
    likes: 67, follows: 421, fans: 130,
    time: '3天前',
    text: '今天收到一句谢谢，开心了一整天。',
    img: 'https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=600'
  },
  {
    id: 'd018', nick: '小七', avatar: 'https://i.pravatar.cc/80?img=25',
    uid: '11223344556', ip: '浙江',
    likes: 32, follows: 421, fans: 130,
    time: '1周前',
    text: '偷偷许个愿：希望下个月能顺利一点。',
    img: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600'
  },

  // —— 夜航（2条）——
  {
    id: 'd008', nick: '夜航', avatar: 'https://i.pravatar.cc/80?img=30',
    uid: '44556677889', ip: '福建',
    likes: 29, follows: 77, fans: 35,
    time: '4天前',
    text: '凌晨三点睡不着。\n写下这些，好像好一点了。',
    img: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=600'
  },
  {
    id: 'd019', nick: '夜航', avatar: 'https://i.pravatar.cc/80?img=30',
    uid: '44556677889', ip: '福建',
    likes: 50, follows: 77, fans: 35,
    time: '2周前',
    text: '晚安，虽然现在才下午三点。',
    img: 'https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600'
  }
];

// ===== 数据源 =====
function fetchData() { return DIARY_DATA; }
function getById(id) { return DIARY_DATA.find(d => d.id === id); }
function getByNick(nick) { return DIARY_DATA.filter(d => d.nick === nick); }

// ===== 本地存储：喜欢 / 收藏 / 关注 =====
function readList(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch (e) { return []; }
}
function writeList(key, arr) { localStorage.setItem(key, JSON.stringify(arr)); }

function isLiked(id)    { return readList('my_likes').includes(id); }
function isSaved(id)    { return readList('my_saves').includes(id); }
function isFollowed(id) { return readList('my_follows').includes(id); }

function toggleLike(id) {
  let arr = readList('my_likes');
  arr = arr.includes(id) ? arr.filter(x => x !== id) : arr.concat(id);
  writeList('my_likes', arr);
  return arr.includes(id);
}
function toggleSave(id) {
  let arr = readList('my_saves');
  arr = arr.includes(id) ? arr.filter(x => x !== id) : arr.concat(id);
  writeList('my_saves', arr);
  return arr.includes(id);
}
function toggleFollow(id) {
  let arr = readList('my_follows');
  arr = arr.includes(id) ? arr.filter(x => x !== id) : arr.concat(id);
  writeList('my_follows', arr);
  return arr.includes(id);
}

function getLikedDiaries() { return readList('my_likes').map(getById).filter(Boolean); }
function getSavedDiaries() { return readList('my_saves').map(getById).filter(Boolean); }
function getFollowedDiaries() {
  const follows = readList('my_follows');
  const nicks = follows.map(id => { const d = getById(id); return d ? d.nick : null; }).filter(Boolean);
  return DIARY_DATA.filter(d => nicks.includes(d.nick));
}