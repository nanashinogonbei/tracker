const envFile = process.env.NODE_ENV === 'production' 
  ? '.env.production' 
  : '.env.development';
require('dotenv').config({ path: envFile });
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
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

// CORS設定
const cors = require('cors');
app.use(cors(getCorsOptions()));

// Body Parser
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  
  if (contentType.includes('multipart/form-data')) {
    return next();
  }
  
  express.json({ 
    limit: '10mb', // ペイロードサイズ制限
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

// 公開エンドポイント（認証不要）
app.use('/api/auth', authRoutes);
app.use('/tracker', trackerLimiter, trackerRoutes); // トラッキング用SDK配信
app.use('/track', trackerLimiter, trackerRoutes);   // トラッキングデータ受信

app.get('/api/abtests/:abtestId/creative/:creativeIndex', async (req, res) => {
  try {
    const ABTest = require('./models/ABTest');
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

// 静的ファイルは最後に（ただし認証が必要）
app.use(express.static('public'));

// 保護されたAPIエンドポイント（認証必要）
app.use('/api/projects', apiLimiter, authenticate, projectRoutes);
app.use('/api/analytics', apiLimiter, authenticate, analyticsRoutes);
app.use('/api/abtests', apiLimiter, authenticate, abtestRoutes);
app.use('/api/accounts', apiLimiter, authenticate, accountRoutes);

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