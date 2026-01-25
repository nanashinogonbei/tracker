const Account = require('../models/Account');

async function createInitialAdmin() {
  try {
    // 既存のadminアカウントをチェック
    const existingAdmin = await Account.findOne({ accountId: 'admin' });
    
    if (existingAdmin) {
      console.log('[Init] Admin account already exists');
      return;
    }

    // 初期adminアカウントを作成
    const adminAccount = new Account({
      accountId: 'admin',
      password: 'admin',
      allProjects: true,
      permissions: []
    });

    await adminAccount.save();
    console.log('[Init] ✅ Initial admin account created successfully');
    console.log('[Init] Account ID: admin');
    console.log('[Init] Password: admin');
    console.log('[Init] ⚠️  Please change the password after first login!');
  } catch (err) {
    console.error('[Init] Failed to create admin account:', err);
  }
}

module.exports = { createInitialAdmin };