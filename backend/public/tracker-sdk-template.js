(function () {
	// サーバー側で置換されるプレースホルダー
	const PROJECT_ID = '{{PROJECT_ID}}';
	const API_KEY = '{{API_KEY}}';
	const SERVER_HOST = '{{SERVER_HOST}}';
	
	// クライアント側でプロトコルを判定してサーバーURLを構築
	const SERVER_URL = (window.location.protocol === 'https:' ? 'https://' : 'http://') + SERVER_HOST;

	// デバッグモードの判定
	const isDebugMode = window.location.search.includes('tracker_debug=1');

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

	// 訪問回数の管理
	let visitCount = parseInt(localStorage.getItem('tracker_visit_count') || '0');
	visitCount++;
	localStorage.setItem('tracker_visit_count', visitCount.toString());

	// セッション管理関数
	function getSessionKey(abtestId) {
		return `abtest_session_${abtestId}`;
	}

	function getSessionData(abtestId) {
		const key = getSessionKey(abtestId);
		const data = localStorage.getItem(key);
		if (!data) return null;
		
		try {
			return JSON.parse(data);
		} catch (e) {
			console.error('[ABTest] Session data parse error:', e);
			return null;
		}
	}

	function setSessionData(abtestId, creativeData, sessionDuration) {
		const key = getSessionKey(abtestId);
		const expiresAt = Date.now() + (sessionDuration * 60 * 1000); // 分をミリ秒に変換
		
		const sessionData = {
			creative: creativeData,
			expiresAt: expiresAt
		};
		
		localStorage.setItem(key, JSON.stringify(sessionData));
		
		if (isDebugMode) {
			console.log('[ABTest] セッション保存:', {
				abtestId,
				sessionDuration: `${sessionDuration}分`,
				expiresAt: new Date(expiresAt).toLocaleString()
			});
		}
	}

	function isSessionValid(sessionData) {
		if (!sessionData || !sessionData.expiresAt) return false;
		return Date.now() < sessionData.expiresAt;
	}

	// ABテストインプレッションログ送信関数
	async function logABTestImpression(abtestId, creativeIndex, creativeName, isOriginal) {
		try {
			const data = {
				projectId: PROJECT_ID,
				apiKey: API_KEY,
				abtestId: abtestId,
				userId: userId,
				creativeIndex: creativeIndex,
				creativeName: creativeName || '',
				isOriginal: isOriginal || false,
				url: window.location.href,
				userAgent: navigator.userAgent,
				language: navigator.language || 'unknown'
			};

			await fetch(`${SERVER_URL}/api/abtests/log-impression`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data),
				keepalive: true
			});

			if (isDebugMode) {
				console.log('[ABTest] インプレッションログ送信:', {
					abtestId,
					creativeIndex,
					creativeName,
					isOriginal
				});
			}
		} catch (err) {
			console.error('[ABTest] インプレッションログ送信エラー:', err);
		}
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

	// ABテスト実行関数
	async function executeABTest() {
		try {
			if (isDebugMode) {
				console.log('[ABTest] Requesting test execution...', {
					projectId: PROJECT_ID,
					url: window.location.href,
					visitCount: visitCount,
					userAgent: navigator.userAgent,
					language: navigator.language
				});
			}

			const response = await fetch(`${SERVER_URL}/api/abtests/execute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId: PROJECT_ID,
					url: window.location.href,
					userAgent: navigator.userAgent,
					language: navigator.language || 'unknown',
					visitCount: visitCount,
					referrer: document.referrer
				})
			});

			if (!response.ok) {
				console.error('[ABTest] Server error:', response.status);
				return;
			}

			const result = await response.json();

			if (isDebugMode) {
				console.log('[ABTest] Server response:', result);
			}

			if (result.matched && result.abtestId) {
				// セッションチェック
				const sessionData = getSessionData(result.abtestId);
				let creative = null;
				let isNewImpression = false;

				if (sessionData && isSessionValid(sessionData)) {
					// セッションが有効な場合は保存されたクリエイティブを使用
					creative = sessionData.creative;
					console.log('[ABTest] 🔄 セッションからクリエイティブを復元:', {
						テスト名: result.abtestName || 'N/A',
						クリエイティブ名: creative.name || '(名称なし)',
						オリジナル: creative.isOriginal ? 'はい' : 'いいえ',
						セッション有効期限: new Date(sessionData.expiresAt).toLocaleString()
					});
				} else {
					// 新しいクリエイティブを使用してセッションを保存
					creative = result.creative;
					const sessionDuration = result.sessionDuration || 720; // デフォルト12時間
					setSessionData(result.abtestId, creative, sessionDuration);
					isNewImpression = true; // 新しいインプレッションとしてマーク
					
					console.log('[ABTest] ✅ 新しいクリエイティブが適用されました:', {
						テスト名: result.abtestName || 'N/A',
						クリエイティブ名: creative.name || '(名称なし)',
						クリエイティブインデックス: creative.index,
						オリジナル: creative.isOriginal ? 'はい' : 'いいえ',
						CSS: creative.css ? 'あり' : 'なし',
						JavaScript: creative.javascript ? 'あり' : 'なし',
						セッション期間: `${sessionDuration}分`
					});
				}

				// 新しいインプレッションの場合のみログを記録
				if (isNewImpression) {
					await logABTestImpression(
						result.abtestId,
						creative.index,
						creative.name,
						creative.isOriginal
					);
				}

				// オリジナルの場合は何もしない
				if (creative.isOriginal) {
					console.log('[ABTest] オリジナル版が選択されました（変更なし）');
					return;
				}

				// CSSの適用
				if (creative.css && creative.css.trim() !== '') {
					const style = document.createElement('style');
					style.textContent = creative.css;
					document.head.appendChild(style);
					console.log('[ABTest] ✓ CSSを適用しました');
					if (isDebugMode) {
						console.log('[ABTest] CSS内容:', creative.css);
					}
				}

				// JavaScriptの実行
				if (creative.javascript && creative.javascript.trim() !== '') {
					// DOMContentLoadedを待ってから実行
					const executeJS = () => {
						try {
							eval(creative.javascript);
							console.log('[ABTest] ✓ JavaScriptを実行しました');
							if (isDebugMode) {
								console.log('[ABTest] JavaScript内容:', creative.javascript);
							}
						} catch (err) {
							console.error('[ABTest] ❌ JavaScript実行エラー:', err);
						}
					};

					if (document.readyState === 'loading') {
						document.addEventListener('DOMContentLoaded', executeJS);
					} else {
						executeJS();
					}
				}
			} else {
				console.log('[ABTest] ℹ️ マッチするテストがありません');
			}
		} catch (err) {
			console.error('[ABTest] ❌ 実行エラー:', err);
		}
	}

	// ABテストを実行
	executeABTest();

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

	// 初期化完了ログ
	if (isDebugMode) {
		console.log('[Tracker] ✅ 初期化完了', {
			projectId: PROJECT_ID,
			userId: userId,
			serverUrl: SERVER_URL,
			visitCount: visitCount,
			isFirstVisit: isFirstVisit
		});
	}
})();