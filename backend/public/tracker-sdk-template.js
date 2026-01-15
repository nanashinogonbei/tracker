(function () {
	// サーバー側で置換されるプレースホルダー
	const PROJECT_ID = '{{PROJECT_ID}}';
	const API_KEY = '{{API_KEY}}';
	const SERVER_HOST = '{{SERVER_HOST}}';
	
	// クライアント側でプロトコルを判定してサーバーURLを構築
	const SERVER_URL = (window.location.protocol === 'https:' ? 'https://' : 'http://') + SERVER_HOST;

	// URLパラメーターをチェック
	const urlParams = new URLSearchParams(window.location.search);
	const isVoidMode = urlParams.get('gh_void') === '0';
	
	// gh_void=0が設定されている場合はトラッキングを無効化
	if (isVoidMode) {
		console.log('[Tracker] Tracking disabled: gh_void=0 detected');
		// ダミー関数を設定（エラーを防ぐため）
		window.trackerEvent = function() {
			console.log('[Tracker] Event ignored (void mode)');
		};
		return; // ここで処理を終了
	}

	// ユーザーIDの管理
	let userId = localStorage.getItem('tracker_user_id');
	let isFirstVisit = false;
	
	if (!userId) {
		userId = 'user_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
		localStorage.setItem('tracker_user_id', userId);
		isFirstVisit = true;
	}

	// トラッキング関数
	window.trackerEvent = function (eventName, isExit = false) {
		const data = {
			projectId: PROJECT_ID,
			apiKey: API_KEY,
			userId: userId,
			url: window.location.href,
			event: eventName,
			exitTimestamp: isExit ? new Date().toISOString() : null
		};

		const payload = JSON.stringify(data);

		if (isExit) {
			// ページ離脱時は sendBeacon を使用
			navigator.sendBeacon(`${SERVER_URL}/track`, payload);
		} else {
			// 通常のイベントは fetch を使用
			fetch(`${SERVER_URL}/track`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: payload,
				keepalive: true
			}).catch(err => console.error('[Tracker] Error:', err));
		}
	};

	// 初回訪問時は first_view、それ以外は page_view
	trackerEvent(isFirstVisit ? 'first_view' : 'page_view');

	// ページ離脱イベントの検出
	window.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			trackerEvent('page_leave', true);
		}
	});
	
	window.addEventListener('pagehide', () => {
		trackerEvent('page_leave', true);
	});

	// デバッグ用（本番環境では削除可能）
	if (window.location.search.includes('tracker_debug=1')) {
		console.log('[Tracker] Initialized', {
			projectId: PROJECT_ID,
			userId: userId,
			serverUrl: SERVER_URL
		});
	}
})();