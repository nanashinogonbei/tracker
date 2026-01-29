// 共通認証処理
(function() {
  const API_URL = '/api';
  
  // 認証付きfetch（自動リフレッシュ対応）
  window.authFetch = async function(url, options = {}) {
    const requestOptions = {
      ...options,
      credentials: 'include', // Cookieを含める
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };
    
    try {
      let response = await fetch(url, requestOptions);
      
      // トークン期限切れの場合、自動リフレッシュ
      if (response.status === 401) {
        const errorData = await response.json();
        
        if (errorData.code === 'TOKEN_EXPIRED') {
          console.log('[Auth] Token expired, attempting refresh...');
          
          // リフレッシュ試行
          const refreshed = await refreshAccessToken();
          
          if (refreshed) {
            // リトライ
            response = await fetch(url, requestOptions);
          } else {
            // リフレッシュ失敗 - ログインページへ
            redirectToLogin();
            throw new Error('Session expired');
          }
        } else {
          // その他の認証エラー
          redirectToLogin();
          throw new Error('Authentication required');
        }
      }
      
      return response;
    } catch (err) {
      console.error('[Auth] Fetch error:', err);
      throw err;
    }
  };
  
  // アクセストークンのリフレッシュ
  async function refreshAccessToken() {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        console.log('[Auth] Token refreshed successfully');
        return true;
      } else {
        console.log('[Auth] Token refresh failed');
        return false;
      }
    } catch (err) {
      console.error('[Auth] Refresh error:', err);
      return false;
    }
  }
  
  // ログインページへリダイレクト
  function redirectToLogin() {
    if (window.location.pathname !== '/index.html' && 
        window.location.pathname !== '/') {
      console.log('[Auth] Redirecting to login...');
      window.location.href = '/index.html';
    }
  }
  
  // セッションチェック
  window.checkSession = async function() {
    try {
      const response = await fetch(`${API_URL}/auth/session`, {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        return data;
      } else {
        return null;
      }
    } catch (err) {
      console.error('[Auth] Session check error:', err);
      return null;
    }
  };
  
  // ログアウト
  window.logout = async function() {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
      
      window.location.href = '/index.html';
    } catch (err) {
      console.error('[Auth] Logout error:', err);
      window.location.href = '/index.html';
    }
  };
  
  // ページ保護（認証が必要なページで使用）
  window.requireAuth = async function() {
    const session = await checkSession();
    
    if (!session || !session.valid) {
      redirectToLogin();
      return false;
    }
    
    return true;
  };
  
  console.log('[Auth] Auth library loaded');
})();
