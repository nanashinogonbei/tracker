const envFile = process.env.NODE_ENV === 'production' 
  ? '.env.production' 
  : '.env.development';
require('dotenv').config({ path: envFile });
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const connectDB = require('./config/database');
const { setupSecurity, getCorsOptions, apiLimiter, trackingLimiter } = require('./config/security');
const { authenticate, checkProjectPermission } = require('./middleware/auth');
const { updateSuggestions } = require('./services/suggestionService');
const { createInitialAdmin } = require('./services/initService');

const app = express();

// 環境変数チェック
if (!process.env.JWT_SECRET) {
  console.warn('[Warning] JWT_SECRET not set. Using default (INSECURE)');
}

// プロキシ信頼設定
app.set('trust proxy', true);

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

// ルート読み込み
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const analyticsRoutes = require('./routes/analytics');
const abtestRoutes = require('./routes/abtests');
const trackerRoutes = require('./routes/tracker');
const accountRoutes = require('./routes/accounts');

// トラッキング関連のエンドポイント - 完全にオープンなCORS設定
app.use('/tracker', cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), trackerRoutes);

app.use('/track', cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), trackingLimiter, trackerRoutes);

// 公開エンドポイント（認証不要）
app.use('/api/auth', cors(getCorsOptions()), authRoutes);

// ABテスト実行エンドポイント（認証不要 - SDKから呼ばれる）
app.post('/api/abtests/execute', cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), async (req, res) => {
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
      if (abtest.startDate && now < new Date(abtest.startDate)) {
        continue;
      }
      if (abtest.endDate && now > new Date(abtest.endDate)) {
        continue;
      }

      if (abtest.targetUrl && abtest.targetUrl.trim() !== '') {
        if (!matchUrl(url, abtest.targetUrl)) {
          continue;
        }
      }

      if (abtest.excludeUrl && abtest.excludeUrl.trim() !== '') {
        if (matchUrl(url, abtest.excludeUrl)) {
          continue;
        }
      }

      const conditionsMatch = checkConditions(abtest.conditions, userContext);
      if (!conditionsMatch) {
        continue;
      }

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

// ABテストインプレッションログ（認証不要 - SDKから呼ばれる）
app.post('/api/abtests/log-impression', cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), trackingLimiter, async (req, res) => {
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

// 特定のクリエイティブ取得（認証不要 - SDKから呼ばれる）
app.get('/api/abtests/:abtestId/creative/:creativeIndex', cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), async (req, res) => {
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

// 静的ファイル（認証不要）
app.use(express.static('public'));

// 保護されたAPIエンドポイント（認証必要）- 制限的なCORS設定
app.use('/api/projects', cors(getCorsOptions()), apiLimiter, authenticate, projectRoutes);
app.use('/api/analytics', cors(getCorsOptions()), apiLimiter, authenticate, analyticsRoutes);
app.use('/api/abtests', cors(getCorsOptions()), apiLimiter, authenticate, abtestRoutes);
app.use('/api/accounts', cors(getCorsOptions()), apiLimiter, authenticate, accountRoutes);

// エラーハンドリングミドルウェア
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