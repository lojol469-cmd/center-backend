/**
 * Routes pour la gestion des publications
 */

const express = require('express');
const router = express.Router();
const publicationController = require('../controllers/publicationController');
const { verifyToken } = require('../middleware/auth');
const { publicationUpload } = require('../middleware/upload');

// Routes publications
router.get('/', verifyToken, publicationController.getPublications);
router.post('/', verifyToken, publicationUpload.array('media', 5), publicationController.createPublication);
router.delete('/:id', verifyToken, publicationController.deletePublication);
router.post('/:id/like', verifyToken, publicationController.toggleLike);

module.exports = router;
