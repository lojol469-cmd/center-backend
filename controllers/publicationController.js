/**
 * Contrôleur pour la gestion des publications
 * Gère toutes les opérations CRUD sur les publications
 */

const Publication = require('../models/Publication');
const { broadcastToAll } = require('../websocket');

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
    broadcastToAll({
      type: 'new_publication',
      publication: populatedPublication
    });

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
    broadcastToAll({
      type: 'publication_deleted',
      publicationId: req.params.id
    });

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
    const publication = await Publication.findById(req.params.id);
    
    if (!publication) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    const userId = req.user.userId;
    const likeIndex = publication.likes.indexOf(userId);

    if (likeIndex > -1) {
      // Retirer le like
      publication.likes.splice(likeIndex, 1);
    } else {
      // Ajouter le like
      publication.likes.push(userId);
    }

    await publication.save();

    // Notifier via WebSocket
    broadcastToAll({
      type: 'publication_liked',
      publicationId: req.params.id,
      userId,
      likesCount: publication.likes.length
    });

    res.json({
      success: true,
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
