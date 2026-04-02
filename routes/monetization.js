const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { Wallet, Transaction, BoostPlan } = require('../models/Wallet');
const { Video } = require('../models/Video');

// Plans de boost par défaut
const DEFAULT_PLANS = [
  { name: 'Starter',    topocoin_cost: 50,    multiplier: 1.5,  duration_hours: 24,   description: 'Boostez x1.5 pendant 24h',  color: '#00D4FF', icon: 'bolt' },
  { name: 'Pro',        topocoin_cost: 150,   multiplier: 2.0,  duration_hours: 48,   description: 'Boostez x2 pendant 48h',     color: '#7B2FBE', icon: 'trending_up' },
  { name: 'Viral',      topocoin_cost: 400,   multiplier: 5.0,  duration_hours: 72,   description: 'Boostez x5 pendant 72h',     color: '#FF6B35', icon: 'whatshot' },
  { name: 'Explosion',  topocoin_cost: 1000,  multiplier: 10.0, duration_hours: 168,  description: 'Boostez x10 pendant 7 jours',color: '#FFD700', icon: 'rocket_launch' },
];

// Pack de Topocoin à acheter
const TOPOCOIN_PACKS = [
  { id: 'pack_100',   amount: 100,   price_xaf: 500,   label: '100 TPC',  color: '#00D4FF' },
  { id: 'pack_500',   amount: 500,   price_xaf: 2000,  label: '500 TPC',  color: '#7B2FBE' },
  { id: 'pack_1000',  amount: 1000,  price_xaf: 3500,  label: '1 000 TPC', color: '#FF6B35' },
  { id: 'pack_5000',  amount: 5000,  price_xaf: 15000, label: '5 000 TPC', color: '#FFD700' },
  { id: 'pack_10000', amount: 10000, price_xaf: 25000, label: '10 000 TPC', color: '#E91E63' },
];

// Helper pour s'assurer qu'un wallet existe
async function ensureWallet(userId) {
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) {
    wallet = await Wallet.create({ user: userId, balance: 100 });
    await Transaction.create({
      user: userId, type: 'bonus', amount: 100, balance_after: 100,
      description: '🎁 Bonus de bienvenue SETRAF — 100 TPC offerts !',
    });
  }
  return wallet;
}

// ══════════════════════════════════════════════════════════════════════════
// WALLET
// ══════════════════════════════════════════════════════════════════════════

// GET /api/wallet/balance
router.get('/balance', verifyToken, async (req, res) => {
  try {
    const wallet = await ensureWallet(req.userId);
    res.json({
      success: true,
      balance:        wallet.balance,
      total_earned:   wallet.total_earned,
      total_spent:    wallet.total_spent,
      total_deposited: wallet.total_deposited,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/wallet/deposit — Dépôt virtuel de Topocoin
router.post('/deposit', verifyToken, async (req, res) => {
  try {
    const { pack_id } = req.body;
    const pack = TOPOCOIN_PACKS.find(p => p.id === pack_id);
    if (!pack) return res.status(400).json({ success: false, message: 'Pack invalide' });

    const wallet = await ensureWallet(req.userId);
    wallet.balance          += pack.amount;
    wallet.total_deposited  += pack.amount;
    wallet.updatedAt         = new Date();
    await wallet.save();

    await Transaction.create({
      user: req.userId,
      type: 'deposit',
      amount: pack.amount,
      balance_after: wallet.balance,
      description: `💳 Recharge ${pack.label} (${pack.price_xaf} XAF)`,
      ref_id: pack_id,
      ref_type: 'pack',
    });

    res.json({
      success: true,
      balance: wallet.balance,
      credited: pack.amount,
      pack,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/wallet/packs — liste des packs disponibles
router.get('/packs', async (req, res) => {
  res.json({ success: true, packs: TOPOCOIN_PACKS });
});

// GET /api/wallet/transactions
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const txs = await Transaction.find({ user: req.userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();
    const total = await Transaction.countDocuments({ user: req.userId });
    res.json({ success: true, transactions: txs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// BOOST DE PUBLICATIONS / VIDÉOS
// ══════════════════════════════════════════════════════════════════════════

// GET /api/wallet/boost-plans
router.get('/boost-plans', async (req, res) => {
  res.json({ success: true, plans: DEFAULT_PLANS });
});

// POST /api/wallet/boost — Booster une vidéo ou publication
router.post('/boost', verifyToken, async (req, res) => {
  try {
    const { content_id, content_type, plan_index } = req.body;
    const plan = DEFAULT_PLANS[plan_index];
    if (!plan) return res.status(400).json({ success: false, message: 'Plan invalide' });
    if (!content_id) return res.status(400).json({ success: false, message: 'content_id requis' });

    const wallet = await ensureWallet(req.userId);
    if (wallet.balance < plan.topocoin_cost) {
      return res.status(402).json({
        success: false,
        message: `Solde insuffisant. Vous avez ${wallet.balance} TPC, le plan coûte ${plan.topocoin_cost} TPC`,
        balance: wallet.balance,
        required: plan.topocoin_cost,
      });
    }

    // Déduire le coût
    wallet.balance      -= plan.topocoin_cost;
    wallet.total_spent  += plan.topocoin_cost;
    wallet.updatedAt     = new Date();
    await wallet.save();

    const expiresAt = new Date(Date.now() + plan.duration_hours * 3600 * 1000);

    // Appliquer le boost selon le type de contenu
    if (content_type === 'video') {
      await Video.findOneAndUpdate(
        { _id: content_id, author: req.userId },
        { boost: { active: true, multiplier: plan.multiplier, topocoin_spent: plan.topocoin_cost, expires_at: expiresAt } }
      );
    }
    // Pour les publications : on enregistre le boost dans la DB de publications
    // (via le modèle Publication existant, si tu veux l'ajouter)

    await Transaction.create({
      user: req.userId,
      type: 'boost',
      amount: -plan.topocoin_cost,
      balance_after: wallet.balance,
      description: `🚀 Boost "${plan.name}" x${plan.multiplier} — ${plan.duration_hours}h`,
      ref_id: content_id,
      ref_type: content_type || 'publication',
    });

    res.json({
      success: true,
      balance: wallet.balance,
      boost: { ...plan, expires_at: expiresAt, content_id },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/wallet/tip — Envoyer un pourboire TPC à un créateur
router.post('/tip', verifyToken, async (req, res) => {
  try {
    const { recipient_id, amount, content_id } = req.body;
    const tipAmount = Number(amount);
    if (!recipient_id || tipAmount < 1) {
      return res.status(400).json({ success: false, message: 'Destinataire et montant requis (min 1 TPC)' });
    }

    const senderWallet = await ensureWallet(req.userId);
    if (senderWallet.balance < tipAmount) {
      return res.status(402).json({ success: false, message: 'Solde insuffisant', balance: senderWallet.balance });
    }

    const recipientWallet = await ensureWallet(recipient_id);

    // Déduire de l'expéditeur
    senderWallet.balance     -= tipAmount;
    senderWallet.total_spent += tipAmount;
    await senderWallet.save();

    // Créditer le destinataire (85% net, 15% plateforme)
    const net = Math.floor(tipAmount * 0.85);
    recipientWallet.balance       += net;
    recipientWallet.total_earned  += net;
    await recipientWallet.save();

    await Transaction.create({
      user: req.userId, type: 'earn_tip', amount: -tipAmount,
      balance_after: senderWallet.balance, description: `💸 Pourboire envoyé (${tipAmount} TPC)`,
      ref_id: content_id, ref_type: 'tip',
    });
    await Transaction.create({
      user: recipient_id, type: 'earn_tip', amount: net,
      balance_after: recipientWallet.balance, description: `🎁 Pourboire reçu (${net} TPC net)`,
      ref_id: content_id, ref_type: 'tip',
    });

    res.json({ success: true, sent: tipAmount, received: net, balance: senderWallet.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/wallet/earn — Récompenser une vue / like (appelé par le backend)
router.post('/earn', verifyToken, async (req, res) => {
  try {
    const { event, content_id, content_type } = req.body;
    const REWARDS = { view: 0.001, like: 0.01, comment: 0.02, share: 0.05 };
    const reward = REWARDS[event] || 0;
    if (!reward) return res.status(400).json({ success: false, message: 'Événement inconnu' });

    const wallet = await ensureWallet(req.userId);
    wallet.balance      += reward;
    wallet.total_earned += reward;
    await wallet.save();

    await Transaction.create({
      user: req.userId, type: 'earn_views', amount: reward,
      balance_after: wallet.balance,
      description: `📊 ${event} sur ${content_type}`,
      ref_id: content_id, ref_type: content_type,
    });

    res.json({ success: true, reward, balance: wallet.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
