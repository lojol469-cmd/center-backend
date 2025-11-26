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
    console.log('Body keys:', Object.keys(req.body));
    console.log('Body cardData:', req.body.cardData);
    console.log('Body biometricData:', req.body.biometricData);
    console.log('Body forceRecreate:', req.body.forceRecreate);
    console.log('Files:', req.files);

    const { cardData: cardDataString, biometricData: biometricDataString } = req.body;
    const forceRecreate = req.body.forceRecreate === 'true';

    // Parser les données JSON
    let cardData, biometricData;
    try {
      cardData = cardDataString ? JSON.parse(cardDataString) : {};
      biometricData = biometricDataString ? JSON.parse(biometricDataString) : {};
    } catch (parseError) {
      console.log('❌ Erreur parsing JSON:', parseError.message);
      return res.status(400).json({
        success: false,
        message: 'Données JSON invalides'
      });
    }

    // Vérifier si l'utilisateur a déjà une carte
    const existingCard = await VirtualIDCard.findOne({ userId: req.user.userId });
    if (existingCard && !forceRecreate) {
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà une carte d\'identité virtuelle'
      });
    }

    // Si forceRecreate est true et qu'une carte existe, la supprimer d'abord
    if (existingCard && forceRecreate) {
      console.log('🔄 Force recreate activé - Suppression de la carte existante');
      await VirtualIDCard.findByIdAndDelete(existingCard._id);
    }

    // Validation des données obligatoires
    if (!cardData || !cardData.firstName || !cardData.idNumber) {
      console.log('❌ Validation échouée: données manquantes');
      return res.status(400).json({
        success: false,
        message: 'Données de carte incomplètes'
      });
    }

    // Vérifier si l'idNumber est déjà utilisé PAR UN AUTRE utilisateur
    console.log('🔍 Vérification unicité idNumber:', cardData.idNumber);
    const existingCardById = await VirtualIDCard.findOne({
      'cardData.idNumber': cardData.idNumber,
      userId: { $ne: req.user.userId } // Exclure la carte de l'utilisateur actuel
    });
    if (existingCardById) {
      console.log('❌ idNumber déjà utilisé par un autre utilisateur:', cardData.idNumber);
      return res.status(400).json({
        success: false,
        message: 'Ce numéro d\'identité est déjà utilisé par un autre utilisateur'
      });
    }

    // Traiter les fichiers uploadés (images de la carte)
    let cardImageData = {};

    if (req.files && req.files.length > 0) {
      console.log('📁 Fichiers uploadés détectés:', req.files.length);

      for (const file of req.files) {
        console.log('📄 Fichier:', file.originalname, 'Type:', file.mimetype);

        if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
          // Pour les PDFs et images, stocker les URLs Cloudinary
          if (file.mimetype === 'application/pdf' || file.fieldname === 'cardPdf') {
            // Carte PDF complète
            cardImageData.frontImage = file.path; // URL Cloudinary
            cardImageData.frontImagePublicId = file.filename; // Public ID pour suppression
            console.log('📄 PDF uploadé:', file.path);
          } else if (file.fieldname === 'frontImage') {
            cardImageData.frontImage = file.path;
            cardImageData.frontImagePublicId = file.filename;
            console.log('🖼️ Image avant uploadée:', file.path);
          } else if (file.fieldname === 'backImage') {
            cardImageData.backImage = file.path;
            cardImageData.backImagePublicId = file.filename;
            console.log('🖼️ Image arrière uploadée:', file.path);
          }
        }
      }
    } else {
      console.log('⚠️ Aucun fichier uploadé');
    }

    // Compléter les données manquantes avec des valeurs par défaut
    const completeCardData = {
      firstName: cardData.firstName,
      lastName: cardData.lastName || '',
      dateOfBirth: cardData.dateOfBirth || new Date('1990-01-01'), // Date par défaut
      placeOfBirth: cardData.placeOfBirth || 'Non spécifié',
      nationality: cardData.nationality || 'Non spécifiée',
      address: cardData.address || 'Adresse non fournie',
      idNumber: cardData.idNumber,
      issueDate: cardData.issueDate ? new Date(cardData.issueDate) : new Date(),
      expiryDate: cardData.expiryDate ? new Date(cardData.expiryDate) : new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      gender: cardData.gender || 'M', // Par défaut masculin
      bloodType: cardData.bloodType,
      height: cardData.height,
      profession: cardData.profession,
      maritalStatus: cardData.maritalStatus,
      phoneNumber: cardData.phoneNumber,
      emergencyContact: cardData.emergencyContact || {},
      email: cardData.email || ''
    };

    console.log('📋 Données complètes avant création:', JSON.stringify(completeCardData, null, 2));

    // Créer la carte
    console.log('🏗️ Création de l\'objet VirtualIDCard...');
    const newCard = new VirtualIDCard({
      userId: req.user.userId,
      cardData: completeCardData,
      biometricData: biometricData || {},
      cardImage: cardImageData, // Ajouter les données d'image
      verificationStatus: 'verified', // Marquer comme vérifiée automatiquement
      isActive: true
    });

    console.log('💾 Tentative de sauvegarde en base de données...');
    try {
      await newCard.save();
      console.log('✅ Sauvegarde réussie, ID:', newCard._id);
    } catch (saveError) {
      console.error('❌ Erreur lors de la sauvegarde:', saveError);
      console.error('❌ Détails de l\'erreur:', saveError.message);
      console.error('❌ Erreurs de validation:', saveError.errors);
      throw saveError; // Re-throw pour être catché par le try-catch principal
    }

    console.log('✅ Carte d\'identité virtuelle créée:', newCard._id);

    res.status(201).json({
      success: true,
      message: 'Carte d\'identité virtuelle créée avec succès',
      card: newCard
    });
  } catch (err) {
    console.error('❌ Erreur création carte d\'identité:', err);
    console.error('❌ Message d\'erreur:', err.message);
    console.error('❌ Type d\'erreur:', err.name);
    console.error('❌ Code d\'erreur:', err.code);
    console.error('❌ Erreurs de validation:', err.errors);
    if (err.errors) {
      Object.keys(err.errors).forEach(key => {
        console.error(`❌ Validation ${key}:`, err.errors[key].message);
      });
    }
    console.error('❌ Stack trace:', err.stack);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la carte d\'identité',
      error: err.message,
      details: err.errors
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

    const { cardData: cardDataString, biometricData: biometricDataString } = req.body;

    // Parser les données JSON si elles existent
    let cardData, biometricData;
    if (cardDataString) {
      try {
        cardData = JSON.parse(cardDataString);
      } catch (parseError) {
        console.log('❌ Erreur parsing cardData JSON:', parseError.message);
        return res.status(400).json({
          success: false,
          message: 'Données cardData JSON invalides'
        });
      }
    }
    if (biometricDataString) {
      try {
        biometricData = JSON.parse(biometricDataString);
      } catch (parseError) {
        console.log('❌ Erreur parsing biometricData JSON:', parseError.message);
        return res.status(400).json({
          success: false,
          message: 'Données biometricData JSON invalides'
        });
      }
    }

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
 * Vérifier si un utilisateur a une carte d'identité virtuelle (publique)
 */
exports.checkUserHasVirtualIDCard = async (req, res) => {
  try {
    console.log('\n=== VÉRIFICATION CARTE UTILISATEUR ===');
    console.log('Email:', req.body.email);

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email requis'
      });
    }

    // Chercher l'utilisateur par email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Chercher la carte virtuelle de cet utilisateur
    const card = await VirtualIDCard.findOne({
      userId: user._id,
      isActive: true,
      verificationStatus: 'verified'
    });

    if (!card) {
      return res.json({
        success: true,
        hasCard: false,
        message: 'Aucune carte d\'identité virtuelle trouvée pour cet utilisateur'
      });
    }

    console.log('✅ Carte trouvée pour l\'utilisateur:', user.email);

    res.json({
      success: true,
      hasCard: true,
      cardId: card.cardData.idNumber,
      userName: user.name,
      message: 'Carte d\'identité virtuelle trouvée'
    });
  } catch (err) {
    console.error('❌ Erreur vérification carte utilisateur:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification',
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
exports.getAllVirtualIDCards = async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION TOUTES LES CARTES D\'IDENTITÉ (ADMIN) ===');

    // Vérifier que l'utilisateur est admin (accessLevel >= 3)
    if (!req.user || req.user.accessLevel < 3) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé - Niveau d\'accès insuffisant'
      });
    }

    const cards = await VirtualIDCard.find({})
      .populate('userId', 'name email profileImage accessLevel')
      .sort({ createdAt: -1 });

    // Transformer les données pour inclure les infos utilisateur
    const cardsWithUserInfo = cards.map(card => ({
      _id: card._id,
      userId: card.userId._id,
      userName: card.userId.name,
      userEmail: card.userId.email,
      userProfileImage: card.userId.profileImage,
      userAccessLevel: card.userId.accessLevel,
      cardData: card.cardData,
      biometricData: {
        hasFingerprint: !!card.biometricData.fingerprintHash,
        hasFaceData: !!card.biometricData.faceData,
        hasIrisData: !!card.biometricData.irisData,
        hasVoiceData: !!card.biometricData.voiceData,
        lastBiometricUpdate: card.biometricData.lastBiometricUpdate
      },
      verificationStatus: card.verificationStatus,
      isActive: card.isActive,
      usageCount: card.usageCount,
      lastUsed: card.lastUsed,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      activeTokensCount: card.authenticationTokens.filter(t =>
        t.isActive && t.expiresAt > new Date()
      ).length
    }));

    console.log(`✅ ${cardsWithUserInfo.length} cartes d'identité récupérées`);

    res.json({
      success: true,
      cards: cardsWithUserInfo,
      total: cardsWithUserInfo.length
    });
  } catch (err) {
    console.error('❌ Erreur récupération toutes les cartes:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des cartes d\'identité',
      error: err.message
    });
  }
};

/**
 * Supprimer une carte d'identité virtuelle par ID (ADMIN)
 */
exports.deleteVirtualIDCardById = async (req, res) => {
  try {
    console.log('\n=== SUPPRESSION CARTE D\'IDENTITÉ PAR ID (ADMIN) ===');
    console.log('Card ID:', req.params.cardId);
    console.log('Admin User ID:', req.user.userId);

    // Vérifier que l'utilisateur est admin (accessLevel >= 3)
    if (!req.user || req.user.accessLevel < 3) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé - Niveau d\'accès insuffisant'
      });
    }

    const card = await VirtualIDCard.findById(req.params.cardId);

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité virtuelle non trouvée'
      });
    }

    // Supprimer les images de Cloudinary si elles existent
    if (card.cardImage?.frontImagePublicId) {
      try {
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

    console.log('✅ Carte d\'identité supprimée par admin');

    res.json({
      success: true,
      message: 'Carte d\'identité supprimée avec succès'
    });
  } catch (err) {
    console.error('❌ Erreur suppression carte d\'identité par admin:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de la carte d\'identité',
      error: err.message
    });
  }
};

module.exports = exports;