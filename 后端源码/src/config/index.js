// ============================================================
//  统一配置中心
//  所有配置都从 .env 读，代码里不写死任何密码/密钥
// ============================================================
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 项目根目录（src/config 的上两级）
export const ROOT = path.resolve(__dirname, '../..');

// 加载根目录的 .env
dotenv.config({ path: path.join(ROOT, '.env') });

/** 读环境变量，缺失时给默认值 */
function env(key, fallback = '') {
  const v = process.env[key];
  return (v === undefined || v === '') ? fallback : v;
}

export const config = {
  // ---- 服务 ----
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '3000')),
  nodeEnv: env('NODE_ENV', 'development'),
  get isDev() { return this.nodeEnv !== 'production'; },

  // ---- MySQL ----
  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', '3306')),
    user: env('DB_USER', 'root'),
    password: env('DB_PASSWORD', ''),
    database: env('DB_NAME', 'peizhe'),
    charset: 'utf8mb4',
    // 一个连接池里最多同时开 10 个连接，够小项目用
    connectionLimit: Number(env('DB_POOL', '10')),
    // 时间字段统一按字符串拿，避免时区坑
    dateStrings: true,
  },

  // ---- JWT ----
  jwt: {
    secret: env('JWT_SECRET', 'dev-only-please-change-me'),
    expiresIn: env('JWT_EXPIRES_IN', '30d'),
  },

  // ---- DeepSeek ----
  ai: {
    apiKey: env('DEEPSEEK_API_KEY', ''),
    apiUrl: env('DEEPSEEK_API_URL', 'https://api.deepseek.com/chat/completions'),
    model: env('DEEPSEEK_MODEL', 'deepseek-chat'),
  },

  // ---- 短信 / 验证码 ----
  sms: {
    enabled: env('SMS_ENABLED', 'false') === 'true',
    devCode: env('DEV_SMS_CODE', '123456'),
    // 验证码有效期（秒）
    codeTtl: 300,
    // 同一手机号发送间隔（秒）
    sendInterval: 60,
  },

  // ---- 上传 ----
  uploadDir: path.join(ROOT, 'uploads'),
  // 单张图片最大 5MB
  maxUploadSize: 5 * 1024 * 1024,

  /**
   * 后端对外的完整地址
   *
   * 为什么需要：前端和后端不在同一个源（前端可能是 file:// 或别的端口），
   * 数据库里如果只存 /uploads/xx.jpg 这样的相对路径，
   * 浏览器会把它解析到前端自己的目录，图片就显示不出来。
   * 所以要把头像之类的字段拼成完整 URL 再返回。
   *
   * 换了服务器就改 .env 里的 PUBLIC_BASE_URL，不用改代码。
   */
  get publicBaseUrl() {
    const explicit = env('PUBLIC_BASE_URL', '');
    if (explicit) return explicit.replace(/\/+$/, '');   // 去掉结尾的斜杠
    // 没配就按"本机IP:端口"猜一个（开发期够用）
    return `http://${env('PUBLIC_HOST', '127.0.0.1')}:${this.port}`;
  },
};

// ============================================================
//  启动自检：把致命的配置问题在启动时就喊出来
// ============================================================
export function checkConfig() {
  const problems = [];
  const warnings = [];

  if (!config.db.password) {
    problems.push('DB_PASSWORD 没填 —— 后端连不上 MySQL。请在 server/.env 里填好 MySQL 密码。');
  }
  if (!process.env.JWT_SECRET) {
    warnings.push('JWT_SECRET 没设置，正在用不安全的默认值。正式上线前必须换成随机长字符串。');
  }
  if (!config.ai.apiKey) {
    // 注意：这不是错误，是"降级"。AI 聊天会自动用内置的体验版陪伴者，
    // 其他功能完全不受影响（所以放在 warnings 里，不拦截启动）。
    warnings.push(
      'DEEPSEEK_API_KEY 没设置 —— AI 聊天会用内置的体验版陪伴者（不会真的理解你说的话，'
      + '但会记得你、会在你难受时给关怀）。配好 Key 后重启服务即自动切换，代码不用改。'
    );
  }

  return { problems, warnings };
}
