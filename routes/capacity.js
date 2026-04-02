// routes/capacity.js — Gestion capacité, file d'attente, alternatives, priorité
const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const Restaurant = require('../models/Restaurant');
const Order      = require('../models/Order');
const Wallet     = require('../models/Wallet');
const LoyaltyProfile = require('../models/LoyaltyProfile');

// ─── Helper : recharge la capacité si l'heure a changé ───────────────────
async function refreshCapacity(restaurant) {
  const now   = new Date();
  const reset = restaurant.lastCapacityReset || new Date(0);
  const diff  = (now - reset) / 1000 / 60;        // minutes depuis dernier reset
  if (diff >= 60) {
    // recompter depuis les commandes réelles (atomic reset)
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const count = await Order.countDocuments({
      restaurant: restaurant._id,
      status: { $nin: ['cancelled'] },
      createdAt: { $gte: since },
    });
    restaurant.currentOrderCount  = count;
    restaurant.lastCapacityReset  = now;
    await restaurant.save();
  }
  return restaurant;
}

// ─── GET /api/capacity/restaurant/:id ────────────────────────────────────
// Statut capacité du restaurant (publique)
router.get('/restaurant/:id', async (req, res) => {
  try {
    let r = await Restaurant.findById(req.params.id).select(
      'name maxOrdersPerHour currentOrderCount avgPrepTime lastCapacityReset waitingQueue isPriority priorityScore'
    );
    if (!r) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    r = await refreshCapacity(r);

    const isFull      = r.currentOrderCount >= r.maxOrdersPerHour;
    const queueLength = r.waitingQueue ? r.waitingQueue.length : 0;
    const estimatedWait = isFull
      ? Math.ceil(queueLength * r.avgPrepTime)  // minutes
      : r.avgPrepTime;

    res.json({
      success: true,
      isFull,
      currentOrders: r.currentOrderCount,
      max: r.maxOrdersPerHour,
      estimatedWait,
      queueLength,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/capacity/restaurant/:id/alternatives ────────────────────────
// Trouve des restaurants alternatifs (même catégorie, disponibles, pas pleins)
router.get('/restaurant/:id/alternatives', async (req, res) => {
  try {
    const target = await Restaurant.findById(req.params.id).select('category location');
    if (!target) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    // Cherche dans la même catégorie, non pleins, ouverts
    const candidates = await Restaurant.find({
      _id:      { $ne: target._id },
      category: target.category,
      isOpen:   true,
    })
    .select('name category logoUrl rating avgPrepTime maxOrdersPerHour currentOrderCount isPriority priorityScore address')
    .limit(20)
    .sort({ isPriority: -1, priorityScore: -1, rating: -1 });

    // Filtre : pas pleins + priorité haut de la liste
    const available = candidates
      .filter(r => r.currentOrderCount < r.maxOrdersPerHour)
      .slice(0, 6);

    res.json({ success: true, alternatives: available });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/capacity/restaurant/:id/join-queue ─────────────────────────
// Rejoindre la file d'attente d'un restaurant complet
router.post('/restaurant/:id/join-queue', auth, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    // Vérifier que le restaurant est bien complet
    await refreshCapacity(restaurant);
    if (restaurant.currentOrderCount < restaurant.maxOrdersPerHour) {
      return res.json({ success: true, message: 'Le restaurant a de la capacité — commandez maintenant!', isFull: false });
    }

    // Vérifie si déjà dans la file
    const already = restaurant.waitingQueue.find(
      e => e.user && e.user.toString() === req.user.id
    );
    if (already) {
      const pos = restaurant.waitingQueue.indexOf(already) + 1;
      return res.json({ success: true, message: 'Vous êtes déjà dans la file', position: pos });
    }

    restaurant.waitingQueue.push({ user: req.user.id, joinedAt: new Date() });
    await restaurant.save();

    const position = restaurant.waitingQueue.length;
    const estimatedWait = position * restaurant.avgPrepTime;

    res.json({
      success:  true,
      message:  `Vous êtes en position ${position} dans la file d'attente`,
      position,
      estimatedWait,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/capacity/restaurant/:id/queue-position ─────────────────────
// Ma position dans la file d'attente
router.get('/restaurant/:id/queue-position', auth, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).select('waitingQueue avgPrepTime');
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    const idx = restaurant.waitingQueue.findIndex(
      e => e.user && e.user.toString() === req.user.id
    );

    if (idx === -1) {
      return res.json({ success: true, inQueue: false, position: 0 });
    }

    const position = idx + 1;
    res.json({
      success:      true,
      inQueue:      true,
      position,
      estimatedWait: position * restaurant.avgPrepTime,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/capacity/restaurant/:id/leave-queue ─────────────────────
// Quitter la file d'attente
router.delete('/restaurant/:id/leave-queue', auth, async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    restaurant.waitingQueue = restaurant.waitingQueue.filter(
      e => !(e.user && e.user.toString() === req.user.id)
    );
    await restaurant.save();
    res.json({ success: true, message: 'Vous avez quitté la file d\'attente' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/capacity/restaurant/:id/priority ───────────────────────────
// Acheter la mise en avant prioritaire (500 TPC / jour)
const PRIORITY_COST_PER_DAY = 500; // TPC

router.post('/restaurant/:id/priority', auth, async (req, res) => {
  try {
    const { days = 1 } = req.body;
    if (days < 1 || days > 30) {
      return res.status(400).json({ success: false, message: 'Durée entre 1 et 30 jours' });
    }

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });
    if (restaurant.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }

    const cost = PRIORITY_COST_PER_DAY * days;

    // Débiter le portefeuille
    const wallet = await Wallet.findOne({ user: req.user.id });
    if (!wallet || wallet.balance < cost) {
      return res.status(400).json({ success: false, message: `Solde insuffisant (${cost} TPC requis)` });
    }

    wallet.balance -= cost;
    wallet.transactions.push({
      type:   'boost',
      amount: -cost,
      description: `Mise en avant prioritaire — ${restaurant.name} (${days}j)`,
      date:   new Date(),
    });
    await wallet.save();

    // Activer la priorité
    const now     = new Date();
    const expires = restaurant.isPriority && restaurant.priorityExpiresAt > now
      ? new Date(restaurant.priorityExpiresAt.getTime() + days * 86400000)
      : new Date(now.getTime() + days * 86400000);

    restaurant.isPriority        = true;
    restaurant.priorityExpiresAt = expires;
    restaurant.priorityScore     = (restaurant.priorityScore || 0) + days * 10;
    await restaurant.save();

    res.json({
      success:    true,
      message:    `Restaurant mis en avant pendant ${days} jours`,
      expiresAt:  expires,
      costPaid:   cost,
      newBalance: wallet.balance,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/capacity/restaurant/:id/menu/:itemId/stock ────────────────
// Mettre à jour le stock d'un article (propriétaire uniquement)
router.patch('/restaurant/:id/menu/:itemId/stock', auth, async (req, res) => {
  try {
    const { stock } = req.body;
    if (stock === undefined || typeof stock !== 'number') {
      return res.status(400).json({ success: false, message: 'stock (number) requis' });
    }

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });
    if (restaurant.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }

    const item = restaurant.menu.id(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Article introuvable' });

    item.stock    = stock;
    item.available = stock !== 0;  // si stock = 0, désactiver automatiquement
    restaurant.updatedAt = new Date();
    await restaurant.save();

    // Diffuser la mise à jour stock via WebSocket
    if (global.broadcastStockUpdate) {
      global.broadcastStockUpdate(restaurant._id.toString(), req.params.itemId, stock);
    }

    res.json({ success: true, item: { _id: item._id, stock: item.stock, available: item.available } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
