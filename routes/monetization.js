const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { Wallet, Transaction, BoostPlan } = require('../models/Wallet');
const { Video } = require('../models/Video');
const { cloudinary } = require('../cloudynary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const nodemailer = require('nodemailer');
const axios = require('axios');
const FormData = require('form-data');

// ── Cloudinary storage pour les preuves de paiement Airtel Money ──────────
const proofStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'center-app/payment-proofs',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ quality: 'auto:good' }],
    public_id: (_req, _file) =>
      `proof-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});
const uploadProof = multer({
  storage: proofStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Seules les images sont acceptées (jpg/png/webp)'));
  },
});

// ── Memory storage multer — buffer disponible avant upload Cloudinary ───
const proofMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Seules les images sont acceptées (jpg/png/webp)'));
  },
});

// ── VLM API — validation visuelle screenshots paiement ────────────────────
const VLM_API_URL = process.env.VLM_API_URL || 'http://vlm-api:8005';

async function uploadBufferToCloudinary(buffer, mimetype) {
  const dataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: 'center-app/payment-proofs',
    resource_type: 'image',
    public_id: `proof-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  });
  return result.secure_url;
}

async function callVlmValidation(buffer, mimetype, pack) {
  try {
    const form = new FormData();
    form.append('image', buffer, { filename: 'screenshot.jpg', contentType: mimetype });
    form.append('expected_amount', String(pack.price_xaf));
    form.append('payment_number', '076356144'); // numéro Airtel Money CENTER
    form.append('pack_label', pack.label);
    const { data } = await axios.post(`${VLM_API_URL}/validate-payment`, form, {
      headers: form.getHeaders(),
      timeout: 30_000, // timeout 30 s
    });
    return data; // { valid, amount_detected, confidence, reason, ... }
  } catch (err) {
    console.warn('[VLM] Service injoignable:', err.message);
    return null; // null = dégradation gracieuse
  }
}

// ── Mailer Gmail ─────────────────────────────────────────────────────────
function createMailer() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

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

// POST /api/wallet/deposit-with-proof — Dépôt Airtel Money avec validation VLM
// Flux :
//   1. Réception screenshot (mémoire)
//   2. Appel VLM /validate-payment → analyse automatique
//   3a. VLM valide (confidence ≥ 0.65) → crédit immédiat + email admin « Approuvé »
//   3b. VLM invalide                   → en attente + email admin « Revue manuelle »
//   3c. VLM injoignable               → crédit immédiat (dégradation gracieuse) + email admin
router.post(
  '/deposit-with-proof',
  verifyToken,
  proofMemory.single('screenshot'), // buffer en mémoire, pas encore sur Cloudinary
  async (req, res) => {
    try {
      const { pack_id } = req.body;
      const pack = TOPOCOIN_PACKS.find(p => p.id === pack_id);
      if (!pack)
        return res.status(400).json({ success: false, message: 'Pack invalide' });
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "Capture d'écran de transaction requise" });

      const { buffer, mimetype } = req.file;

      // ── 1. Validation visuelle par SmolVLM ───────────────────────────
      const vlmResult = await callVlmValidation(buffer, mimetype, pack);
      const MIN_CONFIDENCE = 0.65;

      let vlmApproved = false;
      let vlmReason   = 'Service VLM indisponible — crédit de secours accordé';
      let vlmConfidence = null;

      if (vlmResult) {
        vlmApproved   = vlmResult.valid === true && (vlmResult.confidence ?? 0) >= MIN_CONFIDENCE;
        vlmReason     = vlmResult.reason || '';
        vlmConfidence = vlmResult.confidence ?? null;
        console.log(`[VLM] valid=${vlmResult.valid} confidence=${vlmResult.confidence} reason=${vlmReason}`);
      } else {
        // VLM injoignable → dégradation gracieuse : crédit accordé
        vlmApproved = true;
      }

      // ── 2. Upload Cloudinary (toujours, pour archivage) ───────────────
      let screenshotUrl = null;
      try {
        screenshotUrl = await uploadBufferToCloudinary(buffer, mimetype);
      } catch (uploadErr) {
        console.error('[Cloudinary] Échec upload preuve:', uploadErr.message);
      }

      // ── 3a. VLM approuve → créditer immédiatement ────────────────────
      if (vlmApproved) {
        const wallet = await ensureWallet(req.userId);
        wallet.balance         += pack.amount;
        wallet.total_deposited += pack.amount;
        wallet.updatedAt        = new Date();
        await wallet.save();

        await Transaction.create({
          user:         req.userId,
          type:         'deposit',
          amount:       pack.amount,
          balance_after: wallet.balance,
          description:  `💳 Recharge ${pack.label} (${pack.price_xaf} XAF) via Airtel Money`,
          ref_id:       pack_id,
          ref_type:     'pack',
          meta: {
            screenshot_url: screenshotUrl,
            vlm_valid:       vlmResult ? true : null,
            vlm_confidence:  vlmConfidence,
            vlm_reason:      vlmReason,
          },
        });

        // Email admin — confirmé
        const vlmTag = vlmResult
          ? `<span style="color:#2e7d32">✅ Approuvé par SmolVLM (confiance : ${Math.round((vlmConfidence || 0) * 100)}%)</span>`
          : `<span style="color:#e65100">⚠️ VLM indisponible — crédit de secours accordé</span>`;

        try {
          await createMailer().sendMail({
            from: `"SETRAF Center" <${process.env.EMAIL_USER}>`,
            to:   'nyundumathryme@gmail.com',
            subject: `✅ Dépôt VALIDÉ — ${pack.label} (${pack.price_xaf} XAF)`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;border:1px solid #c8e6c9;border-radius:12px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#2e7d32,#43a047);padding:20px;">
                  <h2 style="color:#fff;margin:0;">✅ Paiement validé automatiquement</h2>
                </div>
                <div style="padding:20px;">
                  <p>${vlmTag}</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    <tr><td style="color:#666;padding:5px 0;">Pack</td><td style="font-weight:bold;">${pack.label}</td></tr>
                    <tr><td style="color:#666;padding:5px 0;">Montant XAF</td><td><strong>${pack.price_xaf} XAF</strong></td></tr>
                    <tr><td style="color:#666;padding:5px 0;">TPC crédités</td><td style="color:#2e7d32;font-weight:bold;">${pack.amount} TPC</td></tr>
                    <tr><td style="color:#666;padding:5px 0;">Utilisateur</td><td>${req.userId}</td></tr>
                    <tr><td style="color:#666;padding:5px 0;">Analyse VLM</td><td><em>${vlmReason}</em></td></tr>
                    <tr><td style="color:#666;padding:5px 0;">Date</td><td>${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Brazzaville' })}</td></tr>
                  </table>
                  ${screenshotUrl ? `<p style="margin-top:12px;font-size:13px;color:#666;">Capture :</p><img src="${screenshotUrl}" style="max-width:100%;border-radius:8px;"/>` : ''}
                </div>
              </div>`,
          });
        } catch (e) {
          console.warn('[Mailer] Échec email admin:', e.message);
        }

        return res.json({
          success:         true,
          balance:         wallet.balance,
          credited:        pack.amount,
          pack,
          screenshot_url:  screenshotUrl,
          vlm_validated:   !!vlmResult,
          vlm_confidence:  vlmConfidence,
          message:         `✅ ${pack.label} crédités ! Paiement ${vlmResult ? 'validé par VLM' : 'accepté (VLM indisponible)'}`,
        });
      }

      // ── 3b. VLM rejette → transaction en attente ──────────────────────
      await Transaction.create({
        user:         req.userId,
        type:         'deposit_pending',
        amount:       pack.amount,
        balance_after: (await ensureWallet(req.userId)).balance,
        description:  `⏳ En attente — ${pack.label} (${pack.price_xaf} XAF) — Rejeté VLM`,
        ref_id:       pack_id,
        ref_type:     'pack',
        meta: {
          screenshot_url: screenshotUrl,
          vlm_valid:       false,
          vlm_confidence:  vlmConfidence,
          vlm_reason:      vlmReason,
          amount_detected: vlmResult?.amount_detected,
          recipient_number: vlmResult?.recipient_number,
        },
      });

      // Email admin — revue manuelle requise
      try {
        await createMailer().sendMail({
          from: `"SETRAF Center" <${process.env.EMAIL_USER}>`,
          to:   'nyundumathryme@gmail.com',
          subject: `⚠️ Dépôt EN ATTENTE — ${pack.label} (${pack.price_xaf} XAF) — Revue manuelle`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;border:1px solid #ffe0b2;border-radius:12px;overflow:hidden;">
              <div style="background:linear-gradient(135deg,#e65100,#ff9800);padding:20px;">
                <h2 style="color:#fff;margin:0;">⚠️ Paiement rejeté par VLM — Revue manuelle</h2>
              </div>
              <div style="padding:20px;">
                <p style="color:#c62828;">SmolVLM n'a pas pu confirmer ce paiement. Les TPC <strong>n'ont PAS été crédités</strong>.</p>
                <table style="width:100%;border-collapse:collapse;font-size:14px;">
                  <tr><td style="color:#666;padding:5px 0;">Pack</td><td>${pack.label}</td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Montant XAF</td><td>${pack.price_xaf} XAF</td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Utilisateur</td><td>${req.userId}</td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Raison VLM</td><td style="color:#c62828;"><em>${vlmReason}</em></td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Confiance VLM</td><td>${vlmConfidence !== null ? Math.round(vlmConfidence * 100) + '%' : 'N/A'}</td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Montant détecté</td><td>${vlmResult?.amount_detected || '?'}</td></tr>
                  <tr><td style="color:#666;padding:5px 0;">Date</td><td>${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Brazzaville' })}</td></tr>
                </table>
                ${screenshotUrl ? `<p style="margin-top:12px;font-size:13px;">Capture :</p><img src="${screenshotUrl}" style="max-width:100%;border-radius:8px;"/>` : ''}
                <p style="margin-top:16px;font-size:12px;color:#aaa;">Vérifiez la capture et créditez manuellement si le paiement est légitime.</p>
              </div>
            </div>`,
        });
      } catch (e) {
        console.warn('[Mailer] Échec email admin:', e.message);
      }

      // Retour 402 Payment Required
      return res.status(402).json({
        success:         false,
        pending:         true,
        screenshot_url:  screenshotUrl,
        vlm_reason:      vlmReason,
        vlm_confidence:  vlmConfidence,
        message:         `⏳ Paiement en attente de validation manuelle. Raison : ${vlmReason}`,
      });

    } catch (err) {
      console.error('[deposit-with-proof]', err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

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
