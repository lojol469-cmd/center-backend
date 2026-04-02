const mongoose = require('mongoose');
const ObjectId = mongoose.Schema.Types.ObjectId;

// ─── Niveaux de fidélité ───────────────────────────────────────────────────
// bronze  : 0 – 99 pts
// silver  : 100 – 499 pts
// gold    : 500 – 999 pts
// platinum: 1000+ pts
// Récompense : 100 pts = 100 TPC cashback (min redemption)
// ──────────────────────────────────────────────────────────────────────────

const loyaltyHistorySchema = new mongoose.Schema({
  points:      { type: Number, required: true },    // positif = gain, négatif = rachat
  type:        { type: String, enum: ['earn', 'redeem', 'bonus', 'refund'], default: 'earn' },
  orderId:     { type: ObjectId, ref: 'Order' },
  description: { type: String, default: '' },
  date:        { type: Date, default: Date.now },
}, { _id: false });

const loyaltyProfileSchema = new mongoose.Schema({
  user:        { type: ObjectId, ref: 'User', unique: true, required: true },
  points:      { type: Number, default: 0 },       // solde actuel
  totalEarned: { type: Number, default: 0 },       // total cumulé (jamais décrémenté)
  ordersCount: { type: Number, default: 0 },       // nbre de commandes passées
  level:       {
    type: String,
    enum: ['bronze', 'silver', 'gold', 'platinum'],
    default: 'bronze',
  },
  history:     { type: [loyaltyHistorySchema], default: [] },
  updatedAt:   { type: Date, default: Date.now },
});

// ─── Met à jour le niveau automatiquement avant sauvegarde ───────────────
loyaltyProfileSchema.pre('save', function (next) {
  const total = this.totalEarned;
  if      (total >= 1000) this.level = 'platinum';
  else if (total >= 500)  this.level = 'gold';
  else if (total >= 100)  this.level = 'silver';
  else                    this.level = 'bronze';
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('LoyaltyProfile', loyaltyProfileSchema);
