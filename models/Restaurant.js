const mongoose = require('mongoose');

// ── Schéma Item de Menu ────────────────────────────────────────────────────
const menuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  price:       { type: Number, required: true },   // FCFA
  imageUrl:    { type: String, default: '' },
  category:    { type: String, default: 'Plat principal' },
  available:   { type: Boolean, default: true },
  livePrice:   { type: Number },  // prix spécial pendant le live (optionnel)
  // ── INVENTAIRE TEMPS RÉEL ──
  stock:       { type: Number, default: -1 },  // -1 = illimité
  soldCount:   { type: Number, default: 0 },   // nombre vendus aujourd'hui
}, { _id: true });

// ── Schéma Restaurant ──────────────────────────────────────────────────────
const restaurantSchema = new mongoose.Schema({
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  category:    {
    type: String,
    enum: ['Fast-food', 'African', 'Seafood', 'Pizza', 'Bakery', 'Drinks', 'Healthy', 'Other'],
    default: 'Other',
  },
  address:     { type: String, required: true },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  phone:       { type: String, default: '' },
  logoUrl:     { type: String, default: '' },
  coverUrl:    { type: String, default: '' },
  menu:        [menuItemSchema],

  // Live streaming
  isLive:           { type: Boolean, default: false },
  liveStartedAt:    { type: Date },
  liveDiscount:     { type: Number, default: 0.20 },      // 20% off pendant live
  streamKey:        { type: String, sparse: true },        // clé RTMP unique
  hlsUrl:           { type: String, default: '' },         // URL HLS pour les viewers
  liveTitle:        { type: String, default: '' },         // titre du live
  liveThumbnailUrl: { type: String, default: '' },         // vignette du live
  viewerCount:      { type: Number, default: 0 },          // viewers en ce moment
  liveReactions: {
    likes:  { type: Number, default: 0 },
    hearts: { type: Number, default: 0 },
    fire:   { type: Number, default: 0 },
  },

  // Statut
  isOpen:      { type: Boolean, default: true },
  isVerified:  { type: Boolean, default: false },  // validé par la plateforme

  // Abonnement restaurant (plan plateforme)
  subscription: {
    plan:      { type: String, enum: ['free', 'basic', 'premium'], default: 'free' },
    expiresAt: { type: Date },
  },
  subscriptionPrice: { type: Number, default: 500 },  // FCFA/mois pour les clients

  // Commission plateforme
  commissionRate: { type: Number, default: 0.20 },  // 20% par défaut, 10% si premium

  // Stats
  rating:      { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  orderCount:  { type: Number, default: 0 },
  totalRevenue:{ type: Number, default: 0 },  // FCFA (TPC) après commission

  // ── CAPACITÉ & GESTION AFFLUENCE ───────────────────────────
  maxOrdersPerHour:    { type: Number, default: 50 },   // capacité max horaire
  avgPrepTime:         { type: Number, default: 30 },   // minutes de préparation
  currentOrderCount:   { type: Number, default: 0 },   // commandes en cours (reset auto)
  lastCapacityReset:   { type: Date, default: Date.now },

  // ── PRIORITÉ & PROMOTION ────────────────────────────────
  isPriority:          { type: Boolean, default: false },
  priorityExpiresAt:   { type: Date },
  priorityScore:       { type: Number, default: 0 },  // score boost classement

  // ── FILE D'ATTENTE ───────────────────────────────────────────
  waitingQueue: [{
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now },
    notified: { type: Boolean, default: false },
  }],

  // ── ANTI-BYPASS (protection écosystème) ─────────────────────
  // Patterns bloqués dans le chat live (numéros, liens ext.)
  blockedPatterns: { type: [String], default: [] },

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

restaurantSchema.index({ 'location.lat': 1, 'location.lng': 1 });
restaurantSchema.index({ isLive: 1 });
restaurantSchema.index({ owner: 1 });

// ── Schéma Abonnement Client → Restaurant ──────────────────────────────────
const restaurantSubscriptionSchema = new mongoose.Schema({
  subscriber:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  restaurant:  { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  amount:      { type: Number, required: true },       // TPC payés
  platformFee: { type: Number, required: true },       // part plateforme
  status:      { type: String, enum: ['active', 'cancelled', 'expired'], default: 'active' },
  expiresAt:   { type: Date, required: true },
  createdAt:   { type: Date, default: Date.now },
});

restaurantSubscriptionSchema.index({ subscriber: 1, restaurant: 1, status: 1 });

// ── Schéma Abonnement Client → Créateur ────────────────────────────────────
const creatorSubscriptionSchema = new mongoose.Schema({
  subscriber:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creator:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan:        { type: String, enum: ['monthly'], default: 'monthly' },
  amount:      { type: Number, required: true },       // TPC/mois
  platformFee: { type: Number, required: true },
  status:      { type: String, enum: ['active', 'cancelled', 'expired'], default: 'active' },
  expiresAt:   { type: Date, required: true },
  createdAt:   { type: Date, default: Date.now },
});

creatorSubscriptionSchema.index({ subscriber: 1, creator: 1, status: 1 });

// ── Schéma Contenu Premium ─────────────────────────────────────────────────
const premiumContentSchema = new mongoose.Schema({
  creator:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  videoUrl:    { type: String, required: true },
  thumbnailUrl:{ type: String, default: '' },
  price:       { type: Number, required: true },  // TPC pour accès unique
  type:        { type: String, enum: ['pay_per_view', 'subscription_only'], default: 'pay_per_view' },
  purchaseCount:{ type: Number, default: 0 },
  revenue:     { type: Number, default: 0 },
  createdAt:   { type: Date, default: Date.now },
});

// ── Schéma Achat Contenu Premium ──────────────────────────────────────────
const premiumPurchaseSchema = new mongoose.Schema({
  buyer:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content:     { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumContent', required: true },
  creator:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:      { type: Number, required: true },
  platformFee: { type: Number, required: true },
  creatorEarning: { type: Number, required: true },
  createdAt:   { type: Date, default: Date.now },
});

premiumPurchaseSchema.index({ buyer: 1, content: 1 });

module.exports = {
  Restaurant: mongoose.model('Restaurant', restaurantSchema),
  RestaurantSubscription: mongoose.model('RestaurantSubscription', restaurantSubscriptionSchema),
  CreatorSubscription: mongoose.model('CreatorSubscription', creatorSubscriptionSchema),
  PremiumContent: mongoose.model('PremiumContent', premiumContentSchema),
  PremiumPurchase: mongoose.model('PremiumPurchase', premiumPurchaseSchema),
};
