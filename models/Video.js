const mongoose = require('mongoose');

// ── Schéma Vidéo de création ──────────────────────────────────────────────
const videoSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  tags: [{ type: String }],
  
  // Médias Cloudinary
  videoUrl:      { type: String },
  videoPublicId: { type: String },
  thumbnailUrl:  { type: String },
  duration:      { type: Number, default: 0 }, // secondes
  fileSize:      { type: Number, default: 0 }, // bytes
  
  // Visibilité
  visibility: {
    type: String,
    enum: ['public', 'private', 'followers_only', 'draft'],
    default: 'draft',
  },
  
  // Modération
  moderation: {
    approved:    { type: Boolean, default: false },
    score:       { type: Number, default: 0 },
    tier:        { type: String, default: 'standard' },
    flags:       [{ type: String }],
    promo_score: { type: Number, default: 0 },
    promo_tier:  { type: String, default: 'standard' },
    checked_at:  { type: Date },
    reason:      { type: String },
  },
  
  // Analytics
  views:       { type: Number, default: 0 },
  likes:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  shares:      { type: Number, default: 0 },
  comments:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  
  // Monétisation
  boost: {
    active:          { type: Boolean, default: false },
    multiplier:      { type: Number, default: 1.0 },
    topocoin_spent:  { type: Number, default: 0 },
    expires_at:      { type: Date },
  },
  // Monétisation par vidéo (paywall)
  monetization: {
    enabled:       { type: Boolean, default: false },
    price_tpc:     { type: Number, default: 0, min: 0 },
    preview_seconds:{ type: Number, default: 30 },
    currency:      { type: String, default: 'TPC' },
  },
  // Liste des users ayant débloqué la vidéo (pour y accéder sans payer à nouveau)
  unlocked_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Paywall locking behaviour: lock after N seconds of viewing if enabled
  lock_enabled: { type: Boolean, default: false },
  lock_after_seconds: { type: Number, default: 30 },

  // Trailer / teaser generated automatically
  trailerUrl: { type: String },
  trailerGeneratedAt: { type: Date },
  trailerStatus: { type: String, enum: ['none', 'pending', 'ready', 'failed'], default: 'none' },

  // Per-user view progress (used to enforce preview limits)
  view_progress: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, seconds: { type: Number, default: 0 }, locked: { type: Boolean, default: false }, last_seen: { type: Date, default: Date.now } }],
  
  // Algorithme de recommandation
  algorithm_score: { type: Number, default: 0 },
  trending_rank:   { type: Number, default: 0 },
  
  // État
  is_live:    { type: Boolean, default: false },
  live_started_at: { type: Date },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

videoSchema.index({ author: 1, createdAt: -1 });
videoSchema.index({ algorithm_score: -1 });
videoSchema.index({ visibility: 1, 'moderation.approved': 1 });

const Video = mongoose.model('Video', videoSchema);

// ── Schéma Session Live ────────────────────────────────────────────────────
const liveMenuItemSchema = new mongoose.Schema({
  emoji:      { type: String, default: '🍽️' },
  name:       { type: String, required: true },
  price_tpc:  { type: Number, required: true, min: 0 },
  available:  { type: Boolean, default: true },
  image_url:  { type: String, default: '' },
});

const liveSessionSchema = new mongoose.Schema({
  author:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:        { type: String, required: true },
  description:  { type: String },
  status:       { type: String, enum: ['waiting', 'live', 'ended'], default: 'waiting' },
  stream_key:   { type: String },
  viewers:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  peak_viewers: { type: Number, default: 0 },
  duration:     { type: Number, default: 0 },
  started_at:   { type: Date },
  ended_at:     { type: Date },
  createdAt:    { type: Date, default: Date.now },
  // Menu dynamique du créateur
  menu_items:   [liveMenuItemSchema],
  // Abonnés acquis pendant ce live
  subscribers:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // ── Enregistrement automatique ──────────────────────────────────────────
  recording: {
    path:          { type: String },           // chemin fichier dans /recordings
    filename:      { type: String },           // nom du fichier FLV
    size_bytes:    { type: Number, default: 0 },
    duration_sec:  { type: Number, default: 0 },
    ready:         { type: Boolean, default: false },
    recorded_at:   { type: Date },
  },

  // ── Monétisation / Replay payant ────────────────────────────────────────
  monetization: {
    enabled:           { type: Boolean, default: false },
    price_fr:          { type: Number, default: 0, min: 0, max: 10000 },
    preview_seconds:   { type: Number, default: 30 },    // 30s de preview gratuit
    vlm_validated:     { type: Boolean, default: false },
    vlm_score:         { type: Number, default: 0 },
    vlm_reason:        { type: String, default: '' },
  },
  // Liste des users ayant débloqué le replay payant
  unlocked_by:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

const LiveSession = mongoose.model('LiveSession', liveSessionSchema);

// ── Schéma Commande Live (food order pendant un live) ─────────────────────
const liveOrderItemSchema = new mongoose.Schema({
  emoji:     { type: String, default: '🍽️' },
  name:      { type: String, required: true },
  quantity:  { type: Number, default: 1, min: 1 },
  price_tpc: { type: Number, required: true },
}, { _id: false });

const liveOrderSchema = new mongoose.Schema({
  liveId:         { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession', required: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items:          [liveOrderItemSchema],
  total_tpc:      { type: Number, required: true },
  status:         { type: String, enum: ['pending', 'preparing', 'done', 'cancelled'], default: 'pending' },
  queue_position: { type: Number, default: 0 },
  vlm_validated:  { type: Boolean, default: false },
  vlm_note:       { type: String, default: '' },
  user_comment:   { type: String, default: '' },
  created_at:     { type: Date, default: Date.now },
});

liveOrderSchema.index({ liveId: 1, created_at: 1 });
liveOrderSchema.index({ userId: 1, liveId: 1 });

const LiveOrder = mongoose.model('LiveOrder', liveOrderSchema);

// ── Position livreur en temps réel ─────────────────────────────────────────
const deliveryLocationSchema = new mongoose.Schema({
  orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'LiveOrder', required: true },
  deliverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  latitude:   { type: Number, required: true },
  longitude:  { type: Number, required: true },
  accuracy:   { type: Number, default: 0 },
  speed:      { type: Number, default: 0 },
  heading:    { type: Number, default: 0 },
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: false });
deliveryLocationSchema.index({ orderId: 1 }, { unique: true });

const DeliveryLocation = mongoose.model('DeliveryLocation', deliveryLocationSchema);

// ── Abonnements creator (Follow) ────────────────────────────────────────────
const creatorFollowSchema = new mongoose.Schema({
  follower:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creator:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  from_live:  { type: mongoose.Schema.Types.ObjectId, ref: 'LiveSession' },
  createdAt:  { type: Date, default: Date.now },
});
creatorFollowSchema.index({ follower: 1, creator: 1 }, { unique: true });

const CreatorFollow = mongoose.model('CreatorFollow', creatorFollowSchema);

// ── Commentaires vidéo (style YouTube) ──────────────────────────────────────
const videoCommentSchema = new mongoose.Schema({
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true },
  author:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:    { type: String, required: true, maxlength: 1000 },
  likes:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
});
videoCommentSchema.index({ videoId: 1, createdAt: -1 });

const VideoComment = mongoose.model('VideoComment', videoCommentSchema);

module.exports = { Video, LiveSession, LiveOrder, DeliveryLocation, CreatorFollow, VideoComment };
