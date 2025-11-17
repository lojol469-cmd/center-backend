/**
 * Contrôleur pour la gestion des publications
 * Gère toutes les opérations CRUD sur les publications
 */

// Variables globales pour les modèles et fonctions depuis server.js
let Publication = null;
let User = null;
let Notification = null;
let sendPushNotificationFunc = null;
let sendEmailNotificationFunc = null;
let baseUrl = null;
let broadcastToAll = null;

// Fonction pour initialiser les dépendances et modèles
exports.initNotifications = (sendPush, sendEmail, url) => {
  sendPushNotificationFunc = sendPush;
  sendEmailNotificationFunc = sendEmail;
  baseUrl = url;
};

// Fonction pour initialiser les modèles
exports.initModels = (publicationModel, userModel, notificationModel) => {
  Publication = publicationModel;
  User = userModel;
  Notification = notificationModel;
};

// Fonction pour initialiser WebSocket
exports.initWebSocket = (broadcastFunc) => {
  broadcastToAll = broadcastFunc;
};

/**
 * Récupérer toutes les publications avec pagination
 */
exports.getPublications = async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION PUBLICATIONS ===');
    console.log('User ID:', req.user.userId);
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    console.log(`Page: ${page} Limit: ${limit}`);

    const publications = await Publication.find()
      .populate('userId', 'name email profileImage')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Publication.countDocuments();
    const totalPages = Math.ceil(total / limit);

    console.log(`✅ Publications trouvées: ${publications.length} / ${total}`);

    res.json({
      success: true,
      publications,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit
      }
    });
  } catch (err) {
    console.error('❌ Erreur récupération publications:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des publications',
      error: err.message 
    });
  }
};

/**
 * Créer une nouvelle publication
 */
exports.createPublication = async (req, res) => {
  try {
    console.log('\n=== CRÉATION PUBLICATION ===');
    console.log('User ID:', req.user.userId);
    console.log('Body:', req.body);
    console.log('Files:', req.files);

    const { content } = req.body;
    const media = [];

    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        media.push({
          type: file.mimetype.startsWith('image/') ? 'image' : 'video',
          url: `${process.env.BASE_URL}/uploads/publications/${file.filename}`
        });
      });
    }

    const newPublication = new Publication({
      userId: req.user.userId,
      content,
      media
    });

    await newPublication.save();
    console.log('✅ Publication sauvegardée:', newPublication._id);

    const populatedPublication = await Publication.findById(newPublication._id)
      .populate('userId', 'firstName lastName email faceImage avatar');

    // Notifier via WebSocket
    if (broadcastToAll) {
      broadcastToAll({
        type: 'new_publication',
        publication: populatedPublication
      });
    }

    res.status(201).json({
      success: true,
      message: 'Publication créée avec succès',
      publication: populatedPublication
    });
  } catch (err) {
    console.error('❌ Erreur création publication:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la création de la publication',
      error: err.message 
    });
  }
};

/**
 * Supprimer une publication
 */
exports.deletePublication = async (req, res) => {
  try {
    const publication = await Publication.findById(req.params.id);
    
    if (!publication) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    // Vérifier que l'utilisateur est le propriétaire
    if (publication.userId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Non autorisé à supprimer cette publication' });
    }

    await Publication.deleteOne({ _id: req.params.id });

    // Notifier via WebSocket
    if (broadcastToAll) {
      broadcastToAll({
        type: 'publication_deleted',
        publicationId: req.params.id
      });
    }

    res.json({
      success: true,
      message: 'Publication supprimée avec succès'
    });
  } catch (err) {
    console.error('Erreur suppression publication:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la suppression',
      error: err.message 
    });
  }
};

/**
 * Liker/Unliker une publication
 */
exports.toggleLike = async (req, res) => {
  try {
    const publication = await Publication.findById(req.params.id).populate('userId', 'name email fcmToken notificationSettings');
    
    if (!publication) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    const userId = req.user.userId;
    const likeIndex = publication.likes.indexOf(userId);
    let isLiked = false;

    if (likeIndex > -1) {
      // Retirer le like
      publication.likes.splice(likeIndex, 1);
      isLiked = false;
    } else {
      // Ajouter le like
      publication.likes.push(userId);
      isLiked = true;

      // ✅ ENVOYER NOTIFICATION SI CE N'EST PAS L'AUTEUR QUI LIKE (sans bloquer le like si erreur)
      if (publication.userId && publication.userId._id.toString() !== userId) {
        // Exécuter les notifications de manière asynchrone sans bloquer
        (async () => {
          try {
            if (sendPushNotificationFunc && sendEmailNotificationFunc && baseUrl) {
              const liker = await User.findById(userId).select('name email profileImage');
              const publicationAuthor = publication.userId;

              if (liker && publicationAuthor) {
                // Notification Push
                if (publicationAuthor.fcmToken && publicationAuthor.notificationSettings?.likes !== false) {
                  console.log(`\n❤️ Envoi notification push pour like`);
                  console.log(`De: ${liker.name} (${liker.email})`);
                  console.log(`À: ${publicationAuthor.name} (${publicationAuthor.email})`);
                  
                  await sendPushNotificationFunc(publicationAuthor._id, {
                    title: '❤️ Nouveau like',
                    body: `${liker.name} a aimé votre publication`,
                    data: {
                      type: 'like',
                      publicationId: publication._id.toString(),
                      likerName: liker.name,
                      likerAvatar: liker.profileImage || '',
                      deepLink: `${baseUrl}/publications/${publication._id}`
                    }
                  });
                }

                // Email de notification (optionnel pour les likes)
                if (publicationAuthor.email && publicationAuthor.notificationSettings?.emailNotifications !== false && publicationAuthor.notificationSettings?.emailLikes !== false) {
                  console.log(`📧 Envoi email notification pour like`);
                  
                  const publicationPreview = publication.content ? publication.content.substring(0, 100) : '[Publication avec média]';
                  const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                      <style>
                        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background: linear-gradient(135deg, #FF6B6B, #FF8E53); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                        .like-box { background: white; padding: 20px; border-left: 4px solid #FF6B6B; margin: 20px 0; border-radius: 5px; }
                        .button { display: inline-block; padding: 12px 30px; background: #FF6B6B; color: white; text-decoration: none; border-radius: 25px; margin: 20px 0; }
                        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; }
                      </style>
                    </head>
                    <body>
                      <div class="container">
                        <div class="header">
                          <h1>❤️ Nouveau like</h1>
                        </div>
                        <div class="content">
                          <p>Bonjour <strong>${publicationAuthor.name}</strong>,</p>
                          
                          <div class="like-box">
                            <p><strong>${liker.name}</strong> a aimé votre publication !</p>
                          </div>

                          <p><strong>Votre publication :</strong></p>
                          <p style="color: #666; font-style: italic;">"${publicationPreview}${publication.content?.length > 100 ? '...' : ''}"</p>

                          <center>
                            <a href="${baseUrl}/publications/${publication._id}" class="button">Voir la publication</a>
                          </center>

                          <p style="color: #999; font-size: 14px; margin-top: 30px;">
                            Cette notification a été envoyée automatiquement par Center App.
                          </p>
                        </div>
                        <div class="footer">
                          <p>© 2025 Center App. Tous droits réservés.</p>
                          <p>Gérez vos préférences de notification dans l'application</p>
                        </div>
                      </div>
                    </body>
                    </html>
                  `;

                  await sendEmailNotificationFunc(
                    publicationAuthor.email,
                    `❤️ ${liker.name} a aimé votre publication`,
                    emailHtml
                  );
                }
              }
            } else {
              console.log('⚠️ Fonctions de notification non initialisées');
            }
          } catch (notifError) {
            console.error('❌ Erreur notification like (non-bloquante):', notifError);
          }
        })(); // Exécution asynchrone immédiate sans attendre
      }
    }

    await publication.save();

    // Notifier via WebSocket
    if (broadcastToAll) {
      broadcastToAll({
        type: 'publication_liked',
        publicationId: req.params.id,
        userId,
        isLiked,
        likesCount: publication.likes.length
      });
    }

    res.json({
      success: true,
      isLiked,
      likes: publication.likes.length
    });
  } catch (err) {
    console.error('Erreur toggle like:', err);
    res.status(500).json({ 
      message: 'Erreur lors du like',
      error: err.message 
    });
  }
};

module.exports = exports;
