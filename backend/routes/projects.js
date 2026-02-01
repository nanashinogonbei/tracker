const express = require('express');
const crypto = require('crypto');
const Project = require('../models/Project');
const Log = require('../models/Log');
const ABTestLog = require('../models/ABTestLog');
const { normalizeUrl } = require('../utils/urlUtils');
const { escapeHtml, isValidUrl, containsScript } = require('../utils/sanitize');

const router = express.Router();

/**
 * 単一の allowedOrigins エントリを検証
 * 受け入れ可能なもの:
 *   "https://example.com"
 *   "http://localhost:3000"
 *   "https://*.example.com"   (wildcard sub-domain)
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isValidOriginEntry(origin) {
  if (typeof origin !== 'string') return false;

  // Wildcard sub-domain pattern
  if (origin.match(/^https?:\/\/\*\..+/)) {
    // The part after *. must look like a valid domain
    const domain = origin.replace(/^https?:\/\/\*\./, '');
    return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain);
  }

  // Standard origin validation
  return isValidUrl(origin);
}

// プロジェクト一覧取得
router.get('/', async (req, res) => {
  try {
    const projects = await Project.find();
    res.json(projects);
  } catch (err) {
    console.error('Get projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// プロジェクト作成（XSS対策強化版 + allowedOrigins対応）
router.post('/', async (req, res) => {
  try {
    const { name, url, allowedOrigins } = req.body;

    // バリデーション
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'プロジェクト名は必須です' });
    }

    if (containsScript(name)) {
      return res.status(400).json({
        error: 'プロジェクト名にスクリプトを含めることはできません'
      });
    }

    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: '有効なURLを入力してください' });
    }

    // allowedOrigins のバリデーション
    let validatedOrigins = [];
    if (Array.isArray(allowedOrigins)) {
      for (const entry of allowedOrigins) {
        if (!isValidOriginEntry(entry)) {
          return res.status(400).json({
            error: `無効なオリジン: "${entry}". 形式例: https://example.com or https://*.example.com`
          });
        }
        validatedOrigins.push(entry.trim());
      }
    }

    const apiKey = crypto.randomBytes(32).toString('hex');
    const normalizedUrl = normalizeUrl(url);

    const project = new Project({
      name: escapeHtml(name),
      url: normalizedUrl,
      apiKey: apiKey,
      allowedOrigins: validatedOrigins
    });

    const saved = await project.save();
    res.json(saved);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: err.message });
  }
});

// プロジェクト更新（allowedOrigins対応）
router.put('/:id', async (req, res) => {
  try {
    const { allowedOrigins } = req.body;

    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // allowedOrigins のバリデーション
    if (Array.isArray(allowedOrigins)) {
      for (const entry of allowedOrigins) {
        if (!isValidOriginEntry(entry)) {
          return res.status(400).json({
            error: `無効なオリジン: "${entry}". 形式例: https://example.com or https://*.example.com`
          });
        }
      }
      project.allowedOrigins = allowedOrigins.map(o => o.trim());
    }

    const updated = await project.save();
    res.json(updated);
  } catch (err) {
    console.error('Update project error:', err);
    res.status(500).json({ error: err.message });
  }
});

// プロジェクト削除
router.delete('/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await Log.deleteMany({ projectId: project._id });
    await ABTestLog.deleteMany({ projectId: project._id });
    await Project.findByIdAndDelete(req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
