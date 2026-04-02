const mongoose = require('mongoose');

// ── Schéma Item commandé ───────────────────────────────────────────────────
const orderItemSchema = new mongoose.Schema({
  menuItemId:  { type: mongoose.Schema.Types.ObjectId, required: true },
  name:        { type: String, required: true },
  quantity:    { type: Number, required: true, min: 1 },
  unitPrice:   { type: Number, required: true },   // prix à l'instant de la commande
  totalPrice:  { type: Number, required: true },
}, { _id: false });

// ── Schéma Commande ────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  customer:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  restaurant:     { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  deliveryPerson: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  items:          [orderItemSchema],

  // Montants (en TPC = FCFA)
  subtotal:       { type: Number, required: true },     // somme items
  deliveryFee:    { type: Number, default: 500 },       // frais livraison
  liveDiscount:   { type: Number, default: 0 },         // montant remisé (si commande live)
  totalAmount:    { type: Number, required: true },     // subtotal + deliveryFee - discount
  platformFee:    { type: Number, required: true },     // commission plateforme (20% du subtotal)
  restaurantCut:  { type: Number, required: true },     // ce que le resto reçoit
  deliveryCut:    { type: Number, required: true },     // ce que le livreur reçoit (200 FCFA fixe)
  platformShare:  { type: Number, required: true },     // platformFee + part livraison restante

  // Paiement
  paymentMethod:  { type: String, enum: ['tpc', 'mobile_money', 'cash'], default: 'tpc' },
  paymentStatus:  { type: String, enum: ['pending', 'paid', 'refunded', 'failed'], default: 'pending' },

  // Statut livraison (machine à états)
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'ready', 'picked_up', 'delivering', 'delivered', 'cancelled'],
    default: 'pending',
  },

  // Contexte live (commande pendant un live)
  isLiveDeal:     { type: Boolean, default: false },
  liveDiscountPct:{ type: Number, default: 0 },  // % de remise appliqué

  // Adresse livraison (client)
  deliveryAddress: {
    address:  { type: String, required: true },
    lat:      { type: Number, required: true },
    lng:      { type: Number, required: true },
  },

  // Position temps réel du livreur (mise à jour via WebSocket)
  deliveryPersonLocation: {
    lat:       { type: Number, default: null },
    lng:       { type: Number, default: null },
    speed:     { type: Number, default: 0 },       // km/h
    heading:   { type: Number, default: 0 },       // degrés
    updatedAt: { type: Date, default: null },
    // Données capteurs (info seulement — pas persistées en prod)
    accelerometer: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      z: { type: Number, default: 0 },
    },
    gyroscope: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      z: { type: Number, default: 0 },
    },
  },

  estimatedDeliveryMinutes: { type: Number, default: 30 },
  notes:      { type: String, default: '' },

  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ restaurant: 1, status: 1 });
orderSchema.index({ deliveryPerson: 1, status: 1 });
orderSchema.index({ status: 1 });

// ── Schéma Livreur ─────────────────────────────────────────────────────────
const deliveryPersonSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  isActive:    { type: Boolean, default: false },   // disponible pour des commandes
  isOnline:    { type: Boolean, default: false },   // connecté et GPS actif
  currentOrder:{ type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  vehicle:     { type: String, enum: ['moto', 'velo', 'voiture', 'autre'], default: 'moto' },
  phone:       { type: String, required: true },
  location: {
    lat:       { type: Number, default: 0 },
    lng:       { type: Number, default: 0 },
    updatedAt: { type: Date, default: null },
  },
  rating:      { type: Number, default: 5 },
  deliveryCount:{ type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },  // TPC gagnés
  createdAt:   { type: Date, default: Date.now },
});

module.exports = {
  Order: mongoose.model('Order', orderSchema),
  DeliveryPerson: mongoose.model('DeliveryPerson', deliveryPersonSchema),
};
