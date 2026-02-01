const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : '.env.development';
require('dotenv').config({ path: envFile });
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/database');
const { setupSecurity, getCorsOptions, apiLimiter, trackingLimiter } = require('./config/security');
const { authenticate, checkProjectPermission } = require('./middleware/auth');
const { updateSuggestions } = require('./services/suggestionService');
const { createInitialAdmin } = require('./services/initService');
const {
  corsOriginCallback,
  projectLookupMiddleware,
  isAllowedTrackingOrigin,
  verifySignature,
  verifyImpressionSignature
} = require('./utils/corsAndSignature');

const app = express();

// 環境変数チェック
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set. Application cannot start.');
  process.exit(1);
}

// プロキシ信頼設定
app.set('trust proxy', true);

// Cookie Parser（セキュリティミドルウェアより前に配置）
app.use(cookieParser());

// セキュリティミドルウェアのセットアップ
setupSecurity(app);

// Body Parser
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    return next();
  }

  express.json({
    limit: '10mb',
    type: ['application/json', 'text/plain', 'application/octet-stream'],
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  })(req, res, next);
});

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── ルート読み込み ──────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const analyticsRoutes = require('./routes/analytics');
const abtestRoutes = require('./routes/abtests');
const trackerRoutes = require('./routes/tracker');
const accountRoutes = require('./routes/accounts');

// ─────────────────────────────────────────────────────────────────────────────
// トラッキング関連エンドポイント
//
// 設計ポリシー:
//   ① プロジェクトの allowedOrigins が設定されている場合はそちらを使う。
//      設定されていない場合は env の ALLOWED_ORIGINS にフォールバックし、
//      本番環境では空リスト→全拒否になる。
//   ② SDK は全リクエストに HMAC-SHA256 署名を付与する。サーバーは
//      verifySignature で検証する。署名の検証に失敗した場合は 401 を返す。
//   ③ Preflight (OPTIONS) は署名不要だが、オリジン検証は行う。
//      → projectLookupMiddleware が先に Project を解決し、その後 cors()
//        が corsOriginCallback を用いてオリジンを評価する。
// ─────────────────────────────────────────────────────────────────────────────

// ── /tracker/:projectId.js  (SDK配信 – GET) ──────────────────────────────────
// SDKファイル自体は公開リソースなので署名は不要だが、オリジン検証は行う。
// trackerRoutes 内で Project が解決される。
app.use('/tracker', cors({
  origin: function (origin, cb) {
    // SDK配信は GET で credentials なし。オリジン検証は trackerRoutes 内で
    // プロジェクト解決後に行うため、ここでは全オリジンを一旦許可し
    // レスポンスヘッダーに origin をそのまま返す（credentialsなしなので安全）。
    // 実際のトラッキング POST は /track で別途検証される。
    cb(null, origin || true);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), trackerRoutes);

// ── /track  (ページビュー・イベント記録 – POST) ─────────────────────────────
// ① projectLookupMiddleware で Project を解決
// ② cors で per-project オリジン検証
// ③ verifySignature で署名検証
// ④ trackingLimiter でレート制限
// ⑤ trackerRoutes で実処理
app.use('/track', projectLookupMiddleware);
app.use('/track', (req, res, next) => {
  cors({
    origin: corsOriginCallback(req),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false
  })(req, res, next);
});
// OPTIONS (Preflight) は署名検証をスキップ
app.options('/track', (req, res) => res.status(204).end());
// POST は署名検証 → レート制限 → ルート処理
app.post('/track', verifySignature, trackingLimiter, trackerRoutes);

// ── 公開エンドポイント（認証不要） – Cookie使用のため credentials: true ──────
const authCorsOptions = {
  ...getCorsOptions(),
  credentials: true
};
app.use('/api/auth', cors(authCorsOptions), authRoutes);

// ── ABテスト実行エンドポイント（認証不要 – SDKから呼ばれる） ─────────────────
// ① projectLookup → ② per-project CORS → ③ 署名検証 → ④ 実行
app.use('/api/abtests/execute', projectLookupMiddleware);
app.use('/api/abtests/execute', (req, res, next) => {
  cors({
    origin: corsOriginCallback(req),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false
  })(req, res, next);
});
app.options('/api/abtests/execute', (req, res) => res.status(204).end());
app.post('/api/abtests/execute', verifySignature, async (req, res) => {
  const ABTest = require('./models/ABTest');
  const useragent = require('useragent');
  const { checkConditions, selectCreative } = require('./utils/conditionUtils');
  const { matchUrl } = require('./utils/urlUtils');

  try {
    const { projectId, url, userAgent, language, visitCount, referrer } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const abtests = await ABTest.find({ projectId: projectId, active: true });

    if (abtests.length === 0) {
      return res.json({ matched: false });
    }

    const now = new Date();
    const agent = useragent.parse(userAgent);

    let deviceType = 'other';
    const deviceFamily = agent.device.family;
    if (deviceFamily === 'Other' || deviceFamily === 'Desktop') {
      deviceType = 'PC';
    } else if (deviceFamily.includes('iPad') || deviceFamily.includes('Tablet')) {
      deviceType = 'Tablet';
    } else if (deviceFamily.includes('iPhone') || deviceFamily.includes('Android') ||
      deviceFamily.includes('Mobile')) {
      deviceType = 'SP';
    }

    const userContext = {
      url: url,
      device: deviceType,
      browser: agent.family,
      os: agent.os.family,
      language: language || 'unknown',
      visitCount: parseInt(visitCount) || 0,
      referrer: referrer || ''
    };

    for (const abtest of abtests) {
      if (abtest.startDate && now < new Date(abtest.startDate)) continue;
      if (abtest.endDate && now > new Date(abtest.endDate)) continue;

      if (abtest.targetUrl && abtest.targetUrl.trim() !== '') {
        if (!matchUrl(url, abtest.targetUrl)) continue;
      }

      if (abtest.excludeUrl && abtest.excludeUrl.trim() !== '') {
        if (matchUrl(url, abtest.excludeUrl)) continue;
      }

      const conditionsMatch = checkConditions(abtest.conditions, userContext);
      if (!conditionsMatch) continue;

      const result = selectCreative(abtest.creatives);
      if (result) {
        return res.json({
          matched: true,
          abtestId: abtest._id,
          abtestName: abtest.name,
          sessionDuration: abtest.sessionDuration || 720,
          creative: {
            index: result.index,
            name: result.creative.name,
            css: result.creative.css,
            javascript: result.creative.javascript,
            isOriginal: result.creative.isOriginal
          }
        });
      }
    }

    res.json({ matched: false });
  } catch (err) {
    console.error('[ABTest Execute] エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ABテストインプレッションログ（認証不要 – SDKから呼ばれる） ────────────────
app.use('/api/abtests/log-impression', projectLookupMiddleware);
app.use('/api/abtests/log-impression', (req, res, next) => {
  cors({
    origin: corsOriginCallback(req),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false
  })(req, res, next);
});
app.options('/api/abtests/log-impression', (req, res) => res.status(204).end());
app.post('/api/abtests/log-impression', verifyImpressionSignature, trackingLimiter, async (req, res) => {
  const Project = require('./models/Project');
  const ABTestLog = require('./models/ABTestLog');
  const useragent = require('useragent');
  const { toJST } = require('./utils/dateUtils');

  try {
    const {
      projectId, apiKey, abtestId, userId, creativeIndex,
      creativeName, isOriginal, url, userAgent, language
    } = req.body;

    if (!projectId || !apiKey || !abtestId || !userId || creativeIndex === undefined) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const project = await Project.findOne({ _id: projectId, apiKey: apiKey });
    if (!project) {
      return res.status(403).json({ error: 'Invalid credentials' });
    }

    const agent = useragent.parse(userAgent);
    let deviceType = 'other';
    const deviceFamily = agent.device.family;

    if (deviceFamily === 'Other' || deviceFamily === 'Desktop') {
      deviceType = 'PC';
    } else if (deviceFamily.includes('iPad') || deviceFamily.includes('Tablet')) {
      deviceType = 'Tablet';
    } else if (deviceFamily.includes('iPhone') || deviceFamily.includes('Android') ||
      deviceFamily.includes('Mobile')) {
      deviceType = 'SP';
    }

    const jstNow = toJST(new Date());

    const abtestLog = new ABTestLog({
      projectId: project._id,
      abtestId: abtestId,
      userId: userId,
      creativeIndex: creativeIndex,
      creativeName: creativeName || '',
      isOriginal: isOriginal || false,
      url: url,
      device: deviceType,
      browser: agent.family,
      os: agent.os.family,
      language: language || 'unknown',
      timestamp: jstNow
    });

    await abtestLog.save();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('ABTest log impression error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 特定クリエイティブ取得（認証不要 – SDKから呼ばれる） ─────────────────────
// GET なので署名は不要だがオリジン検証は行う。
// Project は ABTest から逆引きで取得する。
app.get('/api/abtests/:abtestId/creative/:creativeIndex', async (req, res, next) => {
  // ABTest → Project の逆引きでオリジン検証に使う Project を解決
  try {
    const ABTest = require('./models/ABTest');
    const Project = require('./models/Project');
    const abtest = await ABTest.findById(req.params.abtestId);
    if (abtest) {
      const project = await Project.findById(abtest.projectId);
      if (project) {
        req.resolvedProject = project;
      }
    }
  } catch (_) { /* fallthrough */ }

  // オリジン検証
  const origin = req.get('Origin');
  if (!isAllowedTrackingOrigin(origin, req.resolvedProject)) {
    console.warn(`[CORS] Blocked origin "${origin}" on creative endpoint`);
    res.removeHeader('Access-Control-Allow-Origin');
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // CORS レスポンスヘッダーを手動設定（credentialsなし）
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  next();
}, async (req, res) => {
  const ABTest = require('./models/ABTest');

  try {
    const abtest = await ABTest.findById(req.params.abtestId);

    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }

    const creativeIndex = parseInt(req.params.creativeIndex);
    if (creativeIndex < 0 || creativeIndex >= abtest.creatives.length) {
      return res.status(404).json({ error: 'Creative not found' });
    }

    const creative = abtest.creatives[creativeIndex];

    res.json({
      abtestId: abtest._id,
      abtestName: abtest.name,
      sessionDuration: abtest.sessionDuration || 720,
      creative: {
        index: creativeIndex,
        name: creative.name,
        css: creative.css,
        javascript: creative.javascript,
        isOriginal: creative.isOriginal
      }
    });
  } catch (err) {
    console.error('Get specific creative error:', err);
    res.status(500).json({ error: err.message });
  }
});
// OPTIONS for the creative endpoint
app.options('/api/abtests/:abtestId/creative/:creativeIndex', (req, res) => {
  res.status(204).end();
});

// ── 静的ファイル（認証不要） ──────────────────────────────────────────────────
app.use(express.static('public'));

// ── 保護されたAPIエンドポイント（認証必要） – credentials: true ─────────────
const protectedCorsOptions = {
  ...getCorsOptions(),
  credentials: true
};
app.use('/api/projects', cors(protectedCorsOptions), apiLimiter, authenticate, projectRoutes);
app.use('/api/analytics', cors(protectedCorsOptions), apiLimiter, authenticate, analyticsRoutes);
app.use('/api/abtests', cors(protectedCorsOptions), apiLimiter, authenticate, abtestRoutes);
app.use('/api/accounts', cors(protectedCorsOptions), apiLimiter, authenticate, accountRoutes);

// ── エラーハンドリングミドルウェア ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: '入力検証エラー', details: err.message });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: '認証が必要です' });
  }

  if (err.message === 'CORS policy violation') {
    return res.status(403).json({ error: 'アクセスが拒否されました' });
  }

  res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

// 404ハンドラー
app.use((req, res) => {
  res.status(404).json({ error: 'エンドポイントが見つかりません' });
});

// Cron設定
cron.schedule('0 0,12 * * *', () => {
  console.log('[Cron] Triggering suggestion update');
  updateSuggestions();
});

// 初期化
async function initialize() {
  await connectDB();
  await createInitialAdmin();
  await updateSuggestions();
}

initialize();

// グレースフルシャットダウン
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
