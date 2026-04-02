/**
 * Routes Orders — commandes, livraison, tracking
 * Base: /api/orders
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { Order, DeliveryPerson } = require('../models/Order');
const { Restaurant } = require('../models/Restaurant');
const { Wallet, Transaction } = require('../models/Wallet');

const DELIVERY_PAY = 200;    // TPC fixe pour le livreur
const PLATFORM_CUT_RATE = 0.20;  // 20% commission plateforme
const LoyaltyProfile = require('../models/LoyaltyProfile');

// ─── Helper : reset capacité horaire si nécessaire ────────────────────────
async function refreshCapacity(restaurant) {
  const now  = new Date();
  const diff = (now - (restaurant.lastCapacityReset || new Date(0))) / 60000;
  if (diff >= 60) {
    const since = new Date(now.getTime() - 3600000);
    const count = await Order.countDocuments({
      restaurant: restaurant._id,
      status:     { $nin: ['cancelled'] },
      createdAt:  { $gte: since },
    });
    restaurant.currentOrderCount = count;
    restaurant.lastCapacityReset = now;
    await restaurant.save();
  }
}

// ═══════════════════════════════════════════════════════════════
// PASSER UNE COMMANDE
// ═══════════════════════════════════════════════════════════════

// POST /api/orders — passer une commande
router.post('/', verifyToken, async (req, res) => {
  try {
    const { restaurantId, items, deliveryAddress, deliveryLat, deliveryLng, notes, paymentMethod } = req.body;

    if (!restaurantId || !items?.length || !deliveryAddress || deliveryLat === undefined || deliveryLng === undefined) {
      return res.status(400).json({ success: false, message: 'Paramètres manquants' });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });
    if (!restaurant.isOpen) return res.status(400).json({ success: false, message: 'Restaurant fermé' });

    // ── Check capacité horaire ─────────────────────────────────────────────
    await refreshCapacity(restaurant);
    if (restaurant.currentOrderCount >= restaurant.maxOrdersPerHour) {
      // Propose des alternatives
      const alternatives = await Restaurant.find({
        _id:      { $ne: restaurant._id },
        category: restaurant.category,
        isOpen:   true,
        $expr: { $lt: ['$currentOrderCount', '$maxOrdersPerHour'] },
      })
      .select('name category logoUrl rating avgPrepTime address isPriority')
      .sort({ isPriority: -1, rating: -1 })
      .limit(5);

      return res.status(429).json({
        success:      false,
        isFull:       true,
        message:      `${restaurant.name} est complet pour l'heure. Essayez un autre restaurant.`,
        queueLength:  restaurant.waitingQueue ? restaurant.waitingQueue.length : 0,
        alternatives,
      });
    }

    // Construire les items à partir du menu
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const menuItem = restaurant.menu.id(item.menuItemId);
      if (!menuItem || !menuItem.available) {
        return res.status(400).json({ success: false, message: `Item ${item.menuItemId} indisponible` });
      }
      // ── Vérification stock ──────────────────────────────────────────────
      const quantity = Math.max(1, parseInt(item.quantity) || 1);
      if (menuItem.stock !== -1 && menuItem.stock < quantity) {
        const msg = menuItem.stock === 0
          ? `"${menuItem.name}" est épuisé`
          : `Stock insuffisant pour "${menuItem.name}" (${menuItem.stock} restant(s))`;
        return res.status(400).json({ success: false, message: msg });
      }
      // ── Prix (live ou normal) ───────────────────────────────────────────
      let unitPrice = menuItem.price;
      if (restaurant.isLive && menuItem.livePrice) {
        unitPrice = menuItem.livePrice;
      } else if (restaurant.isLive && restaurant.liveDiscount > 0) {
        unitPrice = Math.round(menuItem.price * (1 - restaurant.liveDiscount));
      }
      const totalPrice = unitPrice * quantity;
      subtotal += totalPrice;
      orderItems.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        quantity,
        unitPrice,
        totalPrice,
      });
    }

    const deliveryFee = 500;
    const isLiveDeal = restaurant.isLive && restaurant.liveDiscount > 0;
    const originalSubtotal = orderItems.reduce((sum, i) => {
      const orig = restaurant.menu.id(i.menuItemId)?.price || i.unitPrice;
      return sum + orig * i.quantity;
    }, 0);
    const liveDiscount = isLiveDeal ? Math.max(0, originalSubtotal - subtotal) : 0;

    const totalAmount = subtotal + deliveryFee;

    const commissionRate = restaurant.subscription?.plan === 'premium'
      ? 0.10
      : PLATFORM_CUT_RATE;

    const platformFee = Math.round(subtotal * commissionRate);
    const restaurantCut = subtotal - platformFee;
    const deliveryCut = DELIVERY_PAY;
    const platformShare = platformFee + Math.max(0, deliveryFee - deliveryCut);

    // Paiement TPC
    if (!paymentMethod || paymentMethod === 'tpc') {
      const wallet = await Wallet.findOne({ user: req.user.userId });
      if (!wallet || wallet.balance < totalAmount) {
        return res.status(400).json({ success: false, message: `Solde TPC insuffisant (nécessaire: ${totalAmount} TPC)` });
      }
      wallet.balance -= totalAmount;
      wallet.total_spent += totalAmount;
      await wallet.save();

      await Transaction.create({
        user: req.user.userId,
        type: 'order_pay',
        amount: -totalAmount,
        balance_after: wallet.balance,
        description: `Commande chez ${restaurant.name}`,
        ref_id: restaurantId,
        ref_type: 'order',
      });
    }

    const order = await Order.create({
      customer: req.user.userId,
      restaurant: restaurantId,
      items: orderItems,
      subtotal, deliveryFee, liveDiscount, totalAmount,
      platformFee, restaurantCut, deliveryCut, platformShare,
      paymentMethod: paymentMethod || 'tpc',
      paymentStatus: 'paid',
      isLiveDeal,
      liveDiscountPct: isLiveDeal ? Math.round(restaurant.liveDiscount * 100) : 0,
      deliveryAddress: {
        address: deliveryAddress,
        lat: parseFloat(deliveryLat),
        lng: parseFloat(deliveryLng),
      },
      notes: notes || '',
      estimatedDeliveryMinutes: 30,
    });

    // ── Décrémenter stock + incrémenter capacité horaire ───────────────────
    let stockChanged = false;
    for (const oi of orderItems) {
      const menuItem = restaurant.menu.id(oi.menuItemId);
      if (menuItem) {
        menuItem.soldCount = (menuItem.soldCount || 0) + oi.quantity;
        if (menuItem.stock !== -1) {
          menuItem.stock = Math.max(0, menuItem.stock - oi.quantity);
          if (menuItem.stock === 0) menuItem.available = false;
          stockChanged = true;
        }
      }
    }
    restaurant.currentOrderCount = (restaurant.currentOrderCount || 0) + 1;
    restaurant.orderCount        = (restaurant.orderCount || 0) + 1;
    await restaurant.save();

    // Diffuser mise à jour stock si changement
    if (stockChanged && global.broadcastStockUpdate) {
      for (const oi of orderItems) {
        const mi = restaurant.menu.id(oi.menuItemId);
        if (mi && mi.stock !== -1) {
          global.broadcastStockUpdate(restaurant._id.toString(), oi.menuItemId.toString(), mi.stock);
        }
      }
    }

    // ── Fidélité : 1 TPC dépensé = 1 point gagné ──────────────────────────
    const pointsEarned = Math.floor(subtotal);  // sur le sous-total (hors livraison)
    if (pointsEarned > 0) {
      try {
        let lp = await LoyaltyProfile.findOne({ user: req.user.userId });
        if (!lp) lp = new LoyaltyProfile({ user: req.user.userId });
        lp.points       += pointsEarned;
        lp.totalEarned  += pointsEarned;
        lp.ordersCount  += 1;
        lp.history.push({
          points:      pointsEarned,
          type:        'earn',
          orderId:     order._id,
          description: `Commande #${order._id.toString().slice(-6)} chez ${restaurant.name}`,
          date:        new Date(),
        });
        await lp.save();
      } catch (_) { /* fidélité non bloquante */ }
    }

    // Notifier le restaurant via WebSocket
    if (global.broadcastToUser) {
      global.broadcastToUser(restaurant.owner.toString(), {
        type: 'new_order',
        orderId: order._id,
        restaurantId,
        message: `Nouvelle commande de ${orderItems.length} article(s) — ${totalAmount} TPC`,
        total: totalAmount,
      });
    }

    res.status(201).json({ success: true, order, pointsEarned });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CONSULTER LES COMMANDES
// ═══════════════════════════════════════════════════════════════

// GET /api/orders — commandes du client connecté
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, limit = 20, page = 1 } = req.query;
    const filter = { customer: req.user.userId };
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate('restaurant', 'name logoUrl address location')
      .populate('deliveryPerson', 'name avatar phone')
      .lean();

    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/:id — détail commande
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('restaurant', 'name logoUrl address location phone')
      .populate('customer', 'name avatar')
      .populate('deliveryPerson', 'name avatar phone')
      .lean();

    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    // Sécurité : seuls client, restaurant owner et livreur peuvent voir
    const isCustomer = order.customer._id.toString() === req.user.userId;
    const isDelivery = order.deliveryPerson?._id?.toString() === req.user.userId;
    if (!isCustomer && !isDelivery) {
      // Vérifier si c'est le proprio du restaurant
      const restaurant = await Restaurant.findById(order.restaurant._id);
      if (!restaurant || restaurant.owner.toString() !== req.user.userId) {
        return res.status(403).json({ success: false, message: 'Accès refusé' });
      }
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// STATUT COMMANDE (restaurant owner)
// ═══════════════════════════════════════════════════════════════

// PATCH /api/orders/:id/status — mettre à jour le statut
router.patch('/:id/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['confirmed', 'preparing', 'ready', 'cancelled'];

    const order = await Order.findById(req.params.id).populate('restaurant');
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    // Seul le propriétaire du restaurant peut changer le statut (sauf annulation cliente)
    const isOwner = order.restaurant.owner.toString() === req.user.userId;
    const isCustomerCancellation = status === 'cancelled' && order.customer.toString() === req.user.userId;

    if (!isOwner && !isCustomerCancellation) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Statut invalide' });
    }

    // Si annulation, rembourser le client
    if (status === 'cancelled' && order.paymentStatus === 'paid' && order.paymentMethod === 'tpc') {
      const wallet = await Wallet.findOne({ user: order.customer });
      if (wallet) {
        wallet.balance += order.totalAmount;
        wallet.total_spent = Math.max(0, wallet.total_spent - order.totalAmount);
        await wallet.save();
        await Transaction.create({
          user: order.customer,
          type: 'refund',
          amount: order.totalAmount,
          balance_after: wallet.balance,
          description: `Remboursement commande annulée`,
          ref_id: order._id.toString(),
          ref_type: 'order',
        });
      }
      order.paymentStatus = 'refunded';
    }

    // Créditer le restaurant quand commande confirmée
    if (status === 'confirmed' && order.paymentStatus === 'paid') {
      let ownerWallet = await Wallet.findOne({ user: order.restaurant.owner });
      if (!ownerWallet) ownerWallet = await Wallet.create({ user: order.restaurant.owner });
      ownerWallet.balance += order.restaurantCut;
      ownerWallet.total_earned += order.restaurantCut;
      await ownerWallet.save();

      await Transaction.create({
        user: order.restaurant.owner,
        type: 'order_earn',
        amount: order.restaurantCut,
        balance_after: ownerWallet.balance,
        description: `Commande confirmée (après 20% commission)`,
        ref_id: order._id.toString(),
        ref_type: 'order',
      });

      // Mettre à jour les stats restaurant
      await Restaurant.findByIdAndUpdate(order.restaurant._id, {
        $inc: { orderCount: 1, totalRevenue: order.restaurantCut },
      });
    }

    order.status = status;
    order.updatedAt = new Date();
    await order.save();

    // Notifier le client
    if (global.broadcastToUser) {
      const statusMessages = {
        confirmed: 'Votre commande a été acceptée !',
        preparing: 'Votre commande est en préparation...',
        ready: 'Votre commande est prête ! Un livreur va bientôt la récupérer.',
        cancelled: 'Votre commande a été annulée.',
      };
      global.broadcastToUser(order.customer.toString(), {
        type: 'order_status_update',
        orderId: order._id,
        status,
        message: statusMessages[status] || `Statut: ${status}`,
      });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// LIVRAISON
// ═══════════════════════════════════════════════════════════════

// GET /api/orders/delivery/available — commandes disponibles pour livraison
router.get('/delivery/available', verifyToken, async (req, res) => {
  try {
    const orders = await Order.find({ status: 'ready', deliveryPerson: null })
      .sort({ createdAt: 1 })
      .populate('restaurant', 'name address location')
      .populate('customer', 'name')
      .lean();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/delivery/my-orders — commandes du livreur connecté
router.get('/delivery/my-orders', verifyToken, async (req, res) => {
  try {
    const orders = await Order.find({
      deliveryPerson: req.user.userId,
      status: { $in: ['picked_up', 'delivering'] },
    })
      .populate('restaurant', 'name address location phone')
      .populate('customer', 'name phone')
      .lean();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:id/accept-delivery — livreur accepte la commande
router.post('/:id/accept-delivery', verifyToken, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, status: 'ready', deliveryPerson: null });
    if (!order) return res.status(404).json({ success: false, message: 'Commande non disponible' });

    order.deliveryPerson = req.user.userId;
    order.status = 'picked_up';
    order.updatedAt = new Date();
    await order.save();

    // Lier au profil livreur
    await DeliveryPerson.findOneAndUpdate(
      { user: req.user.userId },
      { currentOrder: order._id, isActive: true },
      { upsert: false },
    );

    // Notifier le client
    if (global.broadcastToUser) {
      global.broadcastToUser(order.customer.toString(), {
        type: 'order_status_update',
        orderId: order._id,
        status: 'picked_up',
        message: 'Un livreur a accepté votre commande et est en route !',
      });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/orders/:id/delivered — marquer comme livré
router.patch('/:id/delivered', verifyToken, async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      deliveryPerson: req.user.userId,
      status: { $in: ['picked_up', 'delivering'] },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    order.status = 'delivered';
    order.updatedAt = new Date();
    await order.save();

    // Payer le livreur
    let deliveryWallet = await Wallet.findOne({ user: req.user.userId });
    if (!deliveryWallet) deliveryWallet = await Wallet.create({ user: req.user.userId });
    deliveryWallet.balance += order.deliveryCut;
    deliveryWallet.total_earned += order.deliveryCut;
    await deliveryWallet.save();

    await Transaction.create({
      user: req.user.userId,
      type: 'delivery_earn',
      amount: order.deliveryCut,
      balance_after: deliveryWallet.balance,
      description: `Livraison effectuée`,
      ref_id: order._id.toString(),
      ref_type: 'order',
    });

    await DeliveryPerson.findOneAndUpdate(
      { user: req.user.userId },
      { currentOrder: null, $inc: { deliveryCount: 1, totalEarned: order.deliveryCut } },
    );

    if (global.broadcastToUser) {
      global.broadcastToUser(order.customer.toString(), {
        type: 'order_status_update',
        orderId: order._id,
        status: 'delivered',
        message: 'Votre commande a été livrée ! Bon appétit !',
      });
    }

    res.json({ success: true, order, earned: order.deliveryCut });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// COMMANDES RESTAURANT (dashboard proprio)
// ═══════════════════════════════════════════════════════════════

// GET /api/orders/restaurant/incoming — commandes reçues par le restaurant
router.get('/restaurant/incoming', verifyToken, async (req, res) => {
  try {
    const restaurant = await Restaurant.findOne({ owner: req.user.userId });
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant introuvable' });

    const { status } = req.query;
    const filter = { restaurant: restaurant._id };
    if (status) filter.status = status;
    else filter.status = { $nin: ['delivered', 'cancelled'] };

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .populate('customer', 'name avatar phone')
      .lean();

    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROFIL LIVREUR
// ═══════════════════════════════════════════════════════════════

// POST /api/orders/delivery/register — s'inscrire comme livreur
router.post('/delivery/register', verifyToken, async (req, res) => {
  try {
    const { phone, vehicle } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'phone requis' });

    const existing = await DeliveryPerson.findOne({ user: req.user.userId });
    if (existing) return res.status(400).json({ success: false, message: 'Déjà inscrit comme livreur' });

    const dp = await DeliveryPerson.create({
      user: req.user.userId,
      phone,
      vehicle: vehicle || 'moto',
    });

    res.status(201).json({ success: true, deliveryPerson: dp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/delivery/profile — profil livreur
router.get('/delivery/profile', verifyToken, async (req, res) => {
  try {
    const dp = await DeliveryPerson.findOne({ user: req.user.userId });
    if (!dp) return res.status(404).json({ success: false, message: 'Profil livreur introuvable' });
    res.json({ success: true, deliveryPerson: dp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/orders/delivery/toggle-online — activer/désactiver disponibilité
router.patch('/delivery/toggle-online', verifyToken, async (req, res) => {
  try {
    const dp = await DeliveryPerson.findOne({ user: req.user.userId });
    if (!dp) return res.status(404).json({ success: false, message: 'Profil livreur introuvable' });

    dp.isOnline = !dp.isOnline;
    await dp.save();

    res.json({ success: true, isOnline: dp.isOnline });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/delivery/location — REST fallback pour mise à jour GPS
router.post('/delivery/location', verifyToken, async (req, res) => {
  try {
    const { orderId, lat, lng, speed, heading } = req.body;
    if (!orderId || lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: 'orderId, lat, lng requis' });
    }

    const order = await Order.findOne({
      _id: orderId,
      deliveryPerson: req.user.userId,
      status: { $in: ['picked_up', 'delivering'] },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Commande non trouvée' });

    order.deliveryPersonLocation = {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      speed: parseFloat(speed) || 0,
      heading: parseFloat(heading) || 0,
      updatedAt: new Date(),
    };
    if (order.status === 'picked_up') order.status = 'delivering';
    order.updatedAt = new Date();
    await order.save();

    // Broadcast via WebSocket
    if (global.broadcastOrderLocation) {
      global.broadcastOrderLocation(orderId, {
        type: 'delivery_update',
        orderId,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        speed: parseFloat(speed) || 0,
        heading: parseFloat(heading) || 0,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
