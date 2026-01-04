const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const useragent = require('useragent');

const app = express();
app.use(cors());
app.use(express.json({ type: '*/*' }));
app.use(express.static('public'));

mongoose.connect('mongodb://mongodb:27017/trackerDB');

const projectSchema = new mongoose.Schema({ name: String, url: String });
const Project = mongoose.model('Project', projectSchema);

const logSchema = new mongoose.Schema({
		userId: String, url: String, event: String, device: String,
		browser: String, os: String, language: String,
		timestamp: { type: Date, default: Date.now }
});
const Log = mongoose.model('Log', logSchema);

app.get('/api/projects', async (req, res) => res.json(await Project.find()));
app.post('/api/projects', async (req, res) => res.json(await new Project(req.body).save()));

app.get('/api/analytics/:projectId', async (req, res) => {
		const project = await Project.findById(req.params.projectId);
		if (!project) return res.status(404).send('Project not found');

		const { start, end, device, browser, os, language } = req.query;
		
		const startDate = new Date(start);
		startDate.setHours(0, 0, 0, 0);
		const endDate = new Date(end);
		endDate.setHours(23, 59, 59, 999);

		const query = {
				url: { $regex: `^${project.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
				timestamp: { $gte: startDate, $lte: endDate }
		};

		// フィルタを追加
		if (device) query.device = { $in: device.split(',') };
		if (browser) query.browser = { $in: browser.split(',') };
		if (os) query.os = { $in: os.split(',') };
		if (language) query.language = { $in: language.split(',') };

		const [stats, pages, filters] = await Promise.all([
				Log.aggregate([
						{ $match: query },
						{ 
								$group: { 
										_id: null, 
										pv: { $sum: { $cond: [{ $eq: ["$event", "page_view"] }, 1, 0] } },
										uu: { $addToSet: "$userId" } 
								} 
						}
				]),
				Log.aggregate([
						{ $match: { ...query, event: 'page_view' } },
						{ $group: { _id: "$url", count: { $sum: 1 } } },
						{ $sort: { count: -1 } },
						{ $limit: 10 }
				]),
				Log.aggregate([
						{ $match: { url: { $regex: `^${project.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } },
						{ $group: { 
								_id: null,
								browsers: { $addToSet: "$browser" },
								devices: { $addToSet: "$device" },
								oss: { $addToSet: "$os" },
								languages: { $addToSet: "$language" },
								events: { $addToSet: "$event" }
						}}
				])
		]);

		const result = stats[0] || { pv: 0, uu: [] };
		const f = filters[0] || { browsers: [], devices: [], oss: [], languages: [], events: [] };

		res.json({
				pageViews: result.pv,
				uniqueUsers: result.uu ? result.uu.length : 0,
				popularPages: pages.map(p => ({ url: p._id, count: p.count })),
				availableEvents: f.events.filter(e => e !== 'page_view'),
				filters: {
						browsers: f.browsers,
						devices: f.devices,
						oss: f.oss,
						languages: f.languages
				}
		});
});

app.get('/api/analytics/:projectId/event-count', async (req, res) => {
		const project = await Project.findById(req.params.projectId);
		const { start, end, event } = req.query;
		
		const startDate = new Date(start); startDate.setHours(0, 0, 0, 0);
		const endDate = new Date(end); endDate.setHours(23, 59, 59, 999);

		const count = await Log.countDocuments({
				url: { $regex: `^${project.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
				event: event,
				timestamp: { $gte: startDate, $lte: endDate }
		});
		res.json({ count });
});

app.post('/track', async (req, res) => {
	console.log('--- New Request ---');
	console.log('Body:', req.body);
	console.log('Headers:', req.headers['content-type']);
	try {
		const agent = useragent.parse(req.headers['user-agent']);
		const log = new Log({
			...req.body,
			device: agent.device.family === 'Other' ? 'PC' : agent.device.family,
			browser: agent.family,
			os: agent.os.family,
			language: req.headers['accept-language']?.split(',')[0].split('-')[0] || 'unknown',
			timestamp: new Date()
		});
		await log.save();
		console.log('Track saved:', { userId: req.body.userId, event: req.body.event, url: req.body.url });
		res.json({ status: 'ok' });
	} catch (err) {
		console.error('Track error:', err);
		res.status(500).json({ error: err.message });
	}
});

// tracker-sdk.js を配信するためのエンドポイント
app.get('/tracker.js', async (req, res) => {
		const origin = req.get('origin') || req.get('referer');
		
		if (!origin) {
				return res.status(403).send('Direct access not allowed');
		}

		try {
				const project = await Project.findById(req.params.projectId);
				
				if (!project) {
						return res.status(404).send('Project not found');
				}
				
				// プロジェクトのURLとoriginが一致するかチェック
				const normalizedProjectUrl = project.url.replace(/\/$/, "");
				const normalizedOrigin = origin.replace(/\/$/, "");
				
				if (normalizedOrigin.startsWith(normalizedProjectUrl)) {
						res.setHeader('Content-Type', 'application/javascript');
						res.sendFile(__dirname + '/public/tracker-sdk.js');
				} else {
						console.warn(`Unauthorized access: ${origin} tried to load tracker for ${project.url}`);
						res.status(403).send('Domain not authorized');
				}
		} catch (err) {
				console.error('Server Error:', err);
				res.status(500).send('Server Error');
		}
});

app.listen(3000, () => console.log('Server running on port 3000'));