const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { studioUpload } = require('../cloudynary');
const { Video, LiveSession, LiveOrder, DeliveryLocation, CreatorFollow, VideoComment } = require('../models/Video');
const { Wallet, Transaction } = require('../models/Wallet');
const fetch = require('node-fetch');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const mongoose = require('mongoose');

// ── Schéma Publicité Hub ─────────────────────────────────────────────────────
const adSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 200 },
  description: { type: String, maxlength: 500 },
  imageUrl: { type: String },
  linkUrl: { type: String },
  active: { type: Boolean, default: true },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date },
}, { timestamps: true });

const Ad = mongoose.models.Ad || mongoose.model('Ad', adSchema);

const os = require('os');
const MODERATION_URL = process.env.MODERATION_API_URL || 'http://localhost:8001';
const VLM_API_URL    = process.env.VLM_API_URL   || 'http://vlm-api:8005';

// ── Détection automatique IP LAN (pour URLs RTMP/HLS) ───────────────────────
// En Docker le réseau hôte est accessible via host.docker.internal,
// mais le téléphone doit atteindre l'IP LAN réelle du serveur.
function getServerLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('172.') && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
const SERVER_LAN_IP = process.env.RTMP_PUBLIC_HOST && process.env.RTMP_PUBLIC_HOST !== 'localhost' && process.env.RTMP_PUBLIC_HOST !== '127.0.0.1'
  ? process.env.RTMP_PUBLIC_HOST
  : getServerLanIp();
console.log(`📡 RTMP/HLS host résolu : ${SERVER_LAN_IP}`);

// Multer mémoire pour les images VLM (max 10 Mo)
const vlmUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helper : analyse textuelle pré-upload via VLM ─────────────────────
// Utilisé avant l'upload pour un retour rapide sur titre/description/tags.
// Toujours permissif — la vraie modération se fait avec la vidéo après upload.
async function vlmAnalyzeText(text, title = '', description = '', tags = []) {
  try {
    const form = new FormData();
    form.append('text', String(text).slice(0, 1000));
    const tagsStr = Array.isArray(tags) ? tags.join(', ') : String(tags || '');
    form.append('context', `Vidéo "${title}" | Tags: ${tagsStr} | Plateforme grand public`);
    const { data } = await axios.post(`${VLM_API_URL}/analyze-content`, form, {
      headers: form.getHeaders(),
      timeout: 15000,
    });
    const isSafe = data.safe !== false;
    return {
      approved: isSafe,
      flags: data.categories || [],
      promo_score: isSafe ? 0.7 : 0.3,
      promo_tier: isSafe ? 'standard' : 'rejected',
      promotion_eligible: isSafe,
      reason: data.reason || '',
      recommendations: [],
      is_text_only: true,
    };
  } catch {
    // Fallback : permissif — la vraie modération se fait après upload
    return { approved: true, flags: [], promo_score: 0.65, promo_tier: 'standard', promotion_eligible: true, is_text_only: true };
  }
}

// ── Helper : modération vidéo complète post-upload via VLM ────────────
// Appelé après l'upload avec l'URL Cloudinary de la vidéo.
// Analyse frame par frame + titre/description → verdict complet.
async function vlmModerateVideo({ video_url, title, description, tags }) {
  try {
    const form = new FormData();
    form.append('video_url', video_url);
    form.append('title', title || '');
    form.append('description', String(description || '').slice(0, 500));
    form.append('tags', Array.isArray(tags) ? tags.join(',') : String(tags || ''));
    form.append('frame_count', '6');
    const { data } = await axios.post(`${VLM_API_URL}/video/moderate-full`, form, {
      headers: form.getHeaders(),
      timeout: 120000, // 2 min max pour l'analyse complète
    });
    const score = Math.max(0, Math.min(100, data.score || 70));
    return {
      approved: data.approved !== false,
      score,
      tier: data.tier || 'standard',
      flags: data.categories_detectees || [],
      promo_score: score / 100,
      promo_tier: data.tier || 'standard',
      promotion_eligible: data.approved !== false && score >= 50,
      recommendations: data.recommendations || [],
      title_suggestions: data.title_suggestions || [],
      description_improved: data.description_improved || '',
      reason: data.reason || '',
      frames_analyzed: data.frames_analyzed || 0,
      analysis_time: data.analysis_time_seconds || 0,
    };
  } catch (err) {
    console.warn('[VLM] vlmModerateVideo fallback:', err.message);
    return { approved: true, score: 65, tier: 'standard', flags: [], promo_score: 0.65, promo_tier: 'standard', promotion_eligible: true, recommendations: [], title_suggestions: [], description_improved: '', reason: 'Analyse VLM indisponible' };
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

    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    const parsedTags = tags
      ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim()))
      : [];

    // VLM modération — frame-par-frame si URL vidéo disponible, sinon texte seul
    let modResult;
    if (videoFile?.path) {
      modResult = await vlmModerateVideo({
        video_url: videoFile.path,
        title,
        description: description || '',
        tags: parsedTags,
      });
    } else {
      modResult = await vlmAnalyzeText(
        `${title} ${description || ''}`,
        title, description || '', parsedTags,
      );
    }

    // Auto-publish si la modération approuve le contenu
    const autoPublished = modResult.approved === true && (modResult.score || 0) >= 50;

    const videoData = {
      author: req.userId,
      title,
      description: description || '',
      tags: parsedTags,
      visibility: autoPublished ? 'public' : (visibility || 'draft'),
      moderation: {
        approved:    modResult.approved,
        score:       modResult.score || 0,
        tier:        modResult.tier || 'standard',
        flags:       modResult.flags || [],
        promo_score: modResult.promo_score || 0,
        promo_tier:  modResult.promo_tier || 'standard',
        checked_at:  new Date(),
        reason:      modResult.reason || '',
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

    videoData.algorithm_score = modResult.score || Math.round((modResult.promo_score || 0.5) * 100);

    const video = await Video.create(videoData);

    res.status(201).json({
      success: true,
      video,
      auto_published: autoPublished,
      moderation: modResult,
      recommendations: modResult.recommendations || [],
      title_suggestions: modResult.title_suggestions || [],
      description_improved: modResult.description_improved || '',
      algorithm: { score: videoData.algorithm_score, tier: modResult.tier || 'standard' },
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
    const videos = await Video.find({ visibility: 'public' })
      .sort({ algorithm_score: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('author', 'name profileImage')
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
      .populate('author', 'name profileImage department')
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
      const modResult = await vlmAnalyzeText(`${title || video.title} ${description || video.description}`, title || video.title, description || video.description, video.tags || []);
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
    // Support update monetization fields from studio edit page
    if (req.body.monetization) {
      const m = req.body.monetization;
      video.monetization = video.monetization || {};
      if (typeof m.enabled !== 'undefined') video.monetization.enabled = Boolean(m.enabled);
      if (typeof m.price_tpc !== 'undefined') video.monetization.price_tpc = Number(m.price_tpc) || 0;
      if (typeof m.preview_seconds !== 'undefined') video.monetization.preview_seconds = Number(m.preview_seconds) || 30;
    }

    // Lock settings: lock video after N seconds of viewing (per-user)
    if (typeof req.body.lock_enabled !== 'undefined') video.lock_enabled = Boolean(req.body.lock_enabled);
    if (typeof req.body.lock_after_seconds !== 'undefined') video.lock_after_seconds = Number(req.body.lock_after_seconds) || 30;

    // When publishing, auto-approve so the video appears in the public feed
    if (visibility === 'public') {
      if (!video.moderation) video.moderation = {};
      video.moderation.approved = true;
      video.markModified('moderation');
    }

    video.markModified('monetization');
    video.updatedAt = new Date();

    await video.save();
    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/studio/video/:id/generate-trailer
// Generates a short trailer clip (Cloudinary transform) and requests VLM assistance for metadata.
router.post('/video/:id/generate-trailer', verifyToken, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, author: req.userId });
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    const length = Number(req.body.length) || 15; // seconds
    if (!video.videoPublicId && !video.videoUrl) return res.status(400).json({ success: false, message: 'Aucun média vidéo trouvé' });

    // compute start offset centered
    const duration = Number(video.duration || 0);
    let start = 0;
    if (duration > length) start = Math.max(0, Math.floor((duration - length) / 2));

    // mark pending
    video.trailerStatus = 'pending';
    await video.save();

    // Build Cloudinary transformed URL for the trailer
    const publicId = video.videoPublicId || video.videoUrl;
    // Use cloudinary to build a transformed video URL with start_offset and duration
    const trailerUrl = require('../cloudynary').cloudinary.url(publicId, {
      resource_type: 'video',
      transformation: [
        { start_offset: start, duration: length, fetch_format: 'mp4', quality: 'auto' }
      ]
    });

    // Optionally call VLM to create a short caption/description for the trailer using thumbnail frame
    let vlm_notes = {};
    try {
      // request a title/caption using the thumbnail frame at middle
      const framePercent = Math.min(50, Math.max(10, Math.round(((start + length / 2) / Math.max(duration, 1)) * 100)));
      const frameUrl = (video.videoUrl || video.videoUrl) + ''; // fallback
      // call VLM title/caption endpoint using axios and form-data
      const FormData = require('form-data');
      const axios = require('axios');
      const form = new FormData();
      // Use cloudinary frame URL helper: so_{pct}p
      const framePublicUrl = require('../cloudynary').getTransformedUrl(video.videoPublicId || video.videoUrl, { resource_type: 'video', transformation: [{ start_offset: start + 0, fetch_format: 'jpg', quality: 'auto' }] });
      // If VLM accepts image upload by URL, send URL as text context
      form.append('title', video.title || '');
      form.append('language', 'fr');
      // Use thumbnail/caption generation by posting the frame URL as 'image_url' if supported, else call /video/title with the thumbnail file not available — we fallback to /video/title by sending nothing
      const vlmResp = await axios.post(`${VLM_API_URL}/video/title`, form, { headers: form.getHeaders(), timeout: 30000 }).catch(() => null);
      if (vlmResp && vlmResp.data) vlm_notes = vlmResp.data;
    } catch (e) {
      // ignore VLM failures for trailer generation
    }

    // persist trailer info
    video.trailerUrl = trailerUrl;
    video.trailerGeneratedAt = new Date();
    video.trailerStatus = 'ready';
    await video.save();

    res.json({ success: true, trailerUrl, vlm_notes });
  } catch (err) {
    console.error('generate-trailer error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/studio/video/:id/view-progress
// Track viewer progress (seconds) and inform caller if preview limit reached and video locked for this user
router.post('/video/:id/view-progress', verifyToken, async (req, res) => {
  try {
    const { seconds = 0 } = req.body;
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    const uid = req.userId;
    const vp = video.view_progress || [];
    let entry = vp.find(p => String(p.user) === String(uid));
    if (!entry) {
      entry = { user: uid, seconds: 0, locked: false, last_seen: new Date() };
      vp.push(entry);
    }
    entry.seconds = Math.max(entry.seconds || 0, Number(seconds || 0));
    entry.last_seen = new Date();

    // enforce lock if enabled and user not unlocked
    let lockedNow = false;
    if (video.lock_enabled && !video.unlocked_by?.find(u => String(u) === String(uid))) {
      const threshold = Number(video.lock_after_seconds || video.monetization?.preview_seconds || 30);
      if (entry.seconds >= threshold) {
        entry.locked = true;
        lockedNow = true;
      }
    }

    video.view_progress = vp;
    await video.save();

    res.json({ success: true, seconds: entry.seconds, locked: Boolean(entry.locked), lockedNow });
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

// POST /api/studio/video/:id/unlock — débloquer une vidéo payante
router.post('/video/:id/unlock', verifyToken, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    const isPaywall = (video.monetization && video.monetization.enabled) || video.lock_enabled;
    if (!isPaywall) return res.status(400).json({ success: false, message: 'Cette vidéo n\'est pas payante' });

    // Vérifier si déjà débloqué
    const alreadyUnlocked = (video.unlocked_by || []).some(id => String(id) === String(req.userId));
    if (alreadyUnlocked) {
      return res.json({ success: true, message: 'Déjà débloqué', already_unlocked: true });
    }

    const price = Number(video.monetization?.price_tpc || 0);
    if (price <= 0) return res.status(400).json({ success: false, message: 'Prix invalide' });

    // Vérifier solde utilisateur
    const wallet = await Wallet.findOne({ user: req.userId });
    if (!wallet || wallet.balance < price) return res.status(402).json({ success: false, message: 'Solde insuffisant' });

    // Débit utilisateur
    wallet.balance -= price;
    wallet.total_spent = (wallet.total_spent || 0) + price;
    await wallet.save();

    // Crédit auteur
    const authorWallet = await ensureWallet(String(video.author));
    const authorShare = Math.floor(price * 0.8);
    authorWallet.balance += authorShare;
    authorWallet.total_earned = (authorWallet.total_earned || 0) + authorShare;
    await authorWallet.save();

    // Transaction records
    await Transaction.create({ user: req.userId, type: 'video_unlock', amount: -price, balance_after: wallet.balance, description: `Déblocage vidéo ${video._id}` , ref_id: video._id, ref_type: 'video' });
    await Transaction.create({ user: video.author, type: 'video_earn', amount: authorShare, balance_after: authorWallet.balance, description: `Vente vidéo ${video._id}`, ref_id: video._id, ref_type: 'video' });

    // Ajouter à unlocked_by
    if (!video.unlocked_by) video.unlocked_by = [];
    if (!video.unlocked_by.find(u => String(u) === String(req.userId))) {
      video.unlocked_by.push(req.userId);
      await video.save();
    }

    res.json({ success: true, message: 'Vidéo débloquée', price_tpc: price, balance_after: wallet.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LIKE / FOLLOW VIDÉO
// ══════════════════════════════════════════════════════════════════════════

// POST /api/studio/video/:id/like — toggle like sur une vidéo
router.post('/video/:id/like', verifyToken, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    if (!video.likes) video.likes = [];
    const idx = video.likes.findIndex(u => String(u) === String(req.userId));
    let liked = false;

    if (idx > -1) {
      video.likes.splice(idx, 1);
      liked = false;
    } else {
      video.likes.push(req.userId);
      liked = true;
    }
    await video.save();

    res.json({ success: true, liked, likes_count: video.likes.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/creator/:id/follow — toggle follow sur un créateur
router.post('/creator/:id/follow', verifyToken, async (req, res) => {
  try {
    const creatorId = req.params.id;
    if (String(creatorId) === String(req.userId)) {
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas vous suivre vous-même' });
    }

    const existing = await CreatorFollow.findOne({ follower: req.userId, creator: creatorId });
    let following = false;

    if (existing) {
      await CreatorFollow.deleteOne({ _id: existing._id });
      following = false;
    } else {
      await CreatorFollow.create({ follower: req.userId, creator: creatorId });
      following = true;
    }

    const followers_count = await CreatorFollow.countDocuments({ creator: creatorId });
    res.json({ success: true, following, followers_count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/creator/:id/follow-status — statut follow + compteur abonnés
router.get('/creator/:id/follow-status', verifyToken, async (req, res) => {
  try {
    const creatorId = req.params.id;
    const follow = await CreatorFollow.findOne({ follower: req.userId, creator: creatorId });
    const followers_count = await CreatorFollow.countDocuments({ creator: creatorId });
    res.json({ success: true, following: !!follow, followers_count });
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

    // 5 vidéos les plus récentes (pour le hub)
    const recentVideos = [...videos]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5)
      .map(v => ({
        _id: v._id,
        title: v.title,
        views: v.views || 0,
        likes: v.likes?.length || 0,
        visibility: v.visibility,
        approved: v.moderation?.approved,
        score: v.moderation?.score || 0,
        tier: v.moderation?.tier || 'standard',
        thumbnailUrl: v.thumbnailUrl,
        videoUrl: v.videoUrl,
        createdAt: v.createdAt,
      }));

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

    // Compteur d'abonnés
    const followers_count = await CreatorFollow.countDocuments({ creator: req.userId });

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
        followers_count,
      },
      top_videos: topVideos,
      recent_videos: recentVideos,
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

    // URLs RTMP/HLS — IP LAN réelle (pas le hostname tunnel)
    const rtmpUrl  = `rtmp://${SERVER_LAN_IP}:1935/live/${streamKey}`;
    const hlsUrl   = `http://${SERVER_LAN_IP}:8080/hls/${streamKey}.m3u8`;

    // Notifier les abonnés du créateur via WebSocket
    if (req.app.locals.broadcastLiveStarted) {
      const followers = await CreatorFollow.find({ creator: req.userId }).select('follower').lean();
      followerIds = followers.map(f => String(f.follower));
      req.app.locals.broadcastLiveStarted(followerIds, {
        type: 'creator_live_started',
        liveId: live._id,
        creatorId: req.userId,
        title: live.title,
        hlsUrl,
        stream_key: streamKey,
        startedAt: live.started_at,
      });
    }

    res.status(201).json({ success: true, live, liveId: live._id, stream_key: streamKey, rtmpUrl, hlsUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/end
router.post('/live/end', verifyToken, async (req, res) => {
  try {
    const activeLive = await LiveSession.findOne({ author: req.userId, status: 'live' });
    if (!activeLive) return res.status(404).json({ success: false, message: 'Aucun live actif' });

    const durationSec = activeLive.started_at
      ? Math.round((Date.now() - new Date(activeLive.started_at).getTime()) / 1000)
      : 0;

    const live = await LiveSession.findByIdAndUpdate(
      activeLive._id,
      { status: 'ended', ended_at: new Date(), duration: durationSec },
      { new: true }
    );

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
    let rtmpUrl = null, hlsUrl = null;
    if (live?.stream_key) {
      rtmpUrl = `rtmp://${SERVER_LAN_IP}:1935/live/${live.stream_key}`;
      hlsUrl  = `http://${SERVER_LAN_IP}:8080/hls/${live.stream_key}.m3u8`;
    }
    res.json({ success: true, live: live || null, is_live: !!live, rtmpUrl, hlsUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/active — liste tous les lives actifs (feed)
router.get('/live/active', async (req, res) => {
  try {
    const lives = await LiveSession.find({ status: 'live' })
      .populate('author', 'name profileImage')
      .sort({ 'viewers.length': -1 })
      .lean();
    res.json({ success: true, lives });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/studio/live/:liveId — Supprimer/forcer l'arrêt d'un live non terminé
router.delete('/live/:liveId', verifyToken, async (req, res) => {
  try {
    const { liveId } = req.params;
    const live = await LiveSession.findById(liveId);
    if (!live) return res.status(404).json({ success: false, message: 'Live introuvable' });

    // Seul l'auteur du live peut le supprimer
    if (String(live.author) !== String(req.userId)) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }

    // Forcer le status à "ended" et enregistrer la date de fin
    live.status   = 'ended';
    live.ended_at = new Date();
    if (live.started_at) {
      live.duration = Math.round((Date.now() - new Date(live.started_at).getTime()) / 1000);
    }
    await live.save();

    res.json({ success: true, message: 'Live terminé et supprimé de la liste' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/:liveId/order — Passer une commande pendant un live
// Flux: VLM anti-abus → débit Topocoin → création LiveOrder → position queue
router.post('/live/:liveId/order', verifyToken, async (req, res) => {
  try {
    const { liveId } = req.params;
    const { items, total_tpc, user_comment } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: 'items requis' });
    if (!total_tpc || total_tpc <= 0)
      return res.status(400).json({ success: false, message: 'Montant invalide' });

    // 1. Vérifier que le live est actif
    const live = await LiveSession.findById(liveId);
    if (!live || live.status !== 'live')
      return res.status(404).json({ success: false, message: 'Live non trouvé ou terminé' });

    // 2. Anti-abus : limiter à 1 commande pending par utilisateur par live
    const existingPending = await LiveOrder.findOne({ liveId, userId: req.userId, status: 'pending' });
    if (existingPending)
      return res.status(429).json({ success: false, message: 'Commande précédente toujours en cours. Attendez qu\'elle soit traitée.' });

    // 3. VLM modération (commentaire libre anti-abus)
    let vlm_validated = true;
    let vlm_note = 'Commande approuvée';
    if (user_comment && user_comment.trim()) {
      try {
        const vlmRes = await axios.post(`${VLM_API_URL}/validate-payment`, {
          amount: total_tpc,
          currency: 'TPC',
          user_id: req.userId,
          description: user_comment,
        }, { timeout: 10000 });
        vlm_validated = vlmRes.data?.valid !== false;
        vlm_note = vlmRes.data?.reason || 'Approuvé par VLM';
      } catch (_) {
        // VLM optionnel — on approuve par défaut
      }
    }

    if (!vlm_validated)
      return res.status(400).json({ success: false, message: `Commande rejetée: ${vlm_note}` });

    // 4. Débit wallet Topocoin
    const wallet = await ensureWallet(req.userId);
    if (wallet.balance < total_tpc)
      return res.status(402).json({ success: false, message: `Solde insuffisant. Solde: ${wallet.balance} TPC, Requis: ${total_tpc} TPC` });

    wallet.balance    -= total_tpc;
    wallet.total_spent += total_tpc;
    await wallet.save();

    // 5. Crédit restaurant / auteur du live
    const authorWallet = await ensureWallet(live.author);
    const restaurantCut = Math.floor(total_tpc * 0.8);  // 80% au resto
    const platformFee   = total_tpc - restaurantCut;
    authorWallet.balance      += restaurantCut;
    authorWallet.total_earned += restaurantCut;
    await authorWallet.save();

    // 6. Transaction pour le client
    const queuePos = (await LiveOrder.countDocuments({ liveId, status: { $in: ['pending', 'preparing'] } })) + 1;

    await Transaction.create({
      user: req.userId, type: 'order_pay', amount: -total_tpc,
      balance_after: wallet.balance,
      description: `🛒 Commande live #${queuePos}: ${items.map(i => i.name).join(', ')}`,
      ref_id: liveId, ref_type: 'live',
    });
    await Transaction.create({
      user: live.author, type: 'order_earn', amount: restaurantCut,
      balance_after: authorWallet.balance,
      description: `📦 Commande reçue (live) — ${restaurantCut} TPC`,
      ref_id: liveId, ref_type: 'live',
    });

    // 7. Créer la LiveOrder
    const order = await LiveOrder.create({
      liveId, userId: req.userId,
      items: items.map(i => ({ emoji: i.emoji || '🍽️', name: i.name, quantity: i.quantity || 1, price_tpc: i.price_tpc })),
      total_tpc, status: 'pending', queue_position: queuePos,
      vlm_validated, vlm_note,
      user_comment: user_comment || '',
    });

    res.status(201).json({
      success: true, order,
      queue_position: queuePos,
      balance_after: wallet.balance,
      message: `✅ Commande #${queuePos} confirmée! ${total_tpc} TPC débités.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/:liveId/orders — File d'attente du live
router.get('/live/:liveId/orders', verifyToken, async (req, res) => {
  try {
    const { liveId } = req.params;
    const orders = await LiveOrder.find({ liveId, status: { $in: ['pending', 'preparing'] } })
      .populate('userId', 'name profilePhoto')
      .sort({ queue_position: 1 })
      .lean();
    const myOrder = orders.find(o => String(o.userId?._id || o.userId) === String(req.userId));
    res.json({ success: true, orders, my_order: myOrder || null, queue_length: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/:liveId/react — Réaction emoji
router.post('/live/:liveId/react', verifyToken, async (req, res) => {
  try {
    // Route légère — réactions non persistées, juste accusé réception
    // En production remplacer par WebSocket broadcast
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ success: false, message: 'emoji requis' });
    res.json({ success: true, emoji, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — HLS PROXY (segments HLS servis via le tunnel backend)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/studio/live/hls/:filename — proxy transparent vers nginx-rtmp:8080
// Permet aux viewers de regarder via le tunnel HTTPS sans exposer le port 8080
router.get('/live/hls/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    // Sécurité : autoriser uniquement les fichiers HLS valides (pas de path traversal)
    if (!/^[\w\-]+\.(m3u8|ts)$/.test(filename)) {
      return res.status(400).json({ error: 'Nom de fichier invalide' });
    }
    const hlsBase = process.env.HLS_BASE_URL || 'http://center-rtmp:8080/hls';
    const response = await axios.get(`${hlsBase}/${filename}`, {
      responseType: 'stream',
      timeout: 10000,
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    response.data.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'Segment HLS non trouvé' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — MENU DU JOUR (items commandables pendant le live)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/studio/live/:liveId/info — infos live complètes pour les viewers
router.get('/live/:liveId/info', async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId)
      .populate('author', 'name profileImage')
      .lean();
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });

    // Seuls les items actifs sont visibles des spectateurs
    const menuVisible = (live.menu_items || []).filter(i => i.available !== false);

    // HLS — URL directe (LAN) + chemin proxy API
    const hlsUrl   = live.stream_key
      ? `http://${SERVER_LAN_IP}:8080/hls/${live.stream_key}.m3u8`
      : null;
    // Chemin relatif que le client Flutter préfixe avec son baseUrl
    const hlsPath  = live.stream_key
      ? `/api/studio/live/hls/${live.stream_key}.m3u8`
      : null;

    res.json({
      success:      true,
      liveId:       live._id,
      isLive:       live.status === 'live',
      liveTitle:    live.title,
      viewerCount:  live.viewers ? live.viewers.length : 0,
      liveDiscount: 0,
      menu:         menuVisible,
      creatorId:    live.author?._id,
      creatorName:  live.author?.name ?? '',
      creatorAvatar: live.author?.profileImage ?? '',
      hlsUrl,
      hlsPath,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/:liveId/menu — menu public visible par les spectateurs
router.get('/live/:liveId/menu', async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId).select('menu_items title status').lean();
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });
    res.json({ success: true, menu: live.menu_items || [], status: live.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/:liveId/menu — créateur ajoute un item au menu
router.post('/live/:liveId/menu', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOne({ _id: req.params.liveId, author: req.userId });
    if (!live) return res.status(403).json({ success: false, message: 'Non autorisé ou live inexistant' });

    const { emoji, name, price_tpc, image_url } = req.body;
    if (!name || price_tpc == null) return res.status(400).json({ success: false, message: 'name et price_tpc requis' });

    live.menu_items.push({ emoji: emoji || '🍽️', name, price_tpc: Number(price_tpc), available: true, image_url: image_url || '' });
    await live.save();
    const item = live.menu_items[live.menu_items.length - 1];
    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/studio/live/:liveId/menu/:itemId — toggle disponibilité ou modif prix
router.put('/live/:liveId/menu/:itemId', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOne({ _id: req.params.liveId, author: req.userId });
    if (!live) return res.status(403).json({ success: false, message: 'Non autorisé' });

    const item = live.menu_items.id(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Item non trouvé' });

    if (req.body.available !== undefined) item.available = req.body.available;
    if (req.body.name) item.name = req.body.name;
    if (req.body.price_tpc != null) item.price_tpc = Number(req.body.price_tpc);
    if (req.body.emoji) item.emoji = req.body.emoji;
    await live.save();
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/studio/live/:liveId/menu/:itemId — supprimer un item
router.delete('/live/:liveId/menu/:itemId', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOne({ _id: req.params.liveId, author: req.userId });
    if (!live) return res.status(403).json({ success: false, message: 'Non autorisé' });

    live.menu_items.pull({ _id: req.params.itemId });
    await live.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — MODÉRATION MESSAGES (Mistral/VLM)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/studio/live/check-message — vérifier un message avant envoi
router.post('/live/check-message', verifyToken, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, message: 'Message vide' });

    // Patterns de base (sync)
    const PHONE_RE  = /(\+?\d[\d\s\-().]{6,}\d)/g;
    const URL_RE    = /https?:\/\/\S+/gi;
    const SOCIAL_RE = /(@\w{3,}|wa\.me|t\.me|bit\.ly|tinyurl)/gi;
    const raw = message.trim();

    if (PHONE_RE.test(raw) || URL_RE.test(raw) || SOCIAL_RE.test(raw)) {
      return res.json({ safe: false, reason: 'Numéros de téléphone, liens et contacts externes interdits.' });
    }

    // Analyse Mistral (texte)
    try {
      const vlmRes = await axios.post(`${VLM_API_URL}/analyze-content`, {
        text: raw,
        context: 'message de chat live business'
      }, { timeout: 8000 });
      const { safe, reason } = vlmRes.data || {};
      return res.json({ safe: safe !== false, reason: reason || 'OK' });
    } catch (_) {
      // VLM indisponible → approuver par défaut
      return res.json({ safe: true, reason: 'OK' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — ABONNEMENTS CRÉATEUR
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/studio/live/:liveId/subscribe — s'abonner au créateur depuis le live
router.post('/live/:liveId/subscribe', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId).lean();
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });
    if (String(live.author) === String(req.userId)) {
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas vous abonner à vous-même' });
    }

    // Créer la relation de follow (upsert)
    await CreatorFollow.findOneAndUpdate(
      { follower: req.userId, creator: live.author },
      { follower: req.userId, creator: live.author, from_live: live._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Enregistrer l'abonné dans la session live
    await LiveSession.updateOne(
      { _id: req.params.liveId },
      { $addToSet: { subscribers: req.userId } }
    );

    res.json({ success: true, message: 'Abonnement confirmé !' });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, message: 'Déjà abonné' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/:liveId/subscribed — vérifie si l'utilisateur est abonné
router.get('/live/:liveId/subscribed', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId).lean();
    if (!live) return res.status(404).json({ success: false });
    const follow = await CreatorFollow.findOne({ follower: req.userId, creator: live.author });
    res.json({ success: true, subscribed: !!follow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — GÉOLOCALISATION LIVREUR EN TEMPS RÉEL
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/studio/live/order/:orderId/location — livreur met à jour sa position
router.post('/live/order/:orderId/location', verifyToken, async (req, res) => {
  try {
    const { latitude, longitude, accuracy, speed, heading } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'latitude et longitude requis' });
    }

    const loc = await DeliveryLocation.findOneAndUpdate(
      { orderId: req.params.orderId },
      {
        orderId: req.params.orderId,
        deliverId: req.userId,
        latitude: Number(latitude),
        longitude: Number(longitude),
        accuracy: Number(accuracy) || 0,
        speed: Number(speed) || 0,
        heading: Number(heading) || 0,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Broadcast via WebSocket au client qui suit cette commande
    if (req.app.locals.broadcastDelivery) {
      req.app.locals.broadcastDelivery(req.params.orderId, {
        type: 'delivery_location',
        orderId: req.params.orderId,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        speed: loc.speed,
        heading: loc.heading,
        updatedAt: loc.updatedAt,
      });
    }

    res.json({ success: true, location: loc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/order/:orderId/location — client obtient la dernière position
router.get('/live/order/:orderId/location', verifyToken, async (req, res) => {
  try {
    const loc = await DeliveryLocation.findOne({ orderId: req.params.orderId }).lean();
    if (!loc) return res.json({ success: false, message: 'Aucune position disponible' });
    res.json({ success: true, location: loc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/moderate — pré-modération d'un texte côté studio
router.post('/moderate', verifyToken, async (req, res) => {
  try {
    const { title, description, tags, text, content_type } = req.body;
    // Supporte le format Flutter {title, description, tags} et le format legacy {text}
    const rawText = text || [
      title || '',
      description || '',
      Array.isArray(tags) ? tags.join(' ') : String(tags || ''),
    ].join(' ').trim();

    if (!rawText) return res.status(400).json({ success: false, message: 'Contenu requis' });

    const result = await vlmAnalyzeText(rawText, title, description, tags);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// VLM — Intelligence artificielle (SmolVLM + MiniLM)
// Proxy Node.js → VLM API (port 8005)
// ══════════════════════════════════════════════════════════════════════════

// Helper : forward multipart image + fields vers VLM
async function forwardToVlm(endpoint, imageBuffer, imageName, imageMime, fields = {}) {
  const form = new FormData();
  form.append('image', imageBuffer, { filename: imageName, contentType: imageMime });
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null) form.append(k, String(v));
  });
  const { data } = await axios.post(`${VLM_API_URL}${endpoint}`, form, {
    headers: form.getHeaders(),
    timeout: 30000,
  });
  return data;
}

// POST /api/studio/vlm/auto-tags — Génère des tags SEO + hashtags depuis la miniature
// Body (multipart) : image*, title?, description?, category?
router.post('/vlm/auto-tags', verifyToken, vlmUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Image requise (champ: image)' });
    const { title, description, category } = req.body;
    const result = await forwardToVlm('/video/auto-tags', req.file.buffer, req.file.originalname, req.file.mimetype, { title, description, category });
    res.json({ success: true, ...result });
  } catch (err) {
    console.warn('[VLM] auto-tags indisponible:', err.message);
    res.status(503).json({ success: false, message: 'Génération IA temporairement indisponible' });
  }
});

// POST /api/studio/vlm/title — Génère 5 suggestions de titres YouTube depuis la miniature
// Body (multipart) : image*, existing_title?, style?, language?
router.post('/vlm/title', verifyToken, vlmUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Image requise (champ: image)' });
    const { existing_title, style, language } = req.body;
    const result = await forwardToVlm('/video/title', req.file.buffer, req.file.originalname, req.file.mimetype, { existing_title, style: style || 'engaging', language: language || 'fr' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.warn('[VLM] title indisponible:', err.message);
    res.status(503).json({ success: false, message: 'Génération IA temporairement indisponible' });
  }
});

// POST /api/studio/vlm/description — Génère une description SEO complète depuis la miniature
// Body (multipart) : image*, title*, existing_description?, language?, include_cta?
router.post('/vlm/description', verifyToken, vlmUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Image requise (champ: image)' });
    const { title, existing_description, language, include_cta } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Titre requis' });
    const result = await forwardToVlm('/video/description', req.file.buffer, req.file.originalname, req.file.mimetype, { title, existing_description, language: language || 'fr', include_cta: include_cta ?? 'true' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.warn('[VLM] description indisponible:', err.message);
    res.status(503).json({ success: false, message: 'Génération IA temporairement indisponible' });
  }
});

// GET /api/studio/vlm/recommend/feed — Feed vidéo personnalisé (MiniLM + scoring)
// Query : userId?, limit?, category?, exclude_watched?
router.get('/vlm/recommend/feed', async (req, res) => {
  try {
    const { userId, limit = 20, category, exclude_watched = 'true' } = req.query;
    const params = new URLSearchParams({ limit, exclude_watched });
    if (userId) params.set('userId', userId);
    if (category) params.set('category', category);
    const { data } = await axios.get(`${VLM_API_URL}/recommend/feed?${params}`, { timeout: 10000 });
    res.json({ success: true, ...data });
  } catch (err) {
    console.warn('[VLM] recommend/feed indisponible:', err.message);
    res.json({ success: false, videos: [], total: 0, reason: 'Service IA indisponible' });
  }
});

// POST /api/studio/vlm/recommend/similar — Vidéos similaires par image ou texte
// Body (multipart) : image?, query?, limit?, exclude_id?, min_similarity?
router.post('/vlm/recommend/similar', vlmUpload.single('image'), async (req, res) => {
  try {
    const { query, limit = 10, exclude_id, min_similarity = 0.1 } = req.body;
    const form = new FormData();
    if (req.file) form.append('image', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    if (query) form.append('query', query);
    form.append('limit', String(limit));
    if (exclude_id) form.append('exclude_id', exclude_id);
    form.append('min_similarity', String(min_similarity));
    const { data } = await axios.post(`${VLM_API_URL}/recommend/similar`, form, {
      headers: form.getHeaders(),
      timeout: 15000,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.warn('[VLM] recommend/similar indisponible:', err.message);
    res.json({ success: false, similar_videos: [], total: 0, reason: 'Service IA indisponible' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — ENREGISTREMENT AUTOMATIQUE
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/studio/live/record-done — callback nginx-rtmp quand l'enregistrement est terminé
// Appelé automatiquement par exec_record_done dans nginx.conf
router.post('/live/record-done', async (req, res) => {
  try {
    const { path: filePath, name: streamName } = req.body;
    if (!streamName) return res.status(400).json({ error: 'stream name required' });

    // streamName = "setraf-userId-timestamp"
    const live = await LiveSession.findOne({ stream_key: streamName });
    if (!live) return res.status(404).json({ error: 'live not found' });

    // Récupérer la taille du fichier (si accessible)
    let sizeBytes = 0;
    try {
      const fs = require('fs');
      if (filePath && fs.existsSync(filePath)) {
        sizeBytes = fs.statSync(filePath).size;
      }
    } catch (_) {}

    const filename = filePath ? filePath.split('/').pop() : `${streamName}.flv`;
    live.recording = {
      path: filePath || `/recordings/${filename}`,
      filename,
      size_bytes: sizeBytes,
      duration_sec: live.duration || 0,
      ready: true,
      recorded_at: new Date(),
    };
    await live.save();

    // Auto-créer une story depuis le replay live (expire après 24h)
    try {
      const StoryModel = mongoose.model('Story');
      const recordingUrl = filePath || `http://${SERVER_LAN_IP}:8080/recordings/${filename}`;
      await StoryModel.create({
        userId: live.author,
        content: live.title || 'Replay de live',
        mediaUrl: recordingUrl,
        mediaType: 'video',
        backgroundColor: '#1a1a2e',
        duration: 30,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      console.log(`[RTMP] Story live créée pour ${streamName}`);
    } catch (storyErr) {
      console.error('[RTMP] Erreur création story:', storyErr.message);
    }

    console.log(`[RTMP] Recording saved for ${streamName}: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error('[RTMP] record-done error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/studio/live/recordings — liste des lives enregistrés (hub)
router.get('/live/recordings', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = {
      author: req.userId,
      status: 'ended',
      'recording.ready': true,
    };
    const recordings = await LiveSession.find(filter)
      .sort({ ended_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('title description duration peak_viewers started_at ended_at recording monetization viewers subscribers')
      .lean();

    const total = await LiveSession.countDocuments(filter);
    res.json({ success: true, recordings, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/recordings/all — tous les lives enregistrés (pour les viewers / hub public)
router.get('/live/recordings/all', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const recordings = await LiveSession.find({
      status: 'ended',
      'recording.ready': true,
    })
      .sort({ ended_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('author', 'name profileImage')
      .select('title description duration peak_viewers started_at ended_at recording monetization author')
      .lean();

    const total = await LiveSession.countDocuments({ status: 'ended', 'recording.ready': true });
    res.json({ success: true, recordings, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/live/recordings/:liveId/play — stream le fichier enregistré (proxy vers nginx-rtmp)
router.get('/live/recordings/:liveId/play', async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId).lean();
    if (!live || !live.recording?.ready) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // Vérifier monétisation : si payant, le viewer doit avoir débloqué
    if (live.monetization?.enabled && live.monetization?.price_fr > 0) {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Auth required for paid content' });
      const jwt = require('jsonwebtoken');
      let decoded;
      try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch (_) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      const userId = decoded.userId || decoded.id;
      const isOwner = String(live.author) === userId;
      const hasUnlocked = (live.unlocked_by || []).some(id => String(id) === userId);
      if (!isOwner && !hasUnlocked) {
        return res.status(402).json({
          error: 'Payment required',
          price_fr: live.monetization.price_fr,
          preview_seconds: live.monetization.preview_seconds,
        });
      }
    }

    // Proxy le fichier via nginx-rtmp HTTP
    const hlsBase = process.env.HLS_BASE_URL || 'http://center-rtmp:8080';
    const recordUrl = `${hlsBase.replace('/hls', '')}/recordings/${live.recording.filename}`;
    const response = await axios.get(recordUrl, { responseType: 'stream', timeout: 30000 });
    res.setHeader('Content-Type', 'video/x-flv');
    res.setHeader('Content-Disposition', `inline; filename="${live.recording.filename}"`);
    response.data.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'Recording unavailable' });
  }
});

// DELETE /api/studio/live/recordings/:liveId — supprimer un enregistrement
router.delete('/live/recordings/:liveId', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findOne({ _id: req.params.liveId, author: req.userId });
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });

    // Supprimer le fichier physique si accessible
    if (live.recording?.path) {
      try {
        const fs = require('fs');
        if (fs.existsSync(live.recording.path)) fs.unlinkSync(live.recording.path);
      } catch (_) {}
    }

    // Reset recording
    live.recording = { ready: false };
    await live.save();

    res.json({ success: true, message: 'Enregistrement supprimé' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE — MONÉTISATION / REPLAY PAYANT
// ══════════════════════════════════════════════════════════════════════════════

// PUT /api/studio/live/:liveId/monetize — configurer la monétisation d'un replay
router.put('/live/:liveId/monetize', verifyToken, async (req, res) => {
  try {
    const { enabled, price_fr, preview_seconds } = req.body;
    const live = await LiveSession.findOne({ _id: req.params.liveId, author: req.userId });
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });

    // Validation prix
    const price = Number(price_fr) || 0;
    if (enabled && (price < 50 || price > 100)) {
      return res.status(400).json({ success: false, message: 'Prix doit être entre 50 et 100 FR' });
    }

    // Validation VLM du contenu pour justifier le prix
    let vlmScore = 0, vlmReason = '', vlmValidated = false;
    if (enabled && price > 0) {
      try {
        const form = new FormData();
        form.append('text', `Live: "${live.title}" | ${live.description || ''} | Durée: ${live.duration}s | Peak viewers: ${live.peak_viewers} | Prix demandé: ${price} FR`);
        form.append('context', 'Validation prix replay live - évaluer si le contenu justifie ce prix selon la durée, les viewers et la qualité');
        const { data } = await axios.post(`${VLM_API_URL}/analyze-content`, form, {
          headers: form.getHeaders(),
          timeout: 15000,
        });
        vlmScore = Math.min(100, Math.max(0, data.score || 50));
        vlmValidated = vlmScore >= 40; // Seuil minimum
        vlmReason = data.reason || (vlmValidated ? 'Contenu validé par IA' : 'Contenu insuffisant pour ce prix');
      } catch (_) {
        // Fallback si VLM indisponible — valider à score moyen
        vlmScore = 60;
        vlmValidated = true;
        vlmReason = 'Validation auto (VLM indisponible)';
      }
    }

    live.monetization = {
      enabled: !!enabled,
      price_fr: enabled ? price : 0,
      preview_seconds: Math.max(10, Math.min(60, Number(preview_seconds) || 30)),
      vlm_validated: vlmValidated,
      vlm_score: vlmScore,
      vlm_reason: vlmReason,
    };
    await live.save();

    res.json({
      success: true,
      monetization: live.monetization,
      message: vlmValidated ? '✅ Prix validé par l\'IA' : '⚠️ L\'IA suggère un prix plus bas',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/live/:liveId/unlock — débloquer un replay payant (paiement Topocoin)
router.post('/live/:liveId/unlock', verifyToken, async (req, res) => {
  try {
    const live = await LiveSession.findById(req.params.liveId);
    if (!live) return res.status(404).json({ success: false, message: 'Live non trouvé' });
    if (!live.monetization?.enabled || !live.monetization?.price_fr) {
      return res.status(400).json({ success: false, message: 'Ce replay est gratuit' });
    }

    // Vérifier si déjà débloqué
    const already = (live.unlocked_by || []).some(id => String(id) === req.userId);
    if (already) return res.json({ success: true, message: 'Déjà débloqué', already_unlocked: true });

    // Conversion FR → TPC (1 FR = 1 TPC ici, ajustable)
    const costTpc = live.monetization.price_fr;

    // Débiter le wallet du viewer
    const wallet = await ensureWallet(req.userId);
    if (wallet.balance < costTpc) {
      return res.status(402).json({ success: false, message: 'Solde insuffisant', required: costTpc, balance: wallet.balance });
    }

    wallet.balance -= costTpc;
    await wallet.save();

    // Créer la transaction
    await Transaction.create({
      user: req.userId,
      type: 'purchase',
      amount: -costTpc,
      balance_after: wallet.balance,
      description: `🎬 Replay: ${live.title}`,
      ref_id: live._id.toString(),
      ref_type: 'live_replay',
    });

    // Créditer le créateur
    const creatorWallet = await ensureWallet(String(live.author));
    const creatorCut = Math.round(costTpc * 0.8); // 80% pour le créateur
    creatorWallet.balance += creatorCut;
    creatorWallet.total_earned = (creatorWallet.total_earned || 0) + creatorCut;
    await creatorWallet.save();

    await Transaction.create({
      user: String(live.author),
      type: 'earn_replay',
      amount: creatorCut,
      balance_after: creatorWallet.balance,
      description: `🎬 Vente replay: ${live.title}`,
      ref_id: live._id.toString(),
      ref_type: 'live_replay',
    });

    // Ajouter l'user aux débloqués
    live.unlocked_by = live.unlocked_by || [];
    live.unlocked_by.push(req.userId);
    await live.save();

    res.json({ success: true, message: 'Replay débloqué !', new_balance: wallet.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/channel/:userId — Chaîne publique d'un utilisateur
router.get('/channel/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const User = require('mongoose').model('User');

    // Infos profil de l'auteur
    let author = null;
    try {
      author = await User.findById(userId).select('name profileImage bio department').lean();
    } catch (_) {}

    // Vidéos publiques de cet utilisateur
    const videos = await Video.find({ author: userId, visibility: 'public' })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('author', 'name profileImage')
      .lean();

    const totalViews = videos.reduce((s, v) => s + (v.views || 0), 0);
    const followers_count = await CreatorFollow.countDocuments({ creator: userId });

    res.json({
      success: true,
      author: author || { _id: userId, name: 'Créateur', profileImage: '' },
      videos,
      totalViews,
      totalVideos: videos.length,
      followers_count,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/video/:id/view — Incrémenter les vues depuis le feed public
router.post('/video/:id/view', async (req, res) => {
  try {
    await Video.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Publicités Hub ───────────────────────────────────────────────────────────

// GET /api/studio/ads — Pubs actives + vidéos boostées (public, pas d'auth)
router.get('/ads', async (req, res) => {
  try {
    const now = new Date();
    const ads = await Ad.find({
      active: true,
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    })
      .sort({ createdAt: -1 })
      .populate('author', 'name profilePhoto')
      .lean();

    // Vidéos boostées actives (boost non expiré)
    const boosted = await Video.find({
      'boost.active': true,
      'boost.expires_at': { $gt: now },
      visibility: 'public',
    })
      .sort({ 'boost.multiplier': -1, 'boost.expires_at': 1 })
      .populate('author', 'name profileImage profilePhoto')
      .lean();

    // Convertir les vidéos boostées en format pub pour le bandeau
    const boostedAds = boosted.map(v => ({
      _id: v._id,
      type: 'boosted_video',
      title: v.title,
      description: v.description || '',
      imageUrl: v.thumbnailUrl || '',
      videoUrl: v.videoUrl || '',
      author: v.author,
      boost: v.boost,
      views: v.views,
      likes: v.likes ? v.likes.length : 0,
      duration: v.duration,
    }));

    res.json({ success: true, ads, boostedVideos: boostedAds });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/studio/boosted-videos — Vidéos boostées pour insertion feed (public)
router.get('/boosted-videos', async (req, res) => {
  try {
    const now = new Date();
    const videos = await Video.find({
      'boost.active': true,
      'boost.expires_at': { $gt: now },
      visibility: 'public',
    })
      .sort({ 'boost.multiplier': -1, createdAt: -1 })
      .populate('author', 'name profileImage profilePhoto')
      .lean();
    res.json({ success: true, videos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/studio/ads — Créer une pub (auth requis)
router.post('/ads', verifyToken, async (req, res) => {
  try {
    const { title, description, imageUrl, linkUrl, endDate } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Titre requis' });
    const ad = await Ad.create({
      author: req.userId,
      title,
      description: description || '',
      imageUrl: imageUrl || '',
      linkUrl: linkUrl || '',
      endDate: endDate ? new Date(endDate) : null,
    });
    await ad.populate('author', 'name profilePhoto');
    res.status(201).json({ success: true, ad });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/studio/ads/:id — Supprimer une pub (seulement l'auteur)
router.delete('/ads/:id', verifyToken, async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ success: false, message: 'Pub introuvable' });
    if (ad.author.toString() !== req.userId)
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    await ad.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMENTAIRES VIDÉO (style YouTube)
// ═══════════════════════════════════════════════════════════════════════════

// GET /video/:videoId/comments — liste des commentaires
router.get('/video/:videoId/comments', async (req, res) => {
  try {
    const comments = await VideoComment.find({ videoId: req.params.videoId })
      .sort({ createdAt: -1 })
      .populate('author', 'username profileImage')
      .lean();
    res.json({ success: true, comments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /video/:videoId/comments — ajouter un commentaire (auth)
router.post('/video/:videoId/comments', verifyToken, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Texte requis' });
    }
    const comment = await VideoComment.create({
      videoId: req.params.videoId,
      author: req.userId,
      text: text.trim(),
    });
    // Ajouter la ref dans le tableau comments de la vidéo
    await Video.findByIdAndUpdate(req.params.videoId, {
      $push: { comments: comment._id },
    });
    const populated = await VideoComment.findById(comment._id)
      .populate('author', 'username profileImage')
      .lean();
    res.json({ success: true, comment: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /video/:videoId/comments/:commentId — supprimer (auteur uniquement)
router.delete('/video/:videoId/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const comment = await VideoComment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Commentaire introuvable' });
    if (comment.author.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }
    await VideoComment.findByIdAndDelete(req.params.commentId);
    await Video.findByIdAndUpdate(req.params.videoId, {
      $pull: { comments: comment._id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /video/:videoId/comments/:commentId/like — liker un commentaire
router.post('/video/:videoId/comments/:commentId/like', verifyToken, async (req, res) => {
  try {
    const comment = await VideoComment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Commentaire introuvable' });
    const idx = comment.likes.findIndex(id => id.toString() === req.userId);
    if (idx >= 0) {
      comment.likes.splice(idx, 1);
    } else {
      comment.likes.push(req.userId);
    }
    await comment.save();
    res.json({ success: true, liked: idx < 0, likes_count: comment.likes.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
