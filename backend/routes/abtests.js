const express = require('express');
const useragent = require('useragent');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ABTest = require('../models/ABTest');
const ABTestLog = require('../models/ABTestLog');
const Log = require('../models/Log');
const Project = require('../models/Project');
const Suggestion = require('../models/Suggestion');
const { toJST } = require('../utils/dateUtils');
const { matchUrl } = require('../utils/urlUtils');
const { checkConditions, selectCreative } = require('../utils/conditionUtils');

const router = express.Router();

// uploadsディレクトリを作成
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer設定
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'creative-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB制限
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('画像ファイルのみアップロード可能です（jpeg, jpg, png, gif, webp）'));
    }
  }
});

// 画像アップロードエンドポイント（エラーハンドリング付き）
router.post('/upload-image', (req, res) => {
  upload.single('image')(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: 'アップロードエラー: ' + err.message });
    } else if (err) {
      console.error('Unknown upload error:', err);
      return res.status(500).json({ error: err.message });
    }
    
    if (!req.file) {
      console.error('No file in request');
      return res.status(400).json({ error: '画像ファイルがありません' });
    }

    const imageUrl = '/uploads/' + req.file.filename;
    res.json({ imageUrl: imageUrl });
  });
});

// 画像削除エンドポイント
router.delete('/delete-image', (req, res) => {
  try {
    const { imageUrl } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrlが必要です' });
    }

    const filename = path.basename(imageUrl);
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'ファイルが見つかりません' });
    }
  } catch (err) {
    console.error('Image delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// サジェスト取得エンドポイントを追加
router.get('/suggestions', async (req, res) => {
  try {
    let suggestion = await Suggestion.findOne();

    if (!suggestion) {
      suggestion = {
        devices: [],
        browsers: [],
        oss: [],
        languages: [],
        updatedAt: new Date()
      };
    }

    res.json(suggestion);
  } catch (err) {
    console.error('Suggestions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト一覧取得
router.get('/', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const abtests = await ABTest.find({ projectId }).sort({ createdAt: -1 });
    res.json(abtests);
  } catch (err) {
    console.error('Get ABTests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト作成
router.post('/', async (req, res) => {
  try {
    if (!req.body.name || req.body.name.trim() === '') {
      return res.status(400).json({ error: 'テスト名は必須です' });
    }

    if (!req.body.cvCode || req.body.cvCode.trim() === '') {
      return res.status(400).json({ error: 'CVコードは必須です' });
    }

    if (!req.body.creatives || req.body.creatives.length === 0) {
      return res.status(400).json({ error: '最低1つのクリエイティブが必要です' });
    }

    const abtestData = {
      ...req.body,
      targetUrl: req.body.targetUrl || '',
      excludeUrl: req.body.excludeUrl || '',
      startDate: req.body.startDate || null,
      endDate: req.body.endDate || null,
      sessionDuration: req.body.sessionDuration || 720,
    };

    const abtest = new ABTest(abtestData);
    const saved = await abtest.save();
    res.json(saved);
  } catch (err) {
    console.error('Create ABTest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト取得
router.get('/:id', async (req, res) => {
  try {
    const abtest = await ABTest.findById(req.params.id);
    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }
    res.json(abtest);
  } catch (err) {
    console.error('Get ABTest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト更新
router.put('/:id', async (req, res) => {
  try {
    if (!req.body.name || req.body.name.trim() === '') {
      return res.status(400).json({ error: 'テスト名は必須です' });
    }

    if (!req.body.cvCode || req.body.cvCode.trim() === '') {
      return res.status(400).json({ error: 'CVコードは必須です' });
    }

    if (!req.body.creatives || req.body.creatives.length === 0) {
      return res.status(400).json({ error: '最低1つのクリエイティブが必要です' });
    }

    // 既存のABテストを取得して、削除される画像を確認
    const existingAbtest = await ABTest.findById(req.params.id);
    if (existingAbtest) {
      const existingImageUrls = existingAbtest.creatives
        .map(c => c.imageUrl)
        .filter(url => url);
      
      const newImageUrls = req.body.creatives
        .map(c => c.imageUrl)
        .filter(url => url);

      // 削除される画像ファイルを削除
      existingImageUrls.forEach(imageUrl => {
        if (!newImageUrls.includes(imageUrl)) {
          const filename = path.basename(imageUrl);
          const filePath = path.join(uploadsDir, filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }

    const updateData = {
      ...req.body,
      targetUrl: req.body.targetUrl || '',
      excludeUrl: req.body.excludeUrl || '',
      startDate: req.body.startDate || null,
      endDate: req.body.endDate || null,
      sessionDuration: req.body.sessionDuration || 720,
      updatedAt: new Date()
    };

    const abtest = await ABTest.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }

    res.json(abtest);
  } catch (err) {
    console.error('Update ABTest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト削除
router.delete('/:id', async (req, res) => {
  try {
    const abtest = await ABTest.findById(req.params.id);
    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }

    // 関連する画像ファイルを削除
    abtest.creatives.forEach(creative => {
      if (creative.imageUrl) {
        const filename = path.basename(creative.imageUrl);
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    await ABTest.findByIdAndDelete(req.params.id);
    await ABTestLog.deleteMany({ abtestId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete ABTest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテストON/OFF切り替え
router.put('/:id/toggle', async (req, res) => {
  try {
    const abtest = await ABTest.findById(req.params.id);
    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }
    abtest.active = !abtest.active;
    abtest.updatedAt = new Date();
    await abtest.save();
    res.json(abtest);
  } catch (err) {
    console.error('Toggle ABTest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ABテスト実行
router.post('/execute', async (req, res) => {
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
        console.log('  → 期間外（開始前）');
        continue;
      }
      if (abtest.endDate && now > new Date(abtest.endDate)) {
        console.log('  → 期間外（終了後）');
        continue;
      }

      if (abtest.targetUrl && abtest.targetUrl.trim() !== '') {
        if (!matchUrl(url, abtest.targetUrl)) {
          console.log('  → 対象URLにマッチしない');
          continue;
        }
      }

      if (abtest.excludeUrl && abtest.excludeUrl.trim() !== '') {
        if (matchUrl(url, abtest.excludeUrl)) {
          console.log('  → 除外URLにマッチ');
          continue;
        }
      }

      const conditionsMatch = checkConditions(abtest.conditions, userContext);
      if (!conditionsMatch) {
        console.log('  → 実行条件にマッチしない');
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

// ABテストインプレッションログ記録
router.post('/log-impression', async (req, res) => {
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

// ABテスト統計情報取得
router.get('/:id/stats', async (req, res) => {
  try {
    const abtest = await ABTest.findById(req.params.id);
    if (!abtest) {
      return res.status(404).json({ error: 'ABTest not found' });
    }

    const stats = await Promise.all(
      abtest.creatives.map(async (creative, index) => {
        const impressions = await ABTestLog.countDocuments({
          abtestId: abtest._id,
          creativeIndex: index
        });

        const userIds = await ABTestLog.distinct('userId', {
          abtestId: abtest._id,
          creativeIndex: index
        });

        const conversions = await Log.countDocuments({
          projectId: abtest.projectId,
          userId: { $in: userIds },
          event: abtest.cvCode
        });

        const cvr = impressions > 0 ? ((conversions / impressions) * 100) : 0;

        return {
          creativeId: index,
          name: creative.name || (creative.isOriginal ? 'オリジナル' : '名称なし'),
          impressions: impressions,
          conversions: conversions,
          cvr: parseFloat(cvr.toFixed(3))
        };
      })
    );

    const totalStats = {
      totalImpressions: stats.reduce((sum, s) => sum + s.impressions, 0),
      totalConversions: stats.reduce((sum, s) => sum + s.conversions, 0),
      totalCvr: 0
    };

    if (totalStats.totalImpressions > 0) {
      totalStats.totalCvr = parseFloat(
        ((totalStats.totalConversions / totalStats.totalImpressions) * 100).toFixed(3)
      );
    }

    res.json({ stats: stats, total: totalStats });
  } catch (err) {
    console.error('Get ABTest stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;