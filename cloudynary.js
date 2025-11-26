const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configuration Cloudinary depuis les variables d'environnement
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ========================================
// CONFIGURATION POUR PHOTOS DE PROFIL
// ========================================
const profileStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/profiles',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'],
        transformation: [{ width: 1000, height: 1000, crop: 'limit' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'profile-' + uniqueSuffix;
        }
    }
});

const uploadCloudinary = multer({
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
            'image/webp', 'image/bmp', 'image/svg+xml'
        ];
        
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format image non supporté'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR PUBLICATIONS (Images + Vidéos)
// ========================================
const publicationStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/publications',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'avi', 'mov', 'wmv', 'webm', 'mkv'],
        resource_type: 'auto', // Auto-détecte image ou vidéo
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'pub-' + uniqueSuffix;
        }
    }
});

const publicationUpload = multer({
    storage: publicationStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm', 'video/mkv'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images et vidéos sont autorisées'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR STORIES (Images + Vidéos)
// ========================================
const storyStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/stories',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mkv'],
        resource_type: 'auto',
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'story-' + uniqueSuffix;
        }
    }
});

const storyUpload = multer({
    storage: storyStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/webm', 'video/mkv'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format non autorisé pour les stories'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR COMMENTAIRES (Images + Vidéos + Audio)
// ========================================
const commentStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/comments',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg', 'm4a', 'aac'],
        resource_type: 'auto',
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'comment-' + uniqueSuffix;
        }
    }
});

const commentUpload = multer({
    storage: commentStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm', 'video/mkv',
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/webm', 'audio/aac'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Format de fichier non autorisé'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR MARKERS (Images + Vidéos)
// ========================================
const markerStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/markers',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mkv'],
        resource_type: 'auto',
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'marker-' + uniqueSuffix;
        }
    }
});

const markerUpload = multer({
    storage: markerStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm', 'video/mkv'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images et vidéos sont autorisées'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR EMPLOYÉS (Images + PDF)
// ========================================
const employeeStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/employees',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'],
        resource_type: 'auto',
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'employee-' + uniqueSuffix;
        }
    }
});

const employeeUpload = multer({
    storage: employeeStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf'
        ];
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (allowed.includes(file.mimetype) || ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes('.' + ext)) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images et PDFs sont autorisés'), false);
        }
    }
});

// ========================================
// CONFIGURATION POUR CARTES D'IDENTITÉ VIRTUELLES (Images)
// ========================================
const virtualIDCardStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'center-app/virtual-id-cards',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'],
        resource_type: 'auto',
        transformation: [{ quality: 'auto:good' }],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return 'card-' + uniqueSuffix;
        }
    }
});

const virtualIDCardUpload = multer({
    storage: virtualIDCardStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf'
        ];
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (allowed.includes(file.mimetype) || ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes('.' + ext)) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images et PDFs sont autorisés pour les cartes d\'identité'), false);
        }
    }
});

// ========================================
// FONCTION DE SUPPRESSION
// ========================================
const deleteFromCloudinary = async (publicId) => {
    try {
        const result = await cloudinary.uploader.destroy(publicId);
        console.log('Image supprimée de Cloudinary:', result);
        return result;
    } catch (error) {
        console.error('Erreur lors de la suppression:', error);
        throw error;
    }
};

// Fonction pour obtenir l'URL optimisée d'une image
const getOptimizedUrl = (publicId, options = {}) => {
    return cloudinary.url(publicId, {
        fetch_format: 'auto',
        quality: 'auto',
        ...options
    });
};

// Fonction pour obtenir une URL avec transformation (crop, resize, etc.)
const getTransformedUrl = (publicId, transformations = {}) => {
    return cloudinary.url(publicId, transformations);
};

module.exports = {
    cloudinary,
    uploadCloudinary,
    publicationUpload,
    storyUpload,
    commentUpload,
    markerUpload,
    employeeUpload,
    virtualIDCardUpload,
    deleteFromCloudinary,
    getOptimizedUrl,
    getTransformedUrl
};