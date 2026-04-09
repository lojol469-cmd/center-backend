const mongoose = require('mongoose');

// ── Schéma Portefeuille virtuel ────────────────────────────────────────────
const walletSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  balance: { type: Number, default: 0 },        // Topocoin virtuels
  total_earned:  { type: Number, default: 0 },
  total_spent:   { type: Number, default: 0 },
  total_deposited: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ── Schéma Transaction ────────────────────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'deposit', 'boost', 'earn_views', 'earn_likes', 'earn_tip', 'withdraw', 'bonus',
      'order_pay', 'order_earn', 'delivery_earn', 'subscription_pay', 'refund',
      'video_unlock', 'video_earn', 'purchase', 'earn_replay',
    ],
    required: true,
  },
  amount:      { type: Number, required: true },   // positif = crédit, négatif = débit
  balance_after: { type: Number },
  description: { type: String },
  ref_id:      { type: String },  // publicationId, videoId, etc.
  ref_type:    { type: String },  // 'video' | 'publication' | 'live'
  status:      { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
  createdAt:   { type: Date, default: Date.now },
});

transactionSchema.index({ user: 1, createdAt: -1 });

// ── Schéma Plan de boost ───────────────────────────────────────────────────
const boostPlanSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  topocoin_cost: { type: Number, required: true },
  multiplier:    { type: Number, required: true },   // x1.5, x2, x5, x10
  duration_hours: { type: Number, required: true },
  description:   { type: String },
  color:         { type: String, default: '#00D4FF' },
  icon:          { type: String, default: 'rocket' },
  active:        { type: Boolean, default: true },
});

const Wallet      = mongoose.model('Wallet',      walletSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const BoostPlan   = mongoose.model('BoostPlan',   boostPlanSchema);

module.exports = { Wallet, Transaction, BoostPlan };
