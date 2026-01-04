const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const useragent = require('useragent');

const app = express();
app.use(cors());
app.use(express.json());
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

		const { start, end } = req.query;
		
		// 日付の範囲を日本時間の00:00:00から23:59:59まで厳密に指定
		const startDate = new Date(start);
		startDate.setHours(0, 0, 0, 0);
		const endDate = new Date(end);
		endDate.setHours(23, 59, 59, 999);

		const query = {
				url: { $regex: `^${project.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
				timestamp: { $gte: startDate, $lte: endDate }
		};

		const [stats, pages, filters] = await Promise.all([
				Log.aggregate([
						{ $match: query },
						{ 
								$group: { 
										_id: null, 
										// 重要：実データの 'page_view' だけを合計するように修正
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
		res.json({ status: 'ok' });
});

app.listen(3000, () => console.log('Server running on port 3000'));