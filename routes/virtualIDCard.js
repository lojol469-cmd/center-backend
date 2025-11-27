/**
 * Routes pour la gestion des cartes d'identité virtuelles biométriques
 */

const express = require('express');
const router = express.Router();
const virtualIDCardController = require('../controllers/virtualIDCardController');
const { verifyToken } = require('../middleware/auth');
const { virtualIDCardUpload } = require('../cloudynary');

// Routes pour les cartes d'identité virtuelles
router.post('/', verifyToken, virtualIDCardUpload.any(), virtualIDCardController.createVirtualIDCard);
router.get('/', verifyToken, virtualIDCardController.getVirtualIDCard);
router.put('/', verifyToken, virtualIDCardUpload.any(), virtualIDCardController.updateVirtualIDCard);
router.delete('/', verifyToken, virtualIDCardController.deleteVirtualIDCard);

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

// Routes admin
router.get('/admin/all', verifyToken, virtualIDCardController.getAllVirtualIDCards);
router.delete('/admin/:cardId', verifyToken, virtualIDCardController.deleteVirtualIDCardById);

// Route pour tÃ©lÃ©charger le PDF via le backend (contourne les restrictions Cloudinary)
router.get('/download-pdf', verifyToken, virtualIDCardController.downloadVirtualIDCardPDF);

module.exports = router;