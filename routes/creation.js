const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { studioUpload } = require('../cloudynary');
const { Video, LiveSession } = require('../models/Video');
const { Wallet, Transaction } = require('../models/Wallet');
const fetch = require('node-fetch');

const MODERATION_URL = process.env.MODERATION_API_URL || 'http://localhost:8001';

// ── Helper : appel API modération ─────────────────────────────────────────
async function moderateContent(text, contentType = 'post') {
  try {
    const res = await fetch(`${MODERATION_URL}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content_type: contentType }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('Moderation service error');
    return await res.json();
  } catch {
    // Fallback permissif si l'API est hors ligne
    return { approved: true, flags: [], promo_score: 0.4, promo_tier: 'standard', promotion_eligible: true };
  }
}

async function algorithmScore(text, params = {}) {
  try {
    const res = await fetch(`${MODERATION_URL}/algorithm/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { score: 0.3, tier: 'standard' };
    return await res.json();
  } catch {
    return { score: 0.3, tier: 'standard' };
  }
}

// ── Crédit initial de bienvenue ─────────────────────────────────────────
async function ensureWallet(userId) {
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) {
    wallet = await Wallet.create({ user: userId, balance: 100 }); // 100 TPC de bienvenue
    await Transaction.create({
      user: userId,
      type: 'bonus',
      amount: 100,
      balance_after: 100,
      description: '🎁 Bonus de bienvenue SETRAF',
    });
  }
  return wallet;
}

// ══════════════════════════════════════════════════════════════════════════
// UPLOAD VIDÉO / CONTENU
// ══════════════════════════════════════════════════════════════════════════

// POST /api/studio/upload
router.post('/upload', verifyToken, studioUpload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]), async (req, res) => {
  try {
    const { title, description, tags, visibility } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Titre requis' });

    // 1. Modération du texte
    const textToModerate = `${title} ${description || ''}`;
    const modResult = await moderateContent(textToModerate, 'post');

    // 2. Construire les données médias
    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumbnail?.[0];

    const videoData = {
      author: req.userId,
      title,
      description: description || '',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      visibility: visibility || 'draft',
      moderation: {
        approved:    modResult.approved,
        flags:       modResult.flags || [],
        promo_score: modResult.promo_score || 0,
        promo_tier:  modResult.promo_tier  || 'standard',
        checked_at:  new Date(),
      },
    };

    if (videoFile) {
      videoData.videoUrl      = videoFile.path;
      videoData.videoPublicId = videoFile.filename;
      videoData.duration      = videoFile.duration || 0;
      videoData.fileSize      = videoFile.size || 0;
    }
    if (thumbFile) {
      videoData.thumbnailUrl = thumbFile.path;
    }

    // 3. Calcul score algorithmique
    const algoResult = await algorithmScore(textToModerate, {
      has_video:  !!videoFile,
      media_count: (videoFile ? 1 : 0) + (thumbFile ? 1 : 0),
      boost_multiplier: 1.0,
      recency_hours: 0.01,
    });
    videoData.algorithm_score = algoResult.score || 0;

    const video = await Video.create(videoData);

    res.status(201).json({
      success: true,
      video,
      moderation: modResult,
      algorithm: algoResult,
    });
  } catch (err) {
    console.error('❌ Studio upload error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LISTE DES VIDÉOS DU CRÉATEUR
// ══════════════════════════════════════════════════════════════════════════

// GET /api/studio/videos
router.get('/videos', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, visibility } = req.query;
    const filter = { author: req.userId };
    if (visibility) filter.visibility = visibility;

    const videos = await Video.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await Video.countDocuments(filter);

    res.json({ success: true, videos, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/videos/public
router.get('/videos/public', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const videos = await Video.find({ visibility: 'public', 'moderation.approved': true })
      .sort({ algorithm_score: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('author', 'name profilePhoto')
      .lean();

    res.json({ success: true, videos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/video/:id
router.get('/video/:id', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id)
      .populate('author', 'name profilePhoto department')
      .lean();
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    // Incrémenter les vues
    await Video.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/studio/video/:id
router.put('/video/:id', verifyToken, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, author: req.userId });
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    const { title, description, tags, visibility } = req.body;

    if (title || description) {
      const modResult = await moderateContent(`${title || video.title} ${description || video.description}`);
      video.moderation = {
        approved:    modResult.approved,
        flags:       modResult.flags || [],
        promo_score: modResult.promo_score || 0,
        promo_tier:  modResult.promo_tier || 'standard',
        checked_at:  new Date(),
      };
    }

    if (title)       video.title       = title;
    if (description) video.description = description;
    if (tags)        video.tags        = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
    if (visibility)  video.visibility  = visibility;
    video.updatedAt = new Date();

    await video.save();
    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/studio/video/:id
router.delete('/video/:id', verifyToken, async (req, res) => {
  try {
    const video = await Video.findOneAndDelete({ _id: req.params.id, author: req.userId });
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    res.json({ success: true, message: 'Vidéo supprimée' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ANALYTICS CRÉATEUR
// ══════════════════════════════════════════════════════════════════════════

// GET /api/studio/analytics
router.get('/analytics', verifyToken, async (req, res) => {
  try {
    const videos = await Video.find({ author: req.userId }).lean();

    const totalViews    = videos.reduce((s, v) => s + (v.views || 0), 0);
    const totalLikes    = videos.reduce((s, v) => s + (v.likes?.length || 0), 0);
    const totalShares   = videos.reduce((s, v) => s + (v.shares || 0), 0);
    const totalComments = videos.reduce((s, v) => s + (v.comments?.length || 0), 0);
    const totalVideos   = videos.length;

    // Top 5 vidéos par vues
    const topVideos = videos
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 5)
      .map(v => ({ _id: v._id, title: v.title, views: v.views, likes: v.likes?.length || 0 }));

    // Distribution tier
    const tierCounts = videos.reduce((acc, v) => {
      const tier = v.moderation?.promo_tier || 'standard';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});

    // Earnings simulés (0.001 TPC par vue)
    const wallet = await ensureWallet(req.userId);
    const earnedToday = videos
      .filter(v => new Date(v.createdAt) > new Date(Date.now() - 86400000))
      .reduce((s, v) => s + (v.views || 0) * 0.001, 0);

    res.json({
      success: true,
      stats: {
        total_videos:   totalVideos,
        total_views:    totalViews,
        total_likes:    totalLikes,
        total_shares:   totalShares,
        total_comments: totalComments,
        avg_views:      totalVideos ? Math.round(totalViews / totalVideos) : 0,
        engagement_rate: totalViews ? ((totalLikes + totalComments) / totalViews * 100).toFixed(2) : '0',
        tier_distribution: tierCounts,
        wallet_balance: wallet.balance,
        earned_today: Math.round(earnedToday * 100) / 100,
      },
      top_videos: topVideos,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LIVE
// ══════════════════════════════════════════════════════════════════════════

// POST /api/studio/live/start
router.post('/live/start', verifyToken, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Titre requis' });

    // Vérifier qu'aucun live n'est déjà actif
    const existing = await LiveSession.findOne({ author: req.userId, status: { $in: ['waiting', 'live'] } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Un live est déjà en cours', live: existing });
    }

    const streamKey = `setraf-${req.userId}-${Date.now()}`;
    const live = await LiveSession.create({
      author: req.userId,
      title,
      description: description || '',
      status: 'live',
      stream_key: streamKey,
      started_at: new Date(),
    });

    res.status(201).json({ success: true, live, stream_key: streamKey });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/end
router.post('/live/end', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOneAndUpdate(
      { author: req.userId, status: 'live' },
      { status: 'ended', ended_at: new Date(), duration: Math.round((Date.now() - Date.now()) / 1000) },
      { new: true }
    );
    if (!live) return res.status(404).json({ success: false, message: 'Aucun live actif' });

    // Récompense vues live
    const reward = Math.floor((live.peak_viewers || 0) * 0.01);
    if (reward > 0) {
      const wallet = await ensureWallet(req.userId);
      wallet.balance      += reward;
      wallet.total_earned += reward;
      await wallet.save();
      await Transaction.create({
        user: req.userId, type: 'earn_views', amount: reward,
        balance_after: wallet.balance, description: `📺 Gains live: ${live.peak_viewers} viewers`,
        ref_id: live._id.toString(), ref_type: 'live',
      });
    }

    res.json({ success: true, live, reward });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/status
router.get('/live/status', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOne({
      author: req.userId,
      status: { $in: ['waiting', 'live'] },
    });
    res.json({ success: true, live: live || null, is_live: !!live });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/active — liste tous les lives actifs (feed)
router.get('/live/active', async (req, res) => {
  try {
    const lives = await LiveSession.find({ status: 'live' })
      .populate('author', 'name profilePhoto')
      .sort({ 'viewers.length': -1 })
      .lean();
    res.json({ success: true, lives });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/moderate — pré-modération d'un texte côté studio
router.post('/moderate', verifyToken, async (req, res) => {
  try {
    const { text, content_type } = req.body;
    if (!text) return res.status(400).json({ success: false, message: 'Texte requis' });
    const result = await moderateContent(text, content_type || 'post');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
