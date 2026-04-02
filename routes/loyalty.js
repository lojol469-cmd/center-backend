// routes/loyalty.js — Système de fidélité (points, niveaux, rachat)
const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const LoyaltyProfile = require('../models/LoyaltyProfile');
const Wallet         = require('../models/Wallet');

// Seuil de rachat minimal
const MIN_REDEEM_POINTS = 100;  // 100 pts = 100 TPC

// ─── GET /api/loyalty/profile ─────────────────────────────────────────────
// Mon profil de fidélité
router.get('/profile', auth, async (req, res) => {
  try {
    let profile = await LoyaltyProfile.findOne({ user: req.user.id });
    if (!profile) {
      // Créer un profil vide à la première consultation
      profile = await LoyaltyProfile.create({ user: req.user.id });
    }

    const nextLevel = {
      bronze:   { name: 'Silver',   needed: 100 },
      silver:   { name: 'Gold',     needed: 500 },
      gold:     { name: 'Platinum', needed: 1000 },
      platinum: { name: null,       needed: null },
    };

    const next = nextLevel[profile.level];

    res.json({
      success: true,
      profile: {
        points:       profile.points,
        totalEarned:  profile.totalEarned,
        ordersCount:  profile.ordersCount,
        level:        profile.level,
        nextLevel:    next.name,
        pointsToNext: next.needed !== null ? Math.max(0, next.needed - profile.totalEarned) : 0,
        history:      profile.history.slice(-30).reverse(),  // 30 dernières opérations
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/loyalty/redeem ─────────────────────────────────────────────
// Racheter des points contre des TPC (100 pts = 100 TPC)
router.post('/redeem', auth, async (req, res) => {
  try {
    const { points = MIN_REDEEM_POINTS } = req.body;

    if (!Number.isInteger(points) || points < MIN_REDEEM_POINTS) {
      return res.status(400).json({
        success: false,
        message: `Minimum ${MIN_REDEEM_POINTS} points pour un rachat`,
      });
    }
    if (points % 100 !== 0) {
      return res.status(400).json({ success: false, message: 'Rachat par multiples de 100 points' });
    }

    const profile = await LoyaltyProfile.findOne({ user: req.user.id });
    if (!profile || profile.points < points) {
      return res.status(400).json({ success: false, message: 'Solde de points insuffisant' });
    }

    const tpcEarned = points;  // 1 point = 1 TPC

    // Débiter les points
    profile.points -= points;
    profile.history.push({
      points:      -points,
      type:        'redeem',
      description: `Rachat ${points} pts → ${tpcEarned} TPC`,
      date:        new Date(),
    });
    await profile.save();

    // Créditer le portefeuille TPC
    let wallet = await Wallet.findOne({ user: req.user.id });
    if (!wallet) wallet = await Wallet.create({ user: req.user.id, balance: 0 });

    wallet.balance += tpcEarned;
    wallet.transactions.push({
      type:        'bonus',
      amount:      tpcEarned,
      description: `Fidélité — rachat ${points} points`,
      date:        new Date(),
    });
    await wallet.save();

    res.json({
      success:       true,
      message:       `${tpcEarned} TPC crédités sur votre portefeuille!`,
      pointsUsed:    points,
      tpcEarned,
      remainingPoints: profile.points,
      newBalance:    wallet.balance,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/loyalty/leaderboard ─────────────────────────────────────────
// Top 20 utilisateurs les plus fidèles
router.get('/leaderboard', auth, async (req, res) => {
  try {
    const leaders = await LoyaltyProfile
      .find({})
      .sort({ totalEarned: -1 })
      .limit(20)
      .populate('user', 'name avatarUrl');

    const board = leaders.map((p, i) => ({
      rank:        i + 1,
      userName:    p.user ? p.user.name : 'Inconnu',
      avatarUrl:   p.user ? p.user.avatarUrl : null,
      totalEarned: p.totalEarned,
      level:       p.level,
      ordersCount: p.ordersCount,
    }));

    res.json({ success: true, leaderboard: board });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
