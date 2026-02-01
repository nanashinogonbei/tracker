const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const crypto = require('crypto');

// レートリミッター設定
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 最大100リクエスト
  message: 'リクエストが多すぎます。しばらく待ってから再試行してください。',
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
    xForwardedForHeader: false
  }
});

const trackingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分
  max: 60, // 最大60リクエスト
  message: 'トラッキングリクエストが多すぎます。',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.validProject === true;
  },
  validate: {
    trustProxy: false,
    xForwardedForHeader: false
  }
});

// 画像アップロード用レートリミッター（より厳格）
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 20, // 最大20リクエスト
  message: '画像のアップロードが多すぎます。しばらく待ってから再試行してください。',
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
    xForwardedForHeader: false
  }
});

// CSP Nonce生成ミドルウェア
function generateNonce(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
}

// セキュリティミドルウェア設定
function setupSecurity(app) {
  // Nonce生成
  app.use(generateNonce);

  // Helmet - セキュリティヘッダー設定（静的HTML対応版）
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",  // Tailwind CSSのため必要
          "https://unpkg.com"
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",  // 静的HTMLファイルのため必要
          "'unsafe-eval'"     // ABテスト機能のため必要（段階的に削除予定）
        ],
        scriptSrcAttr: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      },
      reportOnly: false
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    xssFilter: true,
    frameguard: { action: 'deny' },
    noSniff: true,
    hsts: process.env.NODE_ENV === 'production' ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    } : false
  }));

  // NoSQL Injection対策
  app.use(mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      console.warn(`[Security] NoSQL injection attempt detected: ${key}`);
    },
  }));

  // XSS対策（追加の防御層）
  app.use(xss());

  return {
    apiLimiter,
    trackingLimiter,
    uploadLimiter
  };
}

/**
 * CORS設定 – 管理画面・認証エンドポイント用
 *
 * これは認証Cookie（credentials: true）を使うルート专用です。
 * トラッキング系エンドポイントは corsAndSignature.js のヘルパーを使い、
 * プロジェクトごとのオリジン許可を行います。
 *
 * 変更点：以前は許可リストに含まれないオリジンでも `callback(null, true)` で
 * 全て許可していたため意味がありませんでした。今回は明示的に `false` を返し
 * 許可されていないオリジンをブロックします。
 */
function getCorsOptions() {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000'];

  return {
    origin: function (origin, callback) {
      // Origin ヘッダーが無い場合（同オリジン・サーバー側リクエスト）は許可
      if (!origin) {
        return callback(null, true);
      }
      // 許可リストに含まれる場合のみ許可
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // それ以外は拒否（レスポンスボディは返さず CORS ヘッダーを省略）
      console.warn(`[CORS] Blocked origin "${origin}" on admin/auth endpoint`);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
  };
}

// 入力検証ヘルパー
function validateInput(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => detail.message);
      return res.status(400).json({
        error: '入力検証エラー',
        details: errors
      });
    }

    req.body = value;
    next();
  };
}

module.exports = {
  setupSecurity,
  getCorsOptions,
  validateInput,
  apiLimiter,
  trackingLimiter,
  uploadLimiter,
  generateNonce
};
