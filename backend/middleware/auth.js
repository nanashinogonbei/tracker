const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Account = require('../models/Account');
const RefreshToken = require('../models/RefreshToken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const JWT_ACCESS_EXPIRES_IN = '15m'; // アクセストークンは15分
const JWT_REFRESH_EXPIRES_IN = '7d'; // リフレッシュトークンは7日

// アクセストークン生成
function generateAccessToken(accountId) {
  return jwt.sign(
    { accountId, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRES_IN }
  );
}

// リフレッシュトークン生成
async function generateRefreshToken(accountId) {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7日後
  
  const refreshToken = new RefreshToken({
    accountId,
    token,
    expiresAt
  });
  
  await refreshToken.save();
  return token;
}

// リフレッシュトークン検証
async function verifyRefreshToken(token) {
  const refreshToken = await RefreshToken.findOne({ 
    token,
    expiresAt: { $gt: new Date() }
  });
  
  if (!refreshToken) {
    return null;
  }
  
  return refreshToken.accountId;
}

// リフレッシュトークン削除（ログアウト用）
async function revokeRefreshToken(token) {
  await RefreshToken.deleteOne({ token });
}

// 全リフレッシュトークン削除（全デバイスからログアウト）
async function revokeAllRefreshTokens(accountId) {
  await RefreshToken.deleteMany({ accountId });
}

// 認証ミドルウェア（Cookieベース）
async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.accessToken;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    // トークンタイプの確認
    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    
    const account = await Account.findOne({ accountId: decoded.accountId });
    
    if (!account) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // アカウントロック確認
    if (account.isLocked()) {
      return res.status(423).json({ 
        error: 'アカウントがロックされています' 
      });
    }

    req.account = account;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// プロジェクト権限チェックミドルウェア
async function checkProjectPermission(req, res, next) {
  try {
    const account = req.account;
    const projectId = req.params.projectId || req.body.projectId;

    // 全プロジェクト権限を持つ場合
    if (account.allProjects) {
      return next();
    }

    // 特定プロジェクトの権限チェック
    const hasPermission = account.permissions.some(
      p => p.toString() === projectId
    );

    if (!hasPermission) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  authenticate,
  checkProjectPermission
};
