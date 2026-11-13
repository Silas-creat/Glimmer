// ============================================================
//  文件上传（头像 / 日记配图）
//
//  用的是 multer。三个安全要点，缺一不可：
//
//    1. 限制大小 —— 不然有人传个 2G 文件就把服务器磁盘撑爆
//    2. 校验真实类型 —— 不能只看前端报的 Content-Type，
//       那个随便改。要读文件头几个字节（"魔数"）来判断。
//       否则有人把 .php / .html 改名成 .jpg 传上来，
//       配合服务器配置不当就能执行代码。
//    3. 自己生成文件名 —— 绝不能用用户传来的文件名，
//       里面可能有 ../../ 这种路径穿越字符
// ============================================================
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { ApiError } from '../utils/response.js';

// 确保目录存在（app.js 启动时也建过一次，这里再兜一层）
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

/** 允许的扩展名和数据 */
const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ------------------------------------------------------------
//  文件头"魔数"表
//  每个格式开头几个字节是固定的，看这个骗不了人
// ------------------------------------------------------------
const MAGIC = [
  { ext: '.jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: '.png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { ext: '.gif', bytes: [0x47, 0x49, 0x46, 0x38] },          // GIF8
  { ext: '.webp', bytes: [0x52, 0x49, 0x46, 0x46] },          // RIFF（webp 的前 4 字节）
];

/**
 * 读文件头，判断是不是真的图片
 * @param {string} filePath
 * @returns {string|null} 真实扩展名，不是图片返回 null
 */
export function sniffImageType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 3) return null;

    for (const m of MAGIC) {
      if (m.bytes.every((b, i) => buf[i] === b)) {
        // webp 还要多验一步：第 8-11 字节应该是 "WEBP"
        if (m.ext === '.webp') {
          const tag = buf.slice(8, 12).toString('ascii');
          if (tag !== 'WEBP') continue;
        }
        return m.ext;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

// ------------------------------------------------------------
//  存储：自己生成随机文件名
//  格式：avatar_1712345678901_a1b2c3.jpg
//    前缀_时间戳_随机串.扩展名
//  用随机串是为了防止同一毫秒内两次上传撞名互相覆盖
// ------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    // 扩展名先按声明的类型取，之后还会用魔数复核
    const ext = ALLOWED[file.mimetype] || '.jpg';
    const kind = req.uploadKind || 'img';
    const rand = crypto.randomBytes(4).toString('hex');
    cb(null, `${kind}_${Date.now()}_${rand}${ext}`);
  },
});

/** 通用上传实例 */
export const upload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadSize,
    // 只允许单个文件，防止有人一次传 100 个
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // 第一道关：先看声明的类型（快速拒绝明显不对的）
    if (!ALLOWED[file.mimetype]) {
      return cb(new ApiError('只能上传 jpg / png / gif / webp 图片', 400));
    }
    cb(null, true);
  },
});

/**
 * 第二道关：上传完之后，用魔数复核真实类型
 * 必须放在 multer 之后执行，因为这时候文件才落到磁盘上
 *
 * 如果不是真图片，直接删掉文件并报错。
 */
export function verifyUploadedImage(req, res, next) {
  if (!req.file) return next();

  const real = sniffImageType(req.file.path);

  if (!real) {
    // 删掉这个可疑文件，别留在服务器上
    try { fs.unlinkSync(req.file.path); } catch { /* 忽略 */ }
    return next(new ApiError('这个文件不是有效的图片（只改了扩展名是不行的）', 400));
  }

  // 如果真实类型和声明的扩展名不一致（比如声明 png 实际是 jpg），
  // 以真实类型为准，把文件改名，避免后续用错解码器
  const declaredExt = path.extname(req.file.filename).toLowerCase();
  if (declaredExt !== real) {
    const base = req.file.filename.slice(0, -declaredExt.length);
    const corrected = base + real;
    try {
      fs.renameSync(req.file.path, path.join(config.uploadDir, corrected));
      req.file.path = path.join(config.uploadDir, corrected);
      req.file.filename = corrected;
      console.log(`  🔧 上传类型纠正: ${declaredExt} → ${real}`);
    } catch {
      // 改名失败就用原本的，反正内容已经校验是图片了
    }
  }

  next();
}

/**
 * 把文件名转成可以直接给浏览器用的 URL
 *
 * 为什么用相对路径：
 *   页面和接口都跑在同一个服务上（启动脚本会把 /uploads 一起代理到后端），
 *   所以 /uploads/x.jpg 能被浏览器正确解析。
 *   用绝对地址反而脆弱：IP 一变、端口一换，所有图片全挂。
 */
export function fileUrl(filename) {
  if (!filename) return '';
  // 已经是完整 URL（比如用户填了网上的图片链接）就原样返回
  if (/^https?:\/\//i.test(filename)) return filename;

  // ★ 返回相对路径 /uploads/xxx.jpg ★
  //   以前这里是 config.publicBaseUrl + '/uploads/' + 文件名，
  //   拼出来是 http://192.168.31.251:8080/uploads/xxx.jpg 这种绝对地址。
  //   一换网络（IP 变了）或者换了端口（8080 → 8081），所有头像立刻全挂。
  //   相对路径由浏览器按"当前页面地址"补全，换 IP、换端口都不会坏。
  return '/uploads/' + filename;
}

/** 从数据库存的 avatar 字段，还原成能用的 URL */
export function avatarUrl(stored) {
  if (!stored) return '';
  if (/^https?:\/\//i.test(stored)) return stored;      // 外链
  if (stored.startsWith('data:')) return stored;         // base64（兼容旧数据）
  if (stored.startsWith('/uploads/')) return stored;   // 本来就是相对路径，原样给
  return fileUrl(stored);
}

/**
 * 把 base64 data URL 落成磁盘文件
 *
 * 为什么需要：前端 settings.html 原来用 FileReader 把图片读成 base64
 * 存在 localStorage。如果直接把这个 base64 存进数据库，
 * 一张 200KB 的图会变成 270KB 的字符串，users 表很快就被撑爆，
 * 而且每次查用户都要把这一大坨传一遍。
 * 所以统一落盘，数据库里只存文件名。
 *
 * @param {string} dataUrl 形如 "data:image/png;base64,xxxx"
 * @param {string} kind    文件名前缀，如 'avatar'
 * @returns {string|null}  成功返回文件名，失败返回 null
 */
export function saveDataUrlToFile(dataUrl, kind = 'img') {
  if (typeof dataUrl !== 'string') return null;

  const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;

  const typeMap = { jpeg: '.jpg', jpg: '.jpg', png: '.png', gif: '.gif', webp: '.webp' };
  const ext = typeMap[m[1].toLowerCase()] || '.jpg';
  const buf = Buffer.from(m[2], 'base64');

  // 大小限制
  if (buf.length > config.maxUploadSize) {
    throw new ApiError(`图片太大了（${Math.round(buf.length / 1024)}KB），最多 ${Math.round(config.maxUploadSize / 1024)}KB`, 400);
  }
  if (buf.length < 20) return null;

  const rand = crypto.randomBytes(4).toString('hex');
  const filename = `${kind}_${Date.now()}_${rand}${ext}`;
  const full = path.join(config.uploadDir, filename);

  fs.writeFileSync(full, buf);

  // 同样用魔数复核
  if (!sniffImageType(full)) {
    try { fs.unlinkSync(full); } catch { /* 忽略 */ }
    return null;
  }

  return filename;
}
