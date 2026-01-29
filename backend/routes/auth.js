const express = require('express');
const rateLimit = require('express-rate-limit');
const Account = require('../models/Account');
const { 
  generateAccessToken, 
  generateRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  authenticate
} = require('../middleware/auth');

const router = express.Router();

// ログイン試行回数制限（15分間に5回まで）
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'ログイン試行回数が多すぎます。しばらく待ってから再試行してください。',
  standardHeaders: true,
  legacyHeaders: false,
});

// Cookie設定
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 15 * 60 * 1000 // 15分
};

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7日
  path: '/api/auth/refresh'
};

// ログインエンドポイント
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { accountId, password } = req.body;
    
    if (!accountId || !password) {
      return res.status(400).json({ 
        error: 'アカウントIDとパスワードを入力してください' 
      });
    }

    // アカウント検索
    const account = await Account.findOne({ accountId })
      .populate('permissions', 'name');
    
    if (!account) {
      return res.status(401).json({ 
        error: 'アカウントIDまたはパスワードが正しくありません' 
      });
    }

    // アカウントロックチェック
    if (account.isLocked()) {
      const lockUntil = new Date(account.lockUntil);
      const remainingMinutes = Math.ceil((lockUntil - Date.now()) / 60000);
      return res.status(423).json({ 
        error: `アカウントがロックされています。あと${remainingMinutes}分待ってください。` 
      });
    }

    // パスワード検証
    const isMatch = await account.comparePassword(password);
    
    if (!isMatch) {
      await account.incLoginAttempts();
      
      // 残り試行回数を計算
      const remainingAttempts = 5 - (account.loginAttempts + 1);
      if (remainingAttempts > 0) {
        return res.status(401).json({ 
          error: `アカウントIDまたはパスワードが正しくありません（残り${remainingAttempts}回）` 
        });
      } else {
        return res.status(401).json({ 
          error: 'アカウントIDまたはパスワードが正しくありません（アカウントがロックされました）' 
        });
      }
    }

    // ログイン成功
    await account.resetLoginAttempts();

    // トークン生成
    const accessToken = generateAccessToken(account.accountId);
    const refreshToken = await generateRefreshToken(account.accountId);

    // Cookieに設定
    res.cookie('accessToken', accessToken, COOKIE_OPTIONS);
    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({
      success: true,
      account: {
        accountId: account.accountId,
        allProjects: account.allProjects,
        permissionIds: account.permissions.map(p => p._id.toString())
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'ログイン処理中にエラーが発生しました' });
  }
});

// トークンリフレッシュエンドポイント
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // リフレッシュトークン検証
    const accountId = await verifyRefreshToken(refreshToken);
    
    if (!accountId) {
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // アカウント確認
    const account = await Account.findOne({ accountId });
    
    if (!account || account.isLocked()) {
      await revokeRefreshToken(refreshToken);
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      return res.status(401).json({ error: 'Account not available' });
    }

    // 新しいアクセストークンを生成
    const newAccessToken = generateAccessToken(accountId);
    
    // 新しいアクセストークンをCookieに設定
    res.cookie('accessToken', newAccessToken, COOKIE_OPTIONS);

    res.json({ success: true });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ログアウトエンドポイント
router.post('/logout', authenticate, async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// 全デバイスからログアウト
router.post('/logout-all', authenticate, async (req, res) => {
  try {
    await revokeAllRefreshTokens(req.account.accountId);
    
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Logout all error:', err);
    res.status(500).json({ error: 'Logout all failed' });
  }
});

// セッション確認エンドポイント
router.get('/session', authenticate, async (req, res) => {
  try {
    res.json({
      valid: true,
      account: {
        accountId: req.account.accountId,
        allProjects: req.account.allProjects,
        permissionIds: req.account.permissions.map(p => p._id.toString())
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Session check failed' });
  }
});

module.exports = router;
