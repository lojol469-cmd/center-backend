/**
 * Routes pour la gestion des cartes d'identité virtuelles biométriques
 */

const express = require('express');
const router = express.Router();
const virtualIDCardController = require('../controllers/virtualIDCardController');
const { verifyToken } = require('../middleware/auth');
const { employeeUpload } = require('../cloudynary');

// Routes pour les cartes d'identité virtuelles
router.post('/', verifyToken, virtualIDCardController.createVirtualIDCard);
router.get('/', verifyToken, virtualIDCardController.getVirtualIDCard);
router.put('/', verifyToken, virtualIDCardController.updateVirtualIDCard);
router.delete('/', verifyToken, virtualIDCardController.deleteVirtualIDCard);

// Routes d'authentification biométrique
router.post('/auth/biometric', virtualIDCardController.authenticateBiometric);
router.post('/auth/verify-token', virtualIDCardController.verifyAuthToken);
router.post('/auth/revoke-token', verifyToken, virtualIDCardController.revokeAuthToken);

// Routes de statistiques
router.get('/stats', verifyToken, virtualIDCardController.getCardStats);

// Routes admin
router.get('/admin/all', verifyToken, virtualIDCardController.getAllVirtualIDCards);
router.delete('/admin/:cardId', verifyToken, virtualIDCardController.deleteVirtualIDCardById);

module.exports = router;