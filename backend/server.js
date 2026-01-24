const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/database');
const { updateSuggestions } = require('./services/suggestionService');

const app = express();

// プロキシ信頼設定
app.set('trust proxy', true);

// ミドルウェア
app.use(cors());
app.use(express.json({ type: '*/*' }));

// データベース接続
connectDB();

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

// 初回起動時にサジェストデータを更新
updateSuggestions();

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});