const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/database');
const { updateSuggestions } = require('./services/suggestionService');
const { createInitialAdmin } = require('./services/initService');

const app = express();

// プロキシ信頼設定
app.set('trust proxy', true);

// CORS設定（credentials対応）
app.use(cors({
  origin: true, // すべてのオリジンを許可（リクエストのOriginをそのまま返す）
  credentials: true, // credentialsを許可
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// カスタムミドルウェア：multipart/form-data以外はJSONとして解析
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  
  // multipart/form-dataの場合はスキップ（multerが処理）
  if (contentType.includes('multipart/form-data')) {
    return next();
  }
  
  // それ以外はJSONとして解析を試みる
  express.json({ 
    type: ['application/json', 'text/plain', 'application/octet-stream'],
    verify: (req, res, buf, encoding) => {
      // sendBeaconからのリクエストを処理するため、バッファを保持
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  })(req, res, next);
});

app.use(express.urlencoded({ extended: true }));

// ルート読み込み
const projectRoutes = require('./routes/projects');
const analyticsRoutes = require('./routes/analytics');
const abtestRoutes = require('./routes/abtests');
const trackerRoutes = require('./routes/tracker');
const accountRoutes = require('./routes/accounts');

// APIルート設定（静的ファイルの前に）
app.use('/api/projects', projectRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/abtests', abtestRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/tracker', trackerRoutes);
app.use('/track', trackerRoutes);

// 静的ファイルは最後に
app.use(express.static('public'));

// 特定のABテストとクリエイティブを取得するエンドポイント
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

// サジェスト更新のcron設定（0時と12時に実行）
cron.schedule('0 0,12 * * *', () => {
  console.log('[Cron] Triggering suggestion update');
  updateSuggestions();
});

async function initialize() {
  await connectDB();          // データベース接続
  await createInitialAdmin(); // 初期導入時にadminアカウントを作成
  await updateSuggestions();  // 初回起動時にサジェストデータを更新
}

initialize();

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
