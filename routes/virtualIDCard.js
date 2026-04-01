/**
 * Routes pour la gestion des cartes d'identité virtuelles biométriques
 */

const express = require('express');
const router = express.Router();
const virtualIDCardController = require('../controllers/virtualIDCardController');
const { verifyToken } = require('../middleware/auth');
const { virtualIDCardUpload, idCardPhotoUpload } = require('../cloudynary');

// Routes CRUD principales
router.post('/', verifyToken, virtualIDCardUpload.any(), virtualIDCardController.createVirtualIDCard);
router.get('/', verifyToken, virtualIDCardController.getVirtualIDCard);
router.put('/', verifyToken, virtualIDCardUpload.any(), virtualIDCardController.updateVirtualIDCard);
router.delete('/', verifyToken, virtualIDCardController.deleteVirtualIDCard);

// ─── Routes photo de profil sur la carte ─────────────────────────────────────
// PUT /api/virtual-id-cards/photo - Upload nouvelle photo depuis galerie/caméra
router.put('/photo', verifyToken, idCardPhotoUpload.single('photo'), virtualIDCardController.updateCardPhoto);
// POST /api/virtual-id-cards/photo/sync - Copier la photo de profil du compte vers la carte
router.post('/photo/sync', verifyToken, virtualIDCardController.syncProfilePhotoToCard);

// Renouveler la carte (change l'ID tous les 3 mois automatiquement)
router.post('/renew', verifyToken, virtualIDCardController.renewVirtualIDCard);

// Routes d'authentification biométrique
router.post('/auth/biometric', virtualIDCardController.authenticateBiometric);
router.post('/auth/verify-token', virtualIDCardController.verifyAuthToken);
router.post('/auth/revoke-token', verifyToken, virtualIDCardController.revokeAuthToken);

// Vérifier si un utilisateur a une carte d'identité virtuelle (publique)
router.post('/check-user-card', virtualIDCardController.checkUserHasVirtualIDCard);

// Routes de statistiques
router.get('/stats', verifyToken, virtualIDCardController.getCardStats);

// Télécharger le PDF de la carte d'identité
router.get('/download-pdf', verifyToken, virtualIDCardController.downloadVirtualIDCardPDF);

// Routes admin
router.get('/admin/all', verifyToken, virtualIDCardController.getAllVirtualIDCards);
router.delete('/admin/:cardId', verifyToken, virtualIDCardController.deleteVirtualIDCardById);

module.exports = router;