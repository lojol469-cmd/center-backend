/**
 * Contrôleur pour la gestion des cartes d'identité virtuelles biométriques
 * Gère toutes les opérations CRUD et l'authentification biométrique
 */

// Variables globales pour les modèles et fonctions depuis server.js
let VirtualIDCard = null;
let User = null;
let sendPushNotificationFunc = null;
let sendEmailNotificationFunc = null;
let baseUrl = null;

// Fonction pour initialiser les dépendances et modèles
exports.initNotifications = (sendPush, sendEmail, url) => {
  sendPushNotificationFunc = sendPush;
  sendEmailNotificationFunc = sendEmail;
  baseUrl = url;
};

// Fonction pour initialiser les modèles
exports.initModels = (virtualIDCardModel, userModel) => {
  VirtualIDCard = virtualIDCardModel;
  User = userModel;
};

/**
 * Créer une nouvelle carte d'identité virtuelle
 */
exports.createVirtualIDCard = async (req, res) => {
  try {
    console.log('\n=== CRÉATION CARTE D\'IDENTITÉ VIRTUELLE ===');
    console.log('User ID:', req.user.userId);
    console.log('Body:', req.body);

    const { cardData, biometricData } = req.body;

    // Vérifier si l'utilisateur a déjà une carte
    const existingCard = await VirtualIDCard.findOne({ userId: req.user.userId });
    if (existingCard) {
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà une carte d\'identité virtuelle'
      });
    }

    // Validation des données obligatoires
    if (!cardData || !cardData.firstName || !cardData.lastName || !cardData.idNumber) {
      return res.status(400).json({
        success: false,
        message: 'Données de carte incomplètes'
      });
    }

    // Créer la carte
    const newCard = new VirtualIDCard({
      userId: req.user.userId,
      cardData: {
        ...cardData,
        issueDate: new Date(),
        expiryDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) // 10 ans
      },
      biometricData: biometricData || {},
      verificationStatus: 'pending'
    });

    await newCard.save();

    console.log('✅ Carte d\'identité virtuelle créée:', newCard._id);

    res.status(201).json({
      success: true,
      message: 'Carte d\'identité virtuelle créée avec succès',
      card: newCard
    });
  } catch (err) {
    console.error('❌ Erreur création carte d\'identité:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la carte d\'identité',
      error: err.message
    });
  }
};

/**
 * Récupérer la carte d'identité virtuelle de l'utilisateur
 */
exports.getVirtualIDCard = async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION CARTE D\'IDENTITÉ VIRTUELLE ===');
    console.log('User ID:', req.user.userId);

    const card = await VirtualIDCard.findOne({ userId: req.user.userId });

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité virtuelle non trouvée'
      });
    }

    // Mettre à jour la dernière utilisation
    card.lastUsed = new Date();
    card.usageCount += 1;
    await card.save();

    console.log('✅ Carte d\'identité trouvée');

    res.json({
      success: true,
      card: card
    });
  } catch (err) {
    console.error('❌ Erreur récupération carte d\'identité:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la carte d\'identité',
      error: err.message
    });
  }
};

/**
 * Mettre à jour la carte d'identité virtuelle
 */
exports.updateVirtualIDCard = async (req, res) => {
  try {
    console.log('\n=== MISE À JOUR CARTE D\'IDENTITÉ VIRTUELLE ===');
    console.log('User ID:', req.user.userId);

    const { cardData, biometricData } = req.body;

    const card = await VirtualIDCard.findOne({ userId: req.user.userId });

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité virtuelle non trouvée'
      });
    }

    // Mettre à jour les données
    if (cardData) {
      card.cardData = { ...card.cardData, ...cardData };
    }

    if (biometricData) {
      card.biometricData = { ...card.biometricData, ...biometricData, lastBiometricUpdate: new Date() };
    }

    card.updatedAt = new Date();
    await card.save();

    console.log('✅ Carte d\'identité mise à jour');

    res.json({
      success: true,
      message: 'Carte d\'identité mise à jour avec succès',
      card: card
    });
  } catch (err) {
    console.error('❌ Erreur mise à jour carte d\'identité:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la carte d\'identité',
      error: err.message
    });
  }
};

/**
 * Supprimer la carte d'identité virtuelle
 */
exports.deleteVirtualIDCard = async (req, res) => {
  try {
    console.log('\n=== SUPPRESSION CARTE D\'IDENTITÉ VIRTUELLE ===');
    console.log('User ID:', req.user.userId);

    const card = await VirtualIDCard.findOne({ userId: req.user.userId });

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité virtuelle non trouvée'
      });
    }

    // Supprimer les images de Cloudinary si elles existent
    if (card.cardImage?.frontImagePublicId) {
      try {
        // Note: deleteFromCloudinary doit être importé depuis cloudynary.js
        const { deleteFromCloudinary } = require('../cloudynary');
        await deleteFromCloudinary(card.cardImage.frontImagePublicId);
        console.log('✅ Image avant supprimée de Cloudinary');
      } catch (err) {
        console.log('⚠️ Erreur suppression image avant:', err.message);
      }
    }

    if (card.cardImage?.backImagePublicId) {
      try {
        const { deleteFromCloudinary } = require('../cloudynary');
        await deleteFromCloudinary(card.cardImage.backImagePublicId);
        console.log('✅ Image arrière supprimée de Cloudinary');
      } catch (err) {
        console.log('⚠️ Erreur suppression image arrière:', err.message);
      }
    }

    await VirtualIDCard.findByIdAndDelete(card._id);

    console.log('✅ Carte d\'identité supprimée');

    res.json({
      success: true,
      message: 'Carte d\'identité supprimée avec succès'
    });
  } catch (err) {
    console.error('❌ Erreur suppression carte d\'identité:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de la carte d\'identité',
      error: err.message
    });
  }
};

/**
 * Authentifier via biométrie et générer un token d'accès
 */
exports.authenticateBiometric = async (req, res) => {
  try {
    console.log('\n=== AUTHENTIFICATION BIOMÉTRIQUE ===');
    console.log('Body:', req.body);

    const { biometricType, biometricData, deviceId } = req.body;

    if (!biometricType || !biometricData) {
      return res.status(400).json({
        success: false,
        message: 'Type et données biométriques requis'
      });
    }

    // Chercher la carte par données biométriques
    let card = null;
    const biometricQuery = {};

    switch (biometricType) {
      case 'fingerprint':
        biometricQuery['biometricData.fingerprintHash'] = biometricData;
        break;
      case 'face':
        biometricQuery['biometricData.faceData'] = biometricData;
        break;
      case 'iris':
        biometricQuery['biometricData.irisData'] = biometricData;
        break;
      case 'voice':
        biometricQuery['biometricData.voiceData'] = biometricData;
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Type biométrique non supporté'
        });
    }

    card = await VirtualIDCard.findOne({
      ...biometricQuery,
      isActive: true,
      verificationStatus: 'verified'
    });

    if (!card) {
      return res.status(401).json({
        success: false,
        message: 'Authentification biométrique échouée'
      });
    }

    // Générer un token d'authentification temporaire
    const crypto = require('crypto');
    const authToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Ajouter le token à la carte
    card.authenticationTokens.push({
      token: authToken,
      deviceId: deviceId,
      biometricType: biometricType,
      expiresAt: expiresAt,
      isActive: true
    });

    // Nettoyer les tokens expirés
    card.authenticationTokens = card.authenticationTokens.filter(t =>
      t.expiresAt > new Date() && t.isActive
    );

    await card.save();

    // Récupérer les informations utilisateur
    const user = await User.findById(card.userId).select('name email profileImage');

    console.log('✅ Authentification biométrique réussie pour:', user.email);

    // Envoyer une notification push
    if (sendPushNotificationFunc) {
      await sendPushNotificationFunc(card.userId, {
        title: '🔐 Connexion biométrique',
        body: `Connexion réussie via ${biometricType}`,
        data: {
          type: 'biometric_login',
          biometricType: biometricType,
          deviceId: deviceId,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.json({
      success: true,
      message: 'Authentification biométrique réussie',
      authToken: authToken,
      expiresAt: expiresAt,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      },
      cardData: {
        idNumber: card.cardData.idNumber,
        firstName: card.cardData.firstName,
        lastName: card.cardData.lastName
      }
    });
  } catch (err) {
    console.error('❌ Erreur authentification biométrique:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'authentification biométrique',
      error: err.message
    });
  }
};

/**
 * Vérifier un token d'authentification biométrique
 */
exports.verifyAuthToken = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token requis'
      });
    }

    const card = await VirtualIDCard.findOne({
      'authenticationTokens.token': token,
      'authenticationTokens.isActive': true,
      'authenticationTokens.expiresAt': { $gt: new Date() }
    });

    if (!card) {
      return res.status(401).json({
        success: false,
        message: 'Token invalide ou expiré'
      });
    }

    // Récupérer le token spécifique
    const authToken = card.authenticationTokens.find(t => t.token === token && t.isActive);

    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: 'Token invalide'
      });
    }

    // Générer un JWT complet
    const jwt = require('jsonwebtoken');
    const accessToken = jwt.sign(
      { userId: card.userId, biometricAuth: true },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const refreshToken = jwt.sign(
      { userId: card.userId },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    console.log('✅ Token biométrique vérifié, JWT généré');

    res.json({
      success: true,
      message: 'Token vérifié avec succès',
      accessToken: accessToken,
      refreshToken: refreshToken,
      biometricType: authToken.biometricType
    });
  } catch (err) {
    console.error('❌ Erreur vérification token:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification du token',
      error: err.message
    });
  }
};

/**
 * Désactiver un token d'authentification
 */
exports.revokeAuthToken = async (req, res) => {
  try {
    const { token } = req.body;

    const card = await VirtualIDCard.findOne({ userId: req.user.userId });

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité non trouvée'
      });
    }

    // Désactiver le token
    const tokenIndex = card.authenticationTokens.findIndex(t => t.token === token);
    if (tokenIndex > -1) {
      card.authenticationTokens[tokenIndex].isActive = false;
      await card.save();

      console.log('✅ Token désactivé');

      res.json({
        success: true,
        message: 'Token désactivé avec succès'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Token non trouvé'
      });
    }
  } catch (err) {
    console.error('❌ Erreur révocation token:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la révocation du token',
      error: err.message
    });
  }
};

/**
 * Récupérer les statistiques d'utilisation de la carte
 */
exports.getCardStats = async (req, res) => {
  try {
    const card = await VirtualIDCard.findOne({ userId: req.user.userId });

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité non trouvée'
      });
    }

    // Compter les tokens actifs
    const activeTokens = card.authenticationTokens.filter(t =>
      t.isActive && t.expiresAt > new Date()
    ).length;

    // Statistiques par type biométrique
    const biometricStats = {};
    card.authenticationTokens.forEach(token => {
      if (!biometricStats[token.biometricType]) {
        biometricStats[token.biometricType] = 0;
      }
      biometricStats[token.biometricType]++;
    });

    res.json({
      success: true,
      stats: {
        usageCount: card.usageCount,
        lastUsed: card.lastUsed,
        activeTokens: activeTokens,
        totalTokens: card.authenticationTokens.length,
        biometricStats: biometricStats,
        verificationStatus: card.verificationStatus,
        createdAt: card.createdAt
      }
    });
  } catch (err) {
    console.error('❌ Erreur récupération stats:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: err.message
    });
  }
};

module.exports = exports;