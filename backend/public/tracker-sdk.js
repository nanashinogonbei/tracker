/**
 * WebトラッカーSDK
 */
(function () {
	const SERVER_URL = 'https://gb.production-null.work';

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
			// プリフライトを避けるため、あえて text/plain で送信
			navigator.sendBeacon(`${SERVER_URL}/track`, payload);
		} else {
			fetch(`${SERVER_URL}/track`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: payload,
				keepalive: true
			});
		}
	};

	// 初期読み込み時
	trackerEvent('page_view');

	// 離脱時（タブを閉じる、移動する）
	window.addEventListener('visibilitychange pagehide', () => {
		if (document.visibilityState === 'hidden') {
			trackerEvent('page_leave', true);
		}
	});
})();