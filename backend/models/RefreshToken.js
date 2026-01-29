const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 2592000 // 30日で自動削除
  }
});

// 期限切れトークンのクリーンアップ用インデックス
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
