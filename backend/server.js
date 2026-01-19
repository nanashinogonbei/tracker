const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const useragent = require('useragent');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();

// プロキシ信頼設定を追加
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({
	type: '*/*'
}));
app.use(express.static('public'));

mongoose.connect('mongodb://mongodb:27017/trackerDB');

const projectSchema = new mongoose.Schema({
	name: String,
	url: String,
	apiKey: {
		type: String,
		required: true,
		unique: true
	}
});
const Project = mongoose.model('Project', projectSchema);

const logSchema = new mongoose.Schema({
	projectId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Project',
		required: true
	},
	userId: String,
	url: String,
	event: String,
	device: String,
	browser: String,
	os: String,
	language: String,
	timestamp: {
		type: Date,
		default: Date.now
	},
	exitTimestamp: Date
});

// インデックスの設定
logSchema.index({
	projectId: 1,
	timestamp: -1
});
logSchema.index({
	projectId: 1,
	userId: 1
});
logSchema.index({
	projectId: 1,
	event: 1
});

const Log = mongoose.model('Log', logSchema);

// ABテスト実行ログ用のスキーマを追加
const abtestLogSchema = new mongoose.Schema({
	projectId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Project',
		required: true
	},
	abtestId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'ABTest',
		required: true
	},
	userId: String,
	creativeIndex: Number,
	creativeName: String,
	isOriginal: Boolean,
	url: String,
	device: String,
	browser: String,
	os: String,
	language: String,
	timestamp: {
		type: Date,
		default: Date.now
	}
});

// インデックスの設定
abtestLogSchema.index({
	projectId: 1,
	abtestId: 1,
	timestamp: -1
});
abtestLogSchema.index({
	abtestId: 1,
	creativeIndex: 1
});
abtestLogSchema.index({
	userId: 1,
	abtestId: 1
});

const ABTestLog = mongoose.model('ABTestLog', abtestLogSchema);

// サジェスト用のスキーマ
const suggestionSchema = new mongoose.Schema({
	devices: [String],
	browsers: [String],
	oss: [String],
	languages: [String],
	updatedAt: {
		type: Date,
		default: Date.now
	}
});

const Suggestion = mongoose.model('Suggestion', suggestionSchema);

// ABテスト用のスキーマ
const abtestSchema = new mongoose.Schema({
	projectId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Project',
		required: true
	},
	name: String,
	active: {
		type: Boolean,
		default: false
	},
	cvCode: String,
	targetUrl: String,
	excludeUrl: String,
	startDate: Date,
	endDate: Date,
	sessionDuration: {
		type: Number,
		default: 720
	},
	conditions: {
		device: [{
			value: String,
			condition: String,
			values: [String]
		}],
		language: [{
			value: String,
			condition: String,
			values: [String]
		}],
		os: [{
			value: String,
			condition: String,
			values: [String]
		}],
		browser: [{
			value: String,
			condition: String,
			values: [String]
		}],
		other: [{
			visitCount: {
				type: String,
				default: '0'
			},
			referrer: {
				type: String,
				default: ''
			}
		}]
	},
	creatives: [{
		name: String,
		distribution: Number,
		isOriginal: {
			type: Boolean,
			default: false
		},
		css: String,
		javascript: String
	}],
	createdAt: {
		type: Date,
		default: Date.now
	},
	updatedAt: {
		type: Date,
		default: Date.now
	}
});

const ABTest = mongoose.model('ABTest', abtestSchema);

// 日本時間（UTC+9）に変換する関数
function toJST(date) {
	const utcDate = new Date(date);
	return new Date(utcDate.getTime() + (9 * 60 * 60 * 1000));
}

// URLを正規化する関数
function normalizeUrl(url) {
	return url
		.replace(/^https?:\/\//, '')
		.replace(/^www\./, '')
		.replace(/\/$/, '')
		.toLowerCase();
}

// URLからプロジェクトを検索する関数
async function findProjectByUrl(url) {
	const normalizedUrl = normalizeUrl(url);
	const projects = await Project.find();

	for (const project of projects) {
		const normalizedProjectUrl = normalizeUrl(project.url);
		if (normalizedUrl.startsWith(normalizedProjectUrl) ||
			normalizedProjectUrl.startsWith(normalizedUrl)) {
			return project;
		}
	}
	return null;
}

// サジェストデータを更新する関数
async function updateSuggestions() {
	try {
		console.log('[Suggestion Update] Starting at', new Date().toISOString());

		const uniqueValues = await Log.aggregate([{
			$group: {
				_id: null,
				devices: {
					$addToSet: '$device'
				},
				browsers: {
					$addToSet: '$browser'
				},
				oss: {
					$addToSet: '$os'
				},
				languages: {
					$addToSet: '$language'
				}
			}
		}]);

		if (uniqueValues.length === 0) {
			console.log('[Suggestion Update] No data found');
			return;
		}

		const data = uniqueValues[0];

		const cleanAndSort = (arr) => {
			return arr
				.filter(v => v && v.trim() !== '')
				.sort((a, b) => a.localeCompare(b));
		};

		const suggestionData = {
			devices: cleanAndSort(data.devices),
			browsers: cleanAndSort(data.browsers),
			oss: cleanAndSort(data.oss),
			languages: cleanAndSort(data.languages),
			updatedAt: new Date()
		};

		await Suggestion.findOneAndUpdate({},
			suggestionData, {
				upsert: true,
				new: true
			}
		);

		console.log('[Suggestion Update] Completed', {
			devices: suggestionData.devices.length,
			browsers: suggestionData.browsers.length,
			oss: suggestionData.oss.length,
			languages: suggestionData.languages.length
		});
	} catch (err) {
		console.error('[Suggestion Update] Error:', err);
	}
}

cron.schedule('0 0,12 * * *', () => {
	console.log('[Cron] Triggering suggestion update');
	updateSuggestions();
});

updateSuggestions();

app.get('/api/suggestions', async (req, res) => {
	try {
		let suggestion = await Suggestion.findOne();

		if (!suggestion) {
			suggestion = {
				devices: [],
				browsers: [],
				oss: [],
				languages: [],
				updatedAt: new Date()
			};
		}

		res.json(suggestion);
	} catch (err) {
		console.error('Suggestions error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/api/projects', async (req, res) => {
	const projects = await Project.find();
	res.json(projects);
});

app.post('/api/projects', async (req, res) => {
	try {
		const apiKey = crypto.randomBytes(32).toString('hex');

		const normalizedUrl = normalizeUrl(req.body.url);
		const project = new Project({
			name: req.body.name,
			url: normalizedUrl,
			apiKey: apiKey
		});

		const saved = await project.save();
		res.json(saved);
	} catch (err) {
		console.error('Create project error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.delete('/api/projects/:id', async (req, res) => {
	try {
		const project = await Project.findById(req.params.id);
		if (!project) {
			return res.status(404).json({
				error: 'Project not found'
			});
		}

		await Log.deleteMany({
			projectId: project._id
		});
		await ABTestLog.deleteMany({
			projectId: project._id
		});
		await Project.findByIdAndDelete(req.params.id);

		res.json({
			success: true
		});
	} catch (err) {
		console.error('Delete error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/api/analytics/:projectId', async (req, res) => {
	try {
		const project = await Project.findById(req.params.projectId);
		if (!project) return res.status(404).send('Project not found');

		const {
			start,
			end,
			device,
			browser,
			os,
			language
		} = req.query;

		const startDate = new Date(start + 'T00:00:00.000Z');
		const endDate = new Date(end + 'T23:59:59.999Z');

		const query = {
			projectId: project._id,
			timestamp: {
				$gte: startDate,
				$lte: endDate
			}
		};

		if (device) query.device = {
			$in: device.split(',')
		};
		if (browser) query.browser = {
			$in: browser.split(',')
		};
		if (os) query.os = {
			$in: os.split(',')
		};
		if (language) query.language = {
			$in: language.split(',')
		};

		const [stats, pages, events] = await Promise.all([
			Log.aggregate([{
					$match: query
				},
				{
					$group: {
						_id: null,
						pv: {
							$sum: {
								$cond: [{
									$eq: ["$event", "page_view"]
								}, 1, 0]
							}
						},
						fv: {
							$sum: {
								$cond: [{
									$eq: ["$event", "first_view"]
								}, 1, 0]
							}
						},
						uu: {
							$addToSet: "$userId"
						}
					}
				}
			]),
			Log.aggregate([{
					$match: {
						...query,
						event: {
							$in: ['page_view', 'first_view']
						}
					}
				},
				{
					$group: {
						_id: "$url",
						count: {
							$sum: 1
						}
					}
				},
				{
					$sort: {
						count: -1
					}
				},
				{
					$limit: 10
				}
			]),
			Log.aggregate([{
					$match: {
						projectId: project._id
					}
				},
				{
					$group: {
						_id: null,
						events: {
							$addToSet: "$event"
						}
					}
				}
			])
		]);

		const result = stats[0] || {
			pv: 0,
			fv: 0,
			uu: []
		};
		const e = events[0] || {
			events: []
		};

		res.json({
			pageViews: result.pv + result.fv,
			uniqueUsers: result.uu ? result.uu.length : 0,
			popularPages: pages.map(p => ({
				url: p._id,
				count: p.count
			})),
			availableEvents: e.events.filter(ev => ev !== 'page_view' && ev !== 'first_view' && ev !== 'page_leave')
		});
	} catch (err) {
		console.error('Analytics error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/api/analytics/:projectId/event-count', async (req, res) => {
	try {
		const project = await Project.findById(req.params.projectId);
		if (!project) return res.status(404).send('Project not found');

		const {
			start,
			end,
			event
		} = req.query;

		const startDate = new Date(start + 'T00:00:00.000Z');
		const endDate = new Date(end + 'T23:59:59.999Z');

		const count = await Log.countDocuments({
			projectId: project._id,
			event: event,
			timestamp: {
				$gte: startDate,
				$lte: endDate
			}
		});

		res.json({
			count
		});
	} catch (err) {
		console.error('Event count error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/tracker/:projectId.js', async (req, res) => {
	try {
		const project = await Project.findById(req.params.projectId);
		if (!project) {
			return res.status(404).send('// Project not found');
		}

		const origin = req.get('origin') || req.get('referer');
		if (origin) {
			const requestProject = await findProjectByUrl(origin);
			if (!requestProject || requestProject._id.toString() !== project._id.toString()) {
				console.warn(`Unauthorized SDK access: ${origin} for project ${project._id}`);
				return res.status(403).send('// Domain not authorized');
			}
		}

		const templatePath = path.join(__dirname, 'public', 'tracker-sdk-template.js');
		let sdkTemplate = fs.readFileSync(templatePath, 'utf8');

		const host = req.get('host');

		console.log(`SDK Request - Host: ${host}, Headers:`, {
			proto: req.get('x-forwarded-proto'),
			protocol: req.protocol,
			secure: req.secure
		});

		const customizedSdk = sdkTemplate
			.replace('{{PROJECT_ID}}', project._id.toString())
			.replace('{{API_KEY}}', project.apiKey)
			.replace('{{SERVER_HOST}}', host);

		res.setHeader('Content-Type', 'application/javascript');
		res.setHeader('Cache-Control', 'public, max-age=3600');
		res.send(customizedSdk);
	} catch (err) {
		console.error('SDK Error:', err);
		res.status(500).send('// Server Error');
	}
});

app.post('/track', async (req, res) => {
	try {
		const {
			projectId,
			apiKey,
			userId,
			url,
			event,
			exitTimestamp
		} = req.body;

		if (!projectId || !apiKey || !userId || !url || !event) {
			return res.status(400).json({
				error: 'Missing required parameters'
			});
		}

		const project = await Project.findOne({
			_id: projectId,
			apiKey: apiKey
		});
		if (!project) {
			console.warn(`Invalid credentials: projectId=${projectId}`);
			return res.status(403).json({
				error: 'Invalid credentials'
			});
		}

		const normalizedRequestUrl = normalizeUrl(url);
		const normalizedProjectUrl = normalizeUrl(project.url);
		if (!normalizedRequestUrl.startsWith(normalizedProjectUrl)) {
			console.warn(`URL mismatch: ${url} does not match project ${project.url}`);
			return res.status(403).json({
				error: 'URL mismatch'
			});
		}

		const agent = useragent.parse(req.headers['user-agent']);

		let deviceType = 'other';
		const deviceFamily = agent.device.family;

		if (deviceFamily === 'Other' || deviceFamily === 'Desktop') {
			deviceType = 'PC';
		} else if (deviceFamily.includes('iPad') || deviceFamily.includes('Tablet')) {
			deviceType = 'Tablet';
		} else if (deviceFamily.includes('iPhone') || deviceFamily.includes('Android') ||
			deviceFamily.includes('Mobile')) {
			deviceType = 'SP';
		}

		const jstNow = toJST(new Date());

		const log = new Log({
			projectId: project._id,
			userId: userId,
			url: url,
			event: event,
			device: deviceType,
			browser: agent.family,
			os: agent.os.family,
			language: req.headers['accept-language']?.split(',')[0].split('-')[0] || 'unknown',
			timestamp: jstNow,
			exitTimestamp: exitTimestamp ? toJST(new Date(exitTimestamp)) : null
		});

		await log.save();
		res.json({
			status: 'ok'
		});
	} catch (err) {
		console.error('Track error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

// ABテスト実行ログを記録するエンドポイント
app.post('/api/abtests/log-impression', async (req, res) => {
	try {
		const {
			projectId,
			apiKey,
			abtestId,
			userId,
			creativeIndex,
			creativeName,
			isOriginal,
			url,
			userAgent,
			language
		} = req.body;

		if (!projectId || !apiKey || !abtestId || !userId || creativeIndex === undefined) {
			return res.status(400).json({
				error: 'Missing required parameters'
			});
		}

		const project = await Project.findOne({
			_id: projectId,
			apiKey: apiKey
		});
		if (!project) {
			return res.status(403).json({
				error: 'Invalid credentials'
			});
		}

		const agent = useragent.parse(userAgent);
		let deviceType = 'other';
		const deviceFamily = agent.device.family;

		if (deviceFamily === 'Other' || deviceFamily === 'Desktop') {
			deviceType = 'PC';
		} else if (deviceFamily.includes('iPad') || deviceFamily.includes('Tablet')) {
			deviceType = 'Tablet';
		} else if (deviceFamily.includes('iPhone') || deviceFamily.includes('Android') ||
			deviceFamily.includes('Mobile')) {
			deviceType = 'SP';
		}

		const jstNow = toJST(new Date());

		const abtestLog = new ABTestLog({
			projectId: project._id,
			abtestId: abtestId,
			userId: userId,
			creativeIndex: creativeIndex,
			creativeName: creativeName || '',
			isOriginal: isOriginal || false,
			url: url,
			device: deviceType,
			browser: agent.family,
			os: agent.os.family,
			language: language || 'unknown',
			timestamp: jstNow
		});

		await abtestLog.save();
		console.log('[ABTest Impression] Logged:', {
			abtestId,
			userId,
			creativeIndex,
			creativeName
		});

		res.json({
			status: 'ok'
		});
	} catch (err) {
		console.error('ABTest log impression error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/api/abtests', async (req, res) => {
	try {
		const {
			projectId
		} = req.query;
		if (!projectId) {
			return res.status(400).json({
				error: 'projectId is required'
			});
		}

		const abtests = await ABTest.find({
			projectId
		}).sort({
			createdAt: -1
		});
		res.json(abtests);
	} catch (err) {
		console.error('Get ABTests error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.post('/api/abtests', async (req, res) => {
	try {
		if (!req.body.name || req.body.name.trim() === '') {
			return res.status(400).json({
				error: 'テスト名は必須です'
			});
		}

		if (!req.body.cvCode || req.body.cvCode.trim() === '') {
			return res.status(400).json({
				error: 'CVコードは必須です'
			});
		}

		if (!req.body.creatives || req.body.creatives.length === 0) {
			return res.status(400).json({
				error: '最低1つのクリエイティブが必要です'
			});
		}

		const abtestData = {
			...req.body,
			targetUrl: req.body.targetUrl || '',
			excludeUrl: req.body.excludeUrl || '',
			startDate: req.body.startDate || null,
			endDate: req.body.endDate || null,
			sessionDuration: req.body.sessionDuration || 720,
		};

		const abtest = new ABTest(abtestData);
		const saved = await abtest.save();
		res.json(saved);
	} catch (err) {
		console.error('Create ABTest error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.get('/api/abtests/:id', async (req, res) => {
	try {
		const abtest = await ABTest.findById(req.params.id);
		if (!abtest) {
			return res.status(404).json({
				error: 'ABTest not found'
			});
		}
		res.json(abtest);
	} catch (err) {
		console.error('Get ABTest error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.put('/api/abtests/:id', async (req, res) => {
	try {
		if (!req.body.name || req.body.name.trim() === '') {
			return res.status(400).json({
				error: 'テスト名は必須です'
			});
		}

		if (!req.body.cvCode || req.body.cvCode.trim() === '') {
			return res.status(400).json({
				error: 'CVコードは必須です'
			});
		}

		if (!req.body.creatives || req.body.creatives.length === 0) {
			return res.status(400).json({
				error: '最低1つのクリエイティブが必要です'
			});
		}

		const updateData = {
			...req.body,
			targetUrl: req.body.targetUrl || '',
			excludeUrl: req.body.excludeUrl || '',
			startDate: req.body.startDate || null,
			endDate: req.body.endDate || null,
			sessionDuration: req.body.sessionDuration || 720,
			updatedAt: new Date()
		};

		const abtest = await ABTest.findByIdAndUpdate(
			req.params.id,
			updateData, {
				new: true,
				runValidators: true
			}
		);

		if (!abtest) {
			return res.status(404).json({
				error: 'ABTest not found'
			});
		}

		res.json(abtest);
	} catch (err) {
		console.error('Update ABTest error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.delete('/api/abtests/:id', async (req, res) => {
	try {
		const abtest = await ABTest.findByIdAndDelete(req.params.id);
		if (!abtest) {
			return res.status(404).json({
				error: 'ABTest not found'
			});
		}
		await ABTestLog.deleteMany({
			abtestId: req.params.id
		});
		res.json({
			success: true
		});
	} catch (err) {
		console.error('Delete ABTest error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.put('/api/abtests/:id/toggle', async (req, res) => {
	try {
		const abtest = await ABTest.findById(req.params.id);
		if (!abtest) {
			return res.status(404).json({
				error: 'ABTest not found'
			});
		}
		abtest.active = !abtest.active;
		abtest.updatedAt = new Date();
		await abtest.save();
		res.json(abtest);
	} catch (err) {
		console.error('Toggle ABTest error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.post('/api/abtests/execute', async (req, res) => {
	try {
		const {
			projectId,
			url,
			userAgent,
			language,
			visitCount,
			referrer
		} = req.body;

		console.log('[ABTest Execute] リクエスト受信:', {
			projectId,
			url,
			visitCount,
			language,
			userAgent: userAgent?.substring(0, 50) + '...'
		});

		if (!projectId) {
			return res.status(400).json({
				error: 'projectId is required'
			});
		}

		const abtests = await ABTest.find({
			projectId: projectId,
			active: true
		});

		console.log('[ABTest Execute] アクティブなテスト数:', abtests.length);

		if (abtests.length === 0) {
			return res.json({
				matched: false
			});
		}

		const now = new Date();
		const agent = useragent.parse(userAgent);

		let deviceType = 'other';
		const deviceFamily = agent.device.family;
		if (deviceFamily === 'Other' || deviceFamily === 'Desktop') {
			deviceType = 'PC';
		} else if (deviceFamily.includes('iPad') || deviceFamily.includes('Tablet')) {
			deviceType = 'Tablet';
		} else if (deviceFamily.includes('iPhone') || deviceFamily.includes('Android') ||
			deviceFamily.includes('Mobile')) {
			deviceType = 'SP';
		}

		const userContext = {
			url: url,
			device: deviceType,
			browser: agent.family,
			os: agent.os.family,
			language: language || 'unknown',
			visitCount: parseInt(visitCount) || 0,
			referrer: referrer || ''
		};

		console.log('[ABTest Execute] ユーザーコンテキスト:', userContext);

		for (const abtest of abtests) {
			console.log('[ABTest Execute] テストをチェック:', abtest.name);

			if (abtest.startDate && now < new Date(abtest.startDate)) {
				console.log('  → 期間外（開始前）');
				continue;
			}
			if (abtest.endDate && now > new Date(abtest.endDate)) {
				console.log('  → 期間外（終了後）');
				continue;
			}

			if (abtest.targetUrl && abtest.targetUrl.trim() !== '') {
				if (!matchUrl(url, abtest.targetUrl)) {
					console.log('  → 対象URLにマッチしない');
					continue;
				}
			}

			if (abtest.excludeUrl && abtest.excludeUrl.trim() !== '') {
				if (matchUrl(url, abtest.excludeUrl)) {
					console.log('  → 除外URLにマッチ');
					continue;
				}
			}

			const conditionsMatch = checkConditions(abtest.conditions, userContext);
			if (!conditionsMatch) {
				console.log('  → 実行条件にマッチしない');
				continue;
			}

			console.log('  ✅ マッチしました！');

			const result = selectCreative(abtest.creatives);
			if (result) {
				console.log('[ABTest Execute] クリエイティブ選択:', result.creative.name);
				return res.json({
					matched: true,
					abtestId: abtest._id,
					abtestName: abtest.name,
					sessionDuration: abtest.sessionDuration || 720,
					creative: {
						index: result.index,
						name: result.creative.name,
						css: result.creative.css,
						javascript: result.creative.javascript,
						isOriginal: result.creative.isOriginal
					}
				});
			}
		}

		console.log('[ABTest Execute] マッチするテストなし');
		res.json({
			matched: false
		});
	} catch (err) {
		console.error('[ABTest Execute] エラー:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

function matchUrl(url, pattern) {
	if (!pattern || pattern.trim() === '') return true;

	if (pattern.startsWith('/') && pattern.includes('/')) {
		try {
			const lastSlash = pattern.lastIndexOf('/');
			const regexPattern = pattern.slice(1, lastSlash);
			const flags = pattern.slice(lastSlash + 1);
			const regex = new RegExp(regexPattern, flags);
			return regex.test(url);
		} catch (e) {
			console.error('Invalid regex pattern:', pattern, e);
			return false;
		}
	}

	return url.includes(pattern);
}

function checkConditions(conditions, context) {
	if (!conditions) return true;

	const conditionTypes = ['device', 'browser', 'os', 'language'];

	for (const type of conditionTypes) {
		if (conditions[type] && conditions[type].length > 0) {
			const validConditions = conditions[type].filter(c => c.value && c.value.trim() !== '');

			if (validConditions.length === 0) continue;

			const matched = checkConditionArray(validConditions, context[type]);
			if (!matched) {
				console.log(`  → ${type}条件にマッチしない:`, context[type]);
				return false;
			}
		}
	}

	if (conditions.other && conditions.other.length > 0) {
		for (const cond of conditions.other) {
			const requiredVisitCount = parseInt(cond.visitCount) || 0;
			if (context.visitCount < requiredVisitCount) {
				console.log(`  → 訪問回数条件にマッチしない: ${context.visitCount} < ${requiredVisitCount}`);
				return false;
			}

			if (cond.referrer && cond.referrer.trim() !== '') {
				if (!matchUrl(context.referrer, cond.referrer)) {
					console.log(`  → リファラー条件にマッチしない: ${context.referrer}`);
					return false;
				}
			}
		}
	}

	return true;
}

function checkConditionArray(conditions, value) {
	for (const cond of conditions) {
		if (checkSingleCondition(cond, value)) {
			return true;
		}
	}
	return false;
}

function checkSingleCondition(condition, value) {
	const condValue = condition.value || '';
	const condType = condition.condition || 'exact';

	switch (condType) {
		case 'exact':
			return value === condValue;
		case 'contains':
			return value.includes(condValue);
		case 'startsWith':
			return value.startsWith(condValue);
		case 'endsWith':
			return value.endsWith(condValue);
		case 'regex':
			try {
				return new RegExp(condValue).test(value);
			} catch (e) {
				console.error('Regex error:', e);
				return false;
			}
			case 'oneOf':
				return (condition.values || []).includes(value);
			case 'notRegex':
				try {
					return !new RegExp(condValue).test(value);
				} catch (e) {
					return true;
				}
				case 'notStartsWith':
					return !value.startsWith(condValue);
				case 'notEndsWith':
					return !value.endsWith(condValue);
				case 'notContains':
					return !value.includes(condValue);
				case 'notOneOf':
					return !(condition.values || []).includes(value);
				default:
					return false;
	}
}

function selectCreative(creatives) {
	if (!creatives || creatives.length === 0) return null;
	const totalDistribution = creatives.reduce((sum, c) => sum + (c.distribution || 0), 0);

	if (totalDistribution === 0) {
		console.log('[ABTest] 配分が0のため最初のクリエイティブを使用');
		return {
			index: 0,
			creative: creatives[0]
		};
	}

	let random = Math.random() * totalDistribution;

	for (let i = 0; i < creatives.length; i++) {
		random -= (creatives[i].distribution || 0);
		if (random <= 0) {
			return {
				index: i,
				creative: creatives[i]
			};
		}
	}

	return {
		index: 0,
		creative: creatives[0]
	};
}

// ABテスト統計情報取得API（実際のログデータに基づく）
app.get('/api/abtests/:id/stats', async (req, res) => {
	try {
		const abtest = await ABTest.findById(req.params.id);
		if (!abtest) {
			return res.status(404).json({
				error: 'ABTest not found'
			});
		}
		// 各クリエイティブの統計を取得
		const stats = await Promise.all(
			abtest.creatives.map(async (creative, index) => {
				// このクリエイティブのインプレッション数（ABTestLogから）
				const impressions = await ABTestLog.countDocuments({
					abtestId: abtest._id,
					creativeIndex: index
				});

				// このクリエイティブを見たユーザーのコンバージョン数
				// ABTestLogからこのクリエイティブを見たユーザーIDを取得
				const userIds = await ABTestLog.distinct('userId', {
					abtestId: abtest._id,
					creativeIndex: index
				});

				// これらのユーザーのうち、CVイベントを発火したユーザー数
				const conversions = await Log.countDocuments({
					projectId: abtest.projectId,
					userId: {
						$in: userIds
					},
					event: abtest.cvCode
				});

				const cvr = impressions > 0 ?
					((conversions / impressions) * 100) :
					0;

				return {
					creativeId: index,
					name: creative.name || (creative.isOriginal ? 'オリジナル' : '名称なし'),
					impressions: impressions,
					conversions: conversions,
					cvr: parseFloat(cvr.toFixed(3))
				};
			})
		);

		// 合計値を計算
		const totalStats = {
			totalImpressions: stats.reduce((sum, s) => sum + s.impressions, 0),
			totalConversions: stats.reduce((sum, s) => sum + s.conversions, 0),
			totalCvr: 0
		};

		if (totalStats.totalImpressions > 0) {
			totalStats.totalCvr = parseFloat(
				((totalStats.totalConversions / totalStats.totalImpressions) * 100).toFixed(3)
			);
		}

		res.json({
			stats: stats,
			total: totalStats
		});
	} catch (err) {
		console.error('Get ABTest stats error:', err);
		res.status(500).json({
			error: err.message
		});
	}
});

app.listen(3000, () => console.log('Server running on port 3000'));