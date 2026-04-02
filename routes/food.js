/**
 * Routes Food Delivery — restaurants, menu, live cuisine
 * Base: /api/food
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { Restaurant, RestaurantSubscription } = require('../models/Restaurant');
const { Wallet, Transaction } = require('../models/Wallet');

const PLATFORM_COMMISSION = 0.20;   // 20% par défaut
const PLATFORM_COMMISSION_PREMIUM = 0.10;  // 10% si plan premium
const SUBSCRIPTION_AMOUNT = 500;    // TPC/mois pour s'abonner à un restaurant

// ═══════════════════════════════════════════════════════════════
// LISTE DES RESTAURANTS
// ═══════════════════════════════════════════════════════════════

// GET /api/food/restaurants — liste avec filtres
router.get('/restaurants', async (req, res) => {
  try {
    const { category, live, search, lat, lng, limit = 20, page = 1 } = req.query;
    const filter = { isOpen: true };

    if (category && category !== 'all') filter.category = category;
    if (live === 'true') filter.isLive = true;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const restaurants = await Restaurant.find(filter)
      .sort({ isPriority: -1, priorityScore: -1, isLive: -1, rating: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('owner', 'name avatar')
      .lean();

    // Expirer la priorité si dépassée + marquer isFull
    const now = new Date();
    restaurants.forEach(r => {
      if (r.isPriority && r.priorityExpiresAt && new Date(r.priorityExpiresAt) < now) {
        r.isPriority = false;
      }
      r.isFull = (r.currentOrderCount || 0) >= (r.maxOrdersPerHour || 50);
    });

    // Calculer distance si coords fournies
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      restaurants.forEach(r => {
        const dLat = r.location.lat - userLat;
        const dLng = r.location.lng - userLng;
        r.distanceKm = Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 111 * 10) / 10;
      });
      restaurants.sort((a, b) => a.distanceKm - b.distanceKm);
    }

    const total = await Restaurant.countDocuments(filter);
    res.json({ success: true, restaurants, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food/restaurants/live — restaurants actuellement en live
router.get('/restaurants/live', async (req, res) => {
  try {
    const restaurants = await Restaurant.find({ isLive: true, isOpen: true })
      .sort({ liveStartedAt: -1 })
      .populate('owner', 'name avatar')
      .lean();
    res.json({ success: true, restaurants });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food/restaurants/:id — détail restaurant + menu
router.get('/restaurants/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id)
      .populate('owner', 'name avatar email')
      .lean();
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });
    res.json({ success: true, restaurant });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GESTION RESTAURANT (propriétaire)
// ═══════════════════════════════════════════════════════════════

// POST /api/food/restaurants — créer un restaurant
router.post('/restaurants', verifyToken, async (req, res) => {
  try {
    const { name, description, category, address, lat, lng, phone, subscriptionPrice } = req.body;
    if (!name || !address || lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: 'name, address, lat, lng requis' });
    }

    const existing = await Restaurant.findOne({ owner: req.user.userId });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Vous avez déjà un restaurant enregistré' });
    }

    const restaurant = await Restaurant.create({
      owner: req.user.userId,
      name,
      description: description || '',
      category: category || 'Other',
      address,
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      phone: phone || '',
      subscriptionPrice: subscriptionPrice || 500,
    });

    res.status(201).json({ success: true, restaurant });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/food/restaurants/:id — mettre à jour infos
router.put('/restaurants/:id', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ _id: req.params.id, owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable ou non autorisé' });

    const allowed = ['name', 'description', 'category', 'address', 'phone', 'isOpen', 'subscriptionPrice', 'liveDiscount'];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) restaurant[field] = req.body[field];
    });
    if (req.body.lat && req.body.lng) {
      restaurant.location = { lat: parseFloat(req.body.lat), lng: parseFloat(req.body.lng) };
    }
    restaurant.updatedAt = new Date();
    await restaurant.save();

    res.json({ success: true, restaurant });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MENU
// ═══════════════════════════════════════════════════════════════

// POST /api/food/restaurants/:id/menu — ajouter un item
router.post('/restaurants/:id/menu', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ _id: req.params.id, owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Non autorisé' });

    const { name, description, price, category, imageUrl, livePrice } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ success: false, message: 'name et price requis' });
    }

    restaurant.menu.push({ name, description, price, category, imageUrl, livePrice });
    await restaurant.save();

    res.status(201).json({ success: true, menu: restaurant.menu });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/food/restaurants/:id/menu/:itemId — supprimer un item
router.delete('/restaurants/:id/menu/:itemId', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ _id: req.params.id, owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Non autorisé' });

    restaurant.menu = restaurant.menu.filter(item => item._id.toString() !== req.params.itemId);
    await restaurant.save();
    res.json({ success: true, menu: restaurant.menu });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// LIVE CUISINE
// ═══════════════════════════════════════════════════════════════

// POST /api/food/restaurants/:id/live/start — démarrer le live
router.post('/restaurants/:id/live/start', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ _id: req.params.id, owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Non autorisé' });

    restaurant.isLive = true;
    restaurant.liveStartedAt = new Date();
    restaurant.liveDiscount = req.body.discount || 0.20;
    await restaurant.save();

    // Notifier les abonnés via WebSocket
    if (global.broadcastToAll) {
      global.broadcastToAll({
        type: 'restaurant_live_started',
        restaurantId: restaurant._id,
        restaurantName: restaurant.name,
        liveDiscount: restaurant.liveDiscount,
        message: `${restaurant.name} est maintenant en live ! ${Math.round(restaurant.liveDiscount * 100)}% de remise sur les commandes.`,
      });
    }

    res.json({ success: true, isLive: true, liveDiscount: restaurant.liveDiscount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/food/restaurants/:id/live/stop — arrêter le live
router.post('/restaurants/:id/live/stop', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ _id: req.params.id, owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Non autorisé' });

    restaurant.isLive = false;
    restaurant.liveStartedAt = null;
    await restaurant.save();

    res.json({ success: true, isLive: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ABONNEMENT CLIENT → RESTAURANT
// ═══════════════════════════════════════════════════════════════

// POST /api/food/restaurants/:id/subscribe — s'abonner
router.post('/restaurants/:id/subscribe', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    // Vérifier si déjà abonné
    const existing = await RestaurantSubscription.findOne({
      subscriber: req.user.userId,
      restaurant: req.params.id,
      status: 'active',
    });
    if (existing) return res.status(400).json({ success: false, message: 'Déjà abonné à ce restaurant' });

    // Débiter le wallet client
    const wallet = await Wallet.findOne({ user: req.user.userId });
    const amount = restaurant.subscriptionPrice || SUBSCRIPTION_AMOUNT;
    const platformFee = Math.round(amount * 0.20);
    const restaurantCut = amount - platformFee;

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ success: false, message: 'Solde TPC insuffisant' });
    }

    wallet.balance -= amount;
    wallet.total_spent += amount;
    await wallet.save();

    // Créditer le restaurant (owner wallet)
    let ownerWallet = await Wallet.findOne({ user: restaurant.owner });
    if (!ownerWallet) ownerWallet = await Wallet.create({ user: restaurant.owner });
    ownerWallet.balance += restaurantCut;
    ownerWallet.total_earned += restaurantCut;
    await ownerWallet.save();

    // Transactions
    await Transaction.create({
      user: req.user.userId,
      type: 'subscription_pay',
      amount: -amount,
      balance_after: wallet.balance,
      description: `Abonnement ${restaurant.name}`,
      ref_id: restaurant._id.toString(),
      ref_type: 'restaurant',
    });

    // Créer la souscription
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    const subscription = await RestaurantSubscription.create({
      subscriber: req.user.userId,
      restaurant: req.params.id,
      amount, platformFee,
      expiresAt,
    });

    res.status(201).json({ success: true, subscription });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food/restaurants/:id/subscription-status — vérifie si abonné
router.get('/restaurants/:id/subscription-status', verifyToken, async (req, res) => {
  try {
    const sub = await RestaurantSubscription.findOne({
      subscriber: req.user.userId,
      restaurant: req.params.id,
      status: 'active',
      expiresAt: { $gt: new Date() },
    });
    res.json({ success: true, isSubscribed: !!sub, subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food/my-restaurant — restaurant du propriétaire connecté
router.get('/my-restaurant', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Aucun restaurant trouvé' });
    res.json({ success: true, restaurant });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Expirer les priorités en arrière-plan (appelé depuis server.js) ─────
// PATCH /api/food/system/expire-priorities (interne, pas exposé publiquement)
async function expirePriorities() {
  try {
    await Restaurant.updateMany(
      { isPriority: true, priorityExpiresAt: { $lt: new Date() } },
      { $set: { isPriority: false, priorityScore: 0 } }
    );
  } catch (_) {}
}
module.exports = router;
module.exports.expirePriorities = expirePriorities;
