const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: String,
  url: String,
  apiKey: {
    type: String,
    required: true,
    unique: true
  },
  /**
   * プロジェクトごとの CORS オリジン許可リスト
   *
   * 各エントリは元の文字列の例:
   *   "https://example.com"
   *   "https://*.example.com"   ← wildcard sub-domain support
   *
   * 空の場合、サーバーはグローバル環境変数 ALLOWED_ORIGINS にフォールバックします。
   * 本番環境では、グローバルリストが空の場合、すべてのクロスオリジンリクエストがブロックされます。
   * 開発環境では、利便性のためすべてが許可されます。
   */
  allowedOrigins: {
    type: [String],
    default: []
  }
});

module.exports = mongoose.model('Project', projectSchema);