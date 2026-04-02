const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');

// ── Auth middleware ────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ message: 'Token manquant' });
  const token = header.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token manquant' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ message: 'Token invalide' });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function buildHlsUrl(streamKey) {
  const base = process.env.BASE_URL || 'http://localhost:5000';
  return `${base}/hls/${streamKey}/index.m3u8`;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /generate-key
// Génère une clé RTMP unique pour un restaurant (owner uniquement)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/generate-key', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });
    if (String(restaurant.owner) !== String(req.user.userId)) {
      return res.status(403).json({ message: 'Accès réservé au propriétaire' });
    }

    const streamKey = `${restaurant._id}-${uuidv4()}`.replace(/-/g, '');
    restaurant.streamKey = streamKey;
    restaurant.hlsUrl    = buildHlsUrl(streamKey);
    await restaurant.save();

    const rtmpBase = process.env.RTMP_URL || `rtmp://${(process.env.BASE_URL || 'localhost').replace(/https?:\/\//, '')}:1935/live`;

    res.json({
      streamKey,
      rtmpUrl:  rtmpBase,
      rtmpFull: `${rtmpBase}/${streamKey}`,
      hlsUrl:   restaurant.hlsUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /go-live — démarre le live (owner uniquement)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/go-live', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });
    if (String(restaurant.owner) !== String(req.user.userId)) {
      return res.status(403).json({ message: 'Accès réservé au propriétaire' });
    }
    if (!restaurant.streamKey) {
      return res.status(400).json({ message: 'Générez d\'abord une clé de stream' });
    }

    const { title, thumbnailUrl } = req.body;
    restaurant.isLive          = true;
    restaurant.liveStartedAt   = new Date();
    restaurant.liveTitle       = title || `${restaurant.name} — Live cuisine`;
    restaurant.liveThumbnailUrl= thumbnailUrl || restaurant.coverUrl || '';
    restaurant.viewerCount     = 0;
    restaurant.liveReactions   = { likes: 0, hearts: 0, fire: 0 };
    await restaurant.save();

    // Notifier tous les abonnés via WebSocket
    if (global.broadcastToAll) {
      global.broadcastToAll({
        type:         'restaurant_live_started',
        restaurantId: restaurant._id,
        name:         restaurant.name,
        title:        restaurant.liveTitle,
        thumbnailUrl: restaurant.liveThumbnailUrl,
        hlsUrl:       restaurant.hlsUrl,
      });
    }

    res.json({ success: true, hlsUrl: restaurant.hlsUrl, liveTitle: restaurant.liveTitle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /stop-live — arrête le live (owner uniquement)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/stop-live', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });
    if (String(restaurant.owner) !== String(req.user.userId)) {
      return res.status(403).json({ message: 'Accès réservé au propriétaire' });
    }

    restaurant.isLive      = false;
    restaurant.viewerCount = 0;
    await restaurant.save();

    if (global.broadcastToAll) {
      global.broadcastToAll({
        type:         'restaurant_live_ended',
        restaurantId: String(restaurant._id),
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /live-info — infos live pour les viewers
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:restaurantId/live-info', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId)
      .select('name isLive hlsUrl liveTitle liveThumbnailUrl viewerCount liveReactions liveStartedAt liveDiscount menu');
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });

    res.json({
      restaurantId:   restaurant._id,
      name:           restaurant.name,
      isLive:         restaurant.isLive,
      hlsUrl:         restaurant.isLive ? restaurant.hlsUrl : null,
      liveTitle:      restaurant.liveTitle,
      thumbnailUrl:   restaurant.liveThumbnailUrl,
      viewerCount:    restaurant.viewerCount,
      reactions:      restaurant.liveReactions,
      liveStartedAt:  restaurant.liveStartedAt,
      liveDiscount:   restaurant.liveDiscount,   // ex: 0.20 → 20% off
      menu:           restaurant.menu,            // pour commander sans quitter le live
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /viewer-join — incrémente le compteur de viewers
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/viewer-join', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.restaurantId,
      { $inc: { viewerCount: 1 } },
      { new: true, select: 'viewerCount name isLive' }
    );
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });

    // Broadcast le nouveau compteur à tous les viewers du live
    if (global.broadcastLiveViewerCount) {
      global.broadcastLiveViewerCount(String(restaurant._id), restaurant.viewerCount);
    }

    res.json({ viewerCount: restaurant.viewerCount });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /viewer-leave — décrémente le compteur de viewers
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/viewer-leave', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.restaurantId,
      { $inc: { viewerCount: -1 } },
      { new: true, select: 'viewerCount' }
    );
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });

    const count = Math.max(0, restaurant.viewerCount);
    if (restaurant.viewerCount < 0) {
      await Restaurant.findByIdAndUpdate(req.params.restaurantId, { viewerCount: 0 });
    }

    if (global.broadcastLiveViewerCount) {
      global.broadcastLiveViewerCount(String(restaurant._id), count);
    }

    res.json({ viewerCount: count });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /react — réaction au live (like / heart / fire)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:restaurantId/react', verifyToken, async (req, res) => {
  const { reaction } = req.body; // 'likes' | 'hearts' | 'fire'
  const allowed = ['likes', 'hearts', 'fire'];
  if (!allowed.includes(reaction)) {
    return res.status(400).json({ message: 'Réaction invalide' });
  }

  try {
    const update    = {};
    update[`liveReactions.${reaction}`] = 1;
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.restaurantId,
      { $inc: update },
      { new: true, select: 'liveReactions' }
    );
    if (!restaurant) return res.status(404).json({ message: 'Restaurant non trouvé' });

    // Broadcast réaction à tous les viewers
    if (global.broadcastLiveReaction) {
      global.broadcastLiveReaction(String(restaurant._id), reaction, restaurant.liveReactions);
    }

    res.json({ reactions: restaurant.liveReactions });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /active-lives — tous les lives en cours
// ═══════════════════════════════════════════════════════════════════════════
router.get('/active', async (req, res) => {
  try {
    const lives = await Restaurant.find({ isLive: true })
      .select('name logoUrl coverUrl liveTitle liveThumbnailUrl viewerCount liveStartedAt liveReactions address')
      .sort({ viewerCount: -1 });

    res.json({ lives });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

module.exports = router;
