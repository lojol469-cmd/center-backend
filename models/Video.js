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
    flags:       [{ type: String }],
    promo_score: { type: Number, default: 0 },
    promo_tier:  { type: String, default: 'standard' },
    checked_at:  { type: Date },
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
const liveSessionSchema = new mongoose.Schema({
  author:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true },
  description: { type: String },
  status:      { type: String, enum: ['waiting', 'live', 'ended'], default: 'waiting' },
  stream_key:  { type: String },
  viewers:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  peak_viewers: { type: Number, default: 0 },
  duration:    { type: Number, default: 0 },
  started_at:  { type: Date },
  ended_at:    { type: Date },
  createdAt:   { type: Date, default: Date.now },
});

const LiveSession = mongoose.model('LiveSession', liveSessionSchema);

module.exports = { Video, LiveSession };
