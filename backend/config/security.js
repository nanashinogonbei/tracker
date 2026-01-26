const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

// レートリミッター設定
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 最大100リクエスト
  message: 'リクエストが多すぎます。しばらく待ってから再試行してください。',
  standardHeaders: true,
  legacyHeaders: false,
  // validate オプションを追加して trustProxy 警告を無効化
  validate: {
    trustProxy: false, // trust proxy の検証を無効化
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
    // 正当なプロジェクトからのリクエストはスキップ
    return req.validProject === true;
  },
  // validate オプションを追加
  validate: {
    trustProxy: false,
    xForwardedForHeader: false
  }
});

// セキュリティミドルウェア設定
function setupSecurity(app) {
  // Helmet - セキュリティヘッダー設定
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        scriptSrcAttr: ["'unsafe-inline'"],   // インラインイベントハンドラーを許可
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // NoSQL Injection対策
  app.use(mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      console.warn(`[Security] NoSQL injection attempt detected: ${key}`);
    },
  }));

  // XSS対策
  app.use(xss());

  return {
    apiLimiter,
    trackingLimiter
  };
}

// CORS設定（セキュア版）
function getCorsOptions() {
  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];

  return {
    origin: function (origin, callback) {
      // トラッキングエンドポイントは登録ドメインからのみ許可
      // 管理画面は許可リストから許可
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('CORS policy violation'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400 // 24時間
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
  trackingLimiter
};