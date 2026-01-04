/**
 * WebトラッカーSDK
 */
(function () {
	// スクリプトのURLから自動的にサーバーURLを取得
	const currentScript = document.currentScript || document.querySelector('script[src*="tracker-sdk.js"]');
	const scriptUrl = currentScript ? currentScript.src : '';
	const SERVER_URL = scriptUrl ? new URL(scriptUrl).origin : window.location.origin;

	let userId = localStorage.getItem('tracker_user_id') || 'user_' + Math.random().toString(36).substr(2, 9);
	localStorage.setItem('tracker_user_id', userId);

	/**
	 * 送信処理
	 */
	window.trackerEvent = function (eventName, isExit = false) {
		const data = {
			userId: userId,
			url: window.location.href,
			event: eventName,
			exitTimestamp: isExit ? new Date().toISOString() : null
		};

		const payload = JSON.stringify(data);

		if (isExit) {
			navigator.sendBeacon(`${SERVER_URL}/track`, payload);
		} else {
			fetch(`${SERVER_URL}/track`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: payload,
				keepalive: true
			}).catch(err => console.error('Tracker error:', err));
		}
	};

	// 初期読み込み時
	trackerEvent('page_view');

	// 離脱時（イベントリスナーを個別に登録）
	window.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			trackerEvent('page_leave', true);
		}
	});
	
	window.addEventListener('pagehide', () => {
		trackerEvent('page_leave', true);
	});
})();