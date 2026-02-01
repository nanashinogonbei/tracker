(function () {
	// サーバー側で置換されるプレースホルダー
	const PROJECT_ID = '{{PROJECT_ID}}';
	const API_KEY = '{{API_KEY}}';
	const SERVER_HOST = '{{SERVER_HOST}}';

	// クライアント側でプロトコルを判定してサーバーURLを構築
	const SERVER_URL = (window.location.protocol === 'https:' ? 'https://' : 'http://') + SERVER_HOST;

	// デバッグモードの判定
	const isDebugMode = window.location.search.includes('tracker_debug=1');

	// ─── HMAC署名ユーティリティ ─────────────────────────────────────────────
	// サーバーの corsAndSignature.js と同じアルゴリズムを実装する。
	//
	// Web Crypto API は非対称です（非同期・ハッシュのみ）のため、
	// HMAC-SHA256 は SubtleCrypto で実装する。
	//
	// ペイロード書式: "<timestamp>.<projectId>.<url>"
	// キー導出:       HMAC-SHA256(masterSecret, projectId)  ← サーバー側で導出済み
	//                 クライアント側はAPIKeyをキーとして直接使用する
	//                 (サーバーは deriveProjectKey で同じキーを生成)
	//
	// ※ 実装上の注意: サーバーの masterSecret は env にある。SDKにはそれを渡せない。
	//   そのため SDK は apiKey をそのまま HMAC キーとして使い、サーバーも
	//   apiKey を使って検証する（corsAndSignature.js の deriveProjectKey を
	//   apiKey ベースに統一）。

	/**
	 * HMAC-SHA256 を計算して hex 文字列で返す（非同期）。
	 * @param {string} key     – HMAC キー
	 * @param {string} message – 署名対象の文字列
	 * @returns {Promise<string>} hex 署名
	 */
	async function hmacSHA256(key, message) {
		const enc = new TextEncoder();
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			enc.encode(key),
			{ name: 'HMAC' },
			false,
			['sign']
		);
		const signature = await crypto.subtle.sign(
			'HMAC',
			cryptoKey,
			enc.encode(message)
		);
		// ArrayBuffer → hex string
		return Array.from(new Uint8Array(signature))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	}

	/**
	 * リクエストボディに署名フィールド(_ts, _sig)を付与する。
	 * @param {object} body – オリジナルのリクエストボディ（url が含まれること）
	 * @returns {Promise<object>} 署名付きボディ
	 */
	async function signBody(body) {
		const ts = Date.now();
		const payload = `${ts}.${PROJECT_ID}.${body.url}`;
		const sig = await hmacSHA256(API_KEY, payload);

		return {
			...body,
			_ts: ts,
			_sig: sig
		};
	}

	// ─── URLパラメーター処理 ──────────────────────────────────────────────
	const urlParams = new URLSearchParams(window.location.search);
	const ghVoid = urlParams.get('gh_void');
	const ghId = urlParams.get('gh_id');
	const ghCreative = urlParams.get('gh_creative');

	if (isDebugMode) {
		console.log('[Tracker] URL Parameters:', {
			gh_void: ghVoid,
			gh_id: ghId,
			gh_creative: ghCreative
		});
	}

	// gh_void=0: アクセス解析を記録しない、ABテストを記録しない
	// gh_void=1: アクセス解析を記録しない、ABテストを行わず記録もしない
	const shouldSkipTracking = ghVoid === '0' || ghVoid === '1';
	const shouldSkipABTest = ghVoid === '1';

	// gh_id と gh_creative が指定されている場合は強制実行モード
	const isForceCreativeMode = ghId && ghCreative !== null;

	if (shouldSkipTracking && !isForceCreativeMode) {
		console.log('[Tracker] Tracking disabled: gh_void=' + ghVoid + ' detected');
		window.trackerEvent = function() {
			console.log('[Tracker] Event ignored (void mode)');
		};

		if (shouldSkipABTest) {
			console.log('[Tracker] ABTest disabled: gh_void=1 detected');
			return;
		}
	}

	// ─── ユーザーID・訪問回数管理 ─────────────────────────────────────────
	let userId = localStorage.getItem('tracker_user_id');
	let isFirstVisit = false;

	if (!userId) {
		userId = 'user_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
		localStorage.setItem('tracker_user_id', userId);
		isFirstVisit = true;
	}

	let visitCount = parseInt(localStorage.getItem('tracker_visit_count') || '0');
	visitCount++;
	localStorage.setItem('tracker_visit_count', visitCount.toString());

	// ─── セッション管理 ──────────────────────────────────────────────────
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
		const expiresAt = Date.now() + (sessionDuration * 60 * 1000);
		localStorage.setItem(key, JSON.stringify({
			creative: creativeData,
			expiresAt: expiresAt
		}));

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

	// ─── ABテストインプレッションログ送信 ────────────────────────────────
	async function logABTestImpression(abtestId, creativeIndex, creativeName, isOriginal) {
		if (shouldSkipTracking) {
			if (isDebugMode) {
				console.log('[ABTest] インプレッションログ記録スキップ (gh_void=' + ghVoid + ')');
			}
			return;
		}

		try {
			let data = {
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

			// 署名付与
			data = await signBody(data);

			await fetch(`${SERVER_URL}/api/abtests/log-impression`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data),
				credentials: 'omit',
				keepalive: true
			});

			if (isDebugMode) {
				console.log('[ABTest] インプレッションログ送信:', {
					abtestId, creativeIndex, creativeName, isOriginal,
					_ts: data._ts
				});
			}
		} catch (err) {
			console.error('[ABTest] インプレッションログ送信エラー:', err);
		}
	}

	// ─── トラッキング関数 ────────────────────────────────────────────────
	window.trackerEvent = async function (eventName, isExit = false) {
		if (shouldSkipTracking) {
			if (isDebugMode) {
				console.log('[Tracker] Event ignored (gh_void=' + ghVoid + '): ' + eventName);
			}
			return;
		}

		let data = {
			projectId: PROJECT_ID,
			apiKey: API_KEY,
			userId: userId,
			url: window.location.href,
			event: eventName,
			exitTimestamp: isExit ? new Date().toISOString() : null
		};

		// 署名付与
		data = await signBody(data);
		const payload = JSON.stringify(data);

		if (isExit) {
			// ページ離脱時は sendBeacon を使用
			// sendBeacon は非同期で戻り値がないため署名は事前に計算済み
			const blob = new Blob([payload], { type: 'application/json' });
			navigator.sendBeacon(`${SERVER_URL}/track`, blob);
		} else {
			fetch(`${SERVER_URL}/track`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: payload,
				credentials: 'omit',
				keepalive: true
			}).catch(err => console.error('[Tracker] Error:', err));
		}
	};

	// ─── 強制クリエイティブ実行 ───────────────────────────────────────────
	async function executeForceCreative() {
		try {
			console.log('[ABTest] 🎯 強制クリエイティブモード:', {
				abtestId: ghId,
				creativeIndex: ghCreative,
				shouldRecord: !shouldSkipTracking
			});

			// GET リクエストなので署名は不要
			const response = await fetch(`${SERVER_URL}/api/abtests/${ghId}/creative/${ghCreative}`, {
				credentials: 'omit'
			});

			if (!response.ok) {
				console.error('[ABTest] 指定されたクリエイティブが見つかりません');
				return;
			}

			const result = await response.json();

			if (isDebugMode) {
				console.log('[ABTest] Server response:', result);
			}

			const creative = result.creative;

			if (!shouldSkipTracking) {
				await logABTestImpression(
					result.abtestId,
					creative.index,
					creative.name,
					creative.isOriginal
				);
			}

			console.log('[ABTest] ✅ 強制クリエイティブが適用されました:', {
				テスト名: result.abtestName || 'N/A',
				クリエイティブ名: creative.name || '(名称なし)',
				クリエイティブインデックス: creative.index,
				オリジナル: creative.isOriginal ? 'はい' : 'いいえ',
				記録: shouldSkipTracking ? 'スキップ' : '記録'
			});

			if (creative.isOriginal) {
				console.log('[ABTest] オリジナル版が選択されました（変更なし）');
				return;
			}

			if (creative.css && creative.css.trim() !== '') {
				const style = document.createElement('style');
				style.textContent = creative.css;
				document.head.appendChild(style);
				console.log('[ABTest] ✓ CSSを適用しました');
				if (isDebugMode) console.log('[ABTest] CSS内容:', creative.css);
			}

			if (creative.javascript && creative.javascript.trim() !== '') {
				const executeJS = () => {
					try {
						const fn = new Function(creative.javascript);
						fn();
						console.log('[ABTest] ✓ JavaScriptを実行しました');
						if (isDebugMode) console.log('[ABTest] JavaScript内容:', creative.javascript);
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
		} catch (err) {
			console.error('[ABTest] ❌ 強制クリエイティブ実行エラー:', err);
		}
	}

	// ─── ABテスト実行 ─────────────────────────────────────────────────────
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

			let body = {
				projectId: PROJECT_ID,
				url: window.location.href,
				userAgent: navigator.userAgent,
				language: navigator.language || 'unknown',
				visitCount: visitCount,
				referrer: document.referrer
			};

			// 署名付与
			body = await signBody(body);

			const response = await fetch(`${SERVER_URL}/api/abtests/execute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'omit',
				body: JSON.stringify(body)
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
				const sessionData = getSessionData(result.abtestId);
				let creative = null;
				let isNewImpression = false;

				if (sessionData && isSessionValid(sessionData)) {
					creative = sessionData.creative;
					console.log('[ABTest] 🔄 セッションからクリエイティブを復元:', {
						テスト名: result.abtestName || 'N/A',
						クリエイティブ名: creative.name || '(名称なし)',
						オリジナル: creative.isOriginal ? 'はい' : 'いいえ',
						セッション有効期限: new Date(sessionData.expiresAt).toLocaleString()
					});
				} else {
					creative = result.creative;
					const sessionDuration = result.sessionDuration || 720;
					setSessionData(result.abtestId, creative, sessionDuration);
					isNewImpression = true;

					console.log('new creative:', {
						test: result.abtestName || 'N/A',
						name: creative.name || '(名称なし)',
						index: creative.index,
					});
				}

				if (isNewImpression) {
					await logABTestImpression(
						result.abtestId,
						creative.index,
						creative.name,
						creative.isOriginal
					);
				}

				if (creative.isOriginal) return;

				if (creative.css && creative.css.trim() !== '') {
					const style = document.createElement('style');
					style.textContent = creative.css;
					document.head.appendChild(style);
					if (isDebugMode) console.log('[ABTest] CSS内容:', creative.css);
				}

				if (creative.javascript && creative.javascript.trim() !== '') {
					const executeJS = () => {
						try {
							const fn = new Function(creative.javascript);
							fn();
							if (isDebugMode) console.log('[ABTest] JavaScript内容:', creative.javascript);
						} catch (err) {
							console.error('JavaScript実行エラー:', err);
						}
					};

					if (document.readyState === 'loading') {
						document.addEventListener('DOMContentLoaded', executeJS);
					} else {
						executeJS();
					}
				}
			}
		} catch (err) {
			console.error('test 実行エラー:', err);
		}
	}

	// ─── 実行ディスパッチ ─────────────────────────────────────────────────
	if (isForceCreativeMode) {
		executeForceCreative();
	} else if (!shouldSkipABTest) {
		executeABTest();
	} else {
		console.log('[ABTest] ABテスト実行スキップ (gh_void=1)');
	}

	// ─── トラッキング処理 ────────────────────────────────────────────────
	if (!shouldSkipTracking) {
		trackerEvent(isFirstVisit ? 'first_view' : 'page_view');

		window.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				trackerEvent('page_leave', true);
			}
		});

		window.addEventListener('pagehide', () => {
			trackerEvent('page_leave', true);
		});
	}

	// 初期化完了ログ
	if (isDebugMode) {
		console.log('[Tracker] ✅ 初期化完了', {
			projectId: PROJECT_ID,
			userId: userId,
			serverUrl: SERVER_URL,
			visitCount: visitCount,
			isFirstVisit: isFirstVisit,
			trackingMode: shouldSkipTracking ? 'disabled' : 'enabled',
			abtestMode: shouldSkipABTest ? 'disabled' : (isForceCreativeMode ? 'force' : 'normal'),
			signing: 'HMAC-SHA256 enabled'
		});
	}
})();
