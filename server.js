require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');
const { 
  uploadCloudinary, 
  publicationUpload, 
  storyUpload, 
  commentUpload, 
  markerUpload, 
  employeeUpload, 
  deleteFromCloudinary 
} = require('./cloudynary');

// ========================================
// INITIALISATION FIREBASE ADMIN SDK
// ========================================
let firebaseInitialized = false;

try {
  let serviceAccount;
  
  // Option 1: Variable d'environnement JSON (pour Render/Production)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log('📝 Chargement Firebase depuis variable d\'environnement FIREBASE_SERVICE_ACCOUNT');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  // Option 2: Ancienne variable pour compatibilité
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log('📝 Chargement Firebase depuis variable d\'environnement FIREBASE_SERVICE_ACCOUNT_JSON');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } 
  // Option 3: Fichier local (pour développement)
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = path.join(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    
    if (fs.existsSync(serviceAccountPath)) {
      console.log('📝 Chargement Firebase depuis fichier:', serviceAccountPath);
      serviceAccount = require(serviceAccountPath);
    } else {
      console.warn('⚠️ Fichier Firebase non trouvé:', serviceAccountPath);
    }
  } else {
    console.warn('⚠️ Aucune configuration Firebase trouvée (ni FIREBASE_SERVICE_ACCOUNT, ni FIREBASE_SERVICE_ACCOUNT_JSON, ni FIREBASE_SERVICE_ACCOUNT_PATH)');
  }
  
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    
    firebaseInitialized = true;
    console.log('✅ Firebase Admin SDK initialisé');
    console.log(`   Project ID: ${serviceAccount.project_id}`);
  }
} catch (error) {
  console.error('❌ Erreur initialisation Firebase:', error.message);
  console.warn('⚠️ Les notifications push ne fonctionneront pas');
  console.warn('💡 Ajoutez FIREBASE_SERVICE_ACCOUNT_JSON en variable d\'environnement ou placez le fichier JSON');
}

const app = express();

// ========================================
// DÉTECTION AUTOMATIQUE DE L'IP
// ========================================

function getLocalNetworkIP() {
  const interfaces = os.networkInterfaces();
  console.log('\n=== DÉTECTION AUTOMATIQUE DE L\'IP ===');
  console.log('Interfaces réseau disponibles:');
  
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    console.log(`\n${name}:`);
    
    for (const alias of iface) {
      console.log(`  - ${alias.address} (${alias.family}, internal: ${alias.internal})`);
      
      // Rechercher une adresse IPv4 non-interne (non-loopback)
      if (alias.family === 'IPv4' && !alias.internal) {
        // Priorité aux réseaux privés courants
        if (alias.address.startsWith('192.168.') || 
            alias.address.startsWith('10.') || 
            alias.address.startsWith('172.')) {
          console.log(`✅ IP sélectionnée: ${alias.address}`);
          return alias.address;
        }
      }
    }
  }
  
  // Fallback : chercher n'importe quelle IP IPv4 non-interne
  for (const name of Object.keys(interfaces)) {
    for (const alias of interfaces[name]) {
      if (alias.family === 'IPv4' && !alias.internal) {
        console.log(`⚠️ IP de fallback sélectionnée: ${alias.address}`);
        return alias.address;
      }
    }
  }
  
  console.log('❌ Aucune IP réseau trouvée, utilisation de localhost');
  return '127.0.0.1';
}

// Obtenir l'IP automatiquement
const SERVER_IP = getLocalNetworkIP();

// ✅ Détection automatique de l'environnement
// En production (Render), utiliser l'URL Render au lieu de l'IP locale
let BASE_URL;
if (process.env.BASE_URL) {
  // Utiliser l'URL définie dans les variables d'environnement (priorité absolue)
  BASE_URL = process.env.BASE_URL;
  console.log(`🌐 URL de base définie via variable d'environnement: ${BASE_URL}`);
} else if (process.env.NODE_ENV === 'production' && process.env.RENDER) {
  // En production sur Render, utiliser l'URL Render
  BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://center-backend-v9rf.onrender.com';
  console.log(`🌐 Mode PRODUCTION détecté (Render)`);
} else {
  // En développement, utiliser l'IP locale
  BASE_URL = `http://${SERVER_IP}:${process.env.PORT || 5000}`;
  console.log(`🌐 Mode DÉVELOPPEMENT détecté`);
}

console.log(`🌐 URL de base du serveur: ${BASE_URL}`);

// ========================================
// MIDDLEWARE - CORRECTION AUTOMATIQUE DES URLs (SOLUTION INTELLIGENTE)
// ========================================

console.log('\n🔧 Configuration du middleware de correction d\'URLs INTELLIGENTE');
console.log(`📍 IP actuelle du serveur: ${SERVER_IP}`);
console.log(`✅ TOUTES les anciennes IPs réseau seront automatiquement remplacées\n`);

// Middleware pour corriger automatiquement toutes les URLs dans les réponses
app.use((req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    // Fonction récursive pour remplacer les URLs dans un objet
    const replaceUrls = (obj) => {
      if (typeof obj === 'string') {
        let result = obj;
        
        // ✅ NE PAS toucher aux URLs Cloudinary
        if (result.includes('res.cloudinary.com') || result.includes('cloudinary.com')) {
          return result;
        }
        
        // ✅ REGEX INTELLIGENTE : Remplace TOUTES les IPs privées (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
        // Pattern pour détecter n'importe quelle IP dans une URL
        const ipUrlPattern = /http:\/\/((?:192\.168\.\d{1,3}\.\d{1,3})|(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3})|localhost|127\.0\.0\.1)(?::(\d+))?/g;
        
        // Remplacer toutes les URLs avec d'anciennes IPs
        result = result.replace(ipUrlPattern, (match, ip, port) => {
          // Si c'est déjà la bonne IP, ne rien changer
          if (ip === SERVER_IP) {
            return match;
          }
          
          // Sinon, remplacer par la nouvelle IP
          const newPort = port || '5000';
          const newUrl = `http://${SERVER_IP}:${newPort}`;
          
          // Log de la correction (désactiver en production pour performance)
          if (process.env.NODE_ENV !== 'production') {
            console.log(`🔄 Correction URL: ${ip} → ${SERVER_IP}`);
          }
          
          return newUrl;
        });
        
        // Corriger les URLs mal formées (file:///)
        if (result.startsWith('file:///')) {
          result = result.replace(/^file:\/\/\//g, `${BASE_URL}/`);
        }
        
        // ✅ NOUVEAU : Convertir les chemins relatifs uploads/* en URLs complètes
        // Vérifier si c'est un chemin relatif qui commence par 'uploads/'
        if (result.startsWith('uploads/') && !result.startsWith('http://') && !result.startsWith('https://')) {
          result = `${BASE_URL}/${result}`;
          if (process.env.NODE_ENV !== 'production') {
            console.log(`🔄 Conversion chemin relatif: uploads/* → ${BASE_URL}/uploads/*`);
          }
        }
        
        return result;
      } else if (Array.isArray(obj)) {
        return obj.map(item => replaceUrls(item));
      } else if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (const key in obj) {
          newObj[key] = replaceUrls(obj[key]);
        }
        return newObj;
      }
      return obj;
    };
    
    const correctedData = replaceUrls(data);
    return originalJson.call(this, correctedData);
  };
  
  next();
});

// ========================================
// CONFIGURATION GÉNÉRALE
// ========================================

// Configuration CORS pour accepter toutes les origines (production + développement)
app.use(cors({
  origin: '*', // Accepter toutes les origines (Flutter mobile, web, etc.)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Servir les fichiers statiques (uploads) - Backup local uniquement
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ========================================
// CONFIGURATION CLOUDINARY - PRIORITAIRE
// ========================================
// Les uploads utilisent maintenant Cloudinary (voir cloudynary.js)
// uploadCloudinary, publicationUpload, storyUpload, etc. sont déjà importés

// ========================================
// CONNEXION À MONGODB
// ========================================

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connecté'))
  .catch(err => console.error('Erreur MongoDB:', err));

// ========================================
// MODÈLES (SCHÉMAS)
// ========================================

// Modèle Utilisateur
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  password: { type: String, required: true },
  profileImage: { type: String, default: '' },
  cloudinaryPublicId: { type: String, default: '' }, // Pour supprimer l'image de Cloudinary
  isVerified: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'blocked', 'admin'], default: 'active' },
  accessLevel: { type: Number, enum: [0, 1, 2], default: 0 }, // ✅ AJOUTÉ - Niveau d'accès (0: Basique, 1: Chat Utilisateurs, 2: Chat IA)
  aiChatAccess: { type: Boolean, default: false }, // ✅ AJOUTÉ - Accès au chat IA
  messageAccess: { type: Boolean, default: true }, // ✅ AJOUTÉ - Accès à la messagerie
  otp: { type: String },
  otpExpires: { type: Date },
  savedPublications: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Publication' }],
  // Token FCM pour les notifications push
  fcmToken: { type: String, default: '' },
  // Préférences de notifications
  notificationSettings: {
    likes: { type: Boolean, default: true },
    comments: { type: Boolean, default: true },
    followers: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    publications: { type: Boolean, default: true }
  }
});
const User = mongoose.model('User', userSchema);

// Modèle Employé
const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  role: { type: String, default: '' },
  department: { type: String, default: 'IT' },
  faceImage: { type: String, default: '' },
  faceImagePublicId: { type: String },
  certificate: { type: String, default: '' },
  certificatePublicId: { type: String },
  startDate: { type: Date },
  endDate: { type: Date },
  certificateStartDate: { type: Date },
  certificateEndDate: { type: Date },
  status: { type: String, enum: ['online', 'offline', 'away'], default: 'offline' },
  lastSeen: { type: Date, default: Date.now },
  // ✅ AJOUT - Champ location pour géolocalisation
  location: {
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String, default: '' },
    lastUpdate: { type: Date }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Employee = mongoose.model('Employee', employeeSchema);

// Modèle Notification
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['employee_created', 'employee_updated', 'employee_deleted', 'publication', 'message', 'system', 'like', 'comment', 'follower'], required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

// Modèle Message (Chat entre utilisateurs)
const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  media: [{
    type: { type: String, enum: ['image', 'video', 'audio', 'file'], required: true },
    url: { type: String, required: true },
    filename: { type: String, required: true }
  }],
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  // Champs pour les messages de groupe
  isGroupMessage: { type: Boolean, default: false },
  groupId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Modèle Publication
const publicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'article', 'event'], default: 'text' },
  media: [{
    type: { type: String, enum: ['image', 'video'], required: true },
    url: { type: String, required: true },
    filename: { type: String, required: true },
    cloudinaryPublicId: { type: String }
  }],
  location: {
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String },
    placeName: { type: String }
  },
  tags: [{ type: String }],
  category: { type: String },
  visibility: { type: String, enum: ['public', 'friends', 'private'], default: 'public' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String }, // Optionnel si média seulement
    media: [{
      type: { type: String, enum: ['image', 'video', 'audio'], required: true },
      url: { type: String, required: true },
      filename: { type: String, required: true },
      duration: { type: Number }, // Pour audio/vidéo
      cloudinaryPublicId: { type: String }
    }],
    replyTo: { type: mongoose.Schema.Types.ObjectId }, // ID du commentaire parent (pour réponses)
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isEdited: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  }],
  // Statistiques de partage
  shareCount: { type: Number, default: 0 },
  shareVisits: [{
    visitorId: { type: String }, // IP ou fingerprint du visiteur
    visitedAt: { type: Date, default: Date.now },
    isNewUser: { type: Boolean, default: false },
    userAgent: { type: String }
  }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Publication = mongoose.model('Publication', publicationSchema);

// Modèle Marqueur
const markerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  title: { type: String, required: true },
  comment: { type: String, default: '' },
  color: { type: String, default: '#FF0000' },
  photos: [{ 
    url: { type: String },
    cloudinaryPublicId: { type: String }
  }],
  videos: [{ 
    url: { type: String },
    cloudinaryPublicId: { type: String }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Marker = mongoose.model('Marker', markerSchema);

// Modèle Story (Statut/Histoire - expire après 24h)
const storySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, default: '' }, // Texte de la story
  mediaUrl: { type: String, default: '' }, // URL de l'image/vidéo (Cloudinary)
  cloudinaryPublicId: { type: String, default: '' }, // Public ID Cloudinary pour suppression
  mediaType: { type: String, enum: ['image', 'video', 'text'], default: 'text' },
  backgroundColor: { type: String, default: '#00D4FF' }, // Couleur de fond pour stories texte
  duration: { type: Number, default: 5 }, // Durée d'affichage en secondes
  expiresAt: { type: Date, required: true }, // Date d'expiration (24h après création)
  viewedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Liste des utilisateurs qui ont vu
  views: [{ // Vues détaillées avec timestamps
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    viewedAt: { type: Date, default: Date.now }
  }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Index pour supprimer automatiquement les stories expirées
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Story = mongoose.model('Story', storySchema);

// ========================================
// MODÈLE : CARTE D'IDENTITÉ VIRTUELLE (BIOMÉTRIQUE)
// ========================================

const virtualIDCardSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  cardData: {
    firstName: { type: String, required: true },
    lastName: { type: String, default: '' }, // Optionnel
    dateOfBirth: { type: Date, required: true },
    placeOfBirth: { type: String, required: true },
    nationality: { type: String, required: true },
    address: { type: String, required: true },
    idNumber: { type: String, required: true, unique: true },
    issueDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    gender: { type: String, enum: ['M', 'F'], required: true },
    bloodType: { type: String, enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
    height: { type: Number }, // en cm
    profession: { type: String },
    maritalStatus: { type: String, enum: ['single', 'married', 'divorced', 'widowed'] },
    phoneNumber: { type: String },
    emergencyContact: {
      name: { type: String },
      phone: { type: String },
      relationship: { type: String }
    }
  },
  biometricData: {
    fingerprintHash: { type: String }, // Hash de l'empreinte digitale
    faceData: { type: String }, // Données de reconnaissance faciale (encodées)
    irisData: { type: String }, // Données iris (optionnel)
    voiceData: { type: String }, // Données vocales (optionnel)
    lastBiometricUpdate: { type: Date, default: Date.now }
  },
  cardImage: {
    frontImage: { type: String }, // URL Cloudinary de l'image avant
    backImage: { type: String }, // URL Cloudinary de l'image arrière
    frontImagePublicId: { type: String },
    backImagePublicId: { type: String }
  },
  securityFeatures: {
    qrCode: { type: String }, // Données pour QR code
    barcode: { type: String }, // Données pour code-barres
    hologramData: { type: String }, // Données d'hologramme
    chipData: { type: String } // Données de puce électronique simulée
  },
  authenticationTokens: [{
    token: { type: String, required: true },
    deviceId: { type: String },
    biometricType: { type: String, enum: ['fingerprint', 'face', 'iris', 'voice'] },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true }
  }],
  isActive: { type: Boolean, default: true },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  verificationNotes: { type: String },
  lastUsed: { type: Date },
  usageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index pour optimiser les recherches
// Note: Les index pour userId et cardData.idNumber sont déjà créés automatiquement par unique: true
virtualIDCardSchema.index({ 'authenticationTokens.token': 1 });
virtualIDCardSchema.index({ 'authenticationTokens.expiresAt': 1 });

const VirtualIDCard = mongoose.model('VirtualIDCard', virtualIDCardSchema);

// ========================================
// UPLOADS CLOUDINARY - Déjà importés
// ========================================
// uploadCloudinary, publicationUpload, storyUpload, commentUpload, 
// markerUpload, employeeUpload, deleteFromCloudinary
// sont tous disponibles via cloudynary.js

// ========================================
// CONFIGURATION EMAIL (NODEMAILER)
// ========================================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// ========================================
// MIDDLEWARE POUR CORRIGER LES URLs
// ========================================

// Middleware pour remplacer automatiquement les anciennes IPs/URLs invalides
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  
  res.json = function(data) {
    if (data) {
      try {
        const dataString = JSON.stringify(data);
        // Remplacer toutes les anciennes URLs par la nouvelle BASE_URL actuelle
        const fixedData = dataString
          .replace(/file:\/\/\//g, `${BASE_URL}/`)
          .replace(/http:\/\/192\.168\.1\.98:5000/g, BASE_URL)
          .replace(/http:\/\/192\.168\.43\.1:5000/g, BASE_URL)
          .replace(/http:\/\/10\.0\.2\.2:5000/g, BASE_URL)
          .replace(/http:\/\/localhost:5000/g, BASE_URL)
          .replace(/http:\/\/127\.0\.0\.1:5000/g, BASE_URL);
        
        return originalJson(JSON.parse(fixedData));
      } catch (e) {
        console.error('❌ Erreur correction URLs:', e);
        return originalJson(data);
      }
    }
    return originalJson(data);
  };
  
  next();
});

// ========================================
// MIDDLEWARES DE SÉCURITÉ
// ========================================

const verifyToken = (req, res, next) => {
  console.log('\n=== VÉRIFICATION TOKEN ===');
  console.log('URL:', req.method, req.originalUrl);
  console.log('Headers Authorization:', req.headers['authorization']);
  
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    console.log('❌ Erreur: Header Authorization manquant');
    return res.status(401).json({ message: 'Token manquant - Header Authorization requis' });
  }

  const token = authHeader.split(' ')[1];
  if (!token || token === 'null') {
    console.log('❌ Erreur: Token manquant après "Bearer" ou égal à "null"');
    return res.status(401).json({ message: 'Token manquant ou invalide - Format: Bearer <token>' });
  }

  console.log('Token reçu (premiers 20 caractères):', token.substring(0, 20) + '...');
  console.log('JWT_SECRET défini:', !!process.env.JWT_SECRET);

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) {
      console.log('❌ Erreur JWT:', err.message);
      console.log('Type erreur:', err.name);
      if (err.name === 'TokenExpiredError') {
        return res.status(403).json({ message: 'Token expiré', expired: true });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(403).json({ message: 'Token invalide - ' + err.message });
      }
      return res.status(403).json({ message: 'Token invalide' });
    }
    
    console.log('✅ Token valide pour userId:', user.userId, 'email:', user.email);
    
    // Vérifier le statut de l'utilisateur
    try {
      const dbUser = await User.findById(user.userId);
      if (!dbUser) {
        console.log('❌ Utilisateur non trouvé en base');
        return res.status(401).json({ message: 'Utilisateur non trouvé' });
      }
      
      if (dbUser.status === 'blocked') {
        console.log('❌ Utilisateur bloqué:', user.email);
        return res.status(403).json({ message: 'Accès refusé - Compte désactivé' });
      }
      
      console.log('✅ Statut utilisateur valide:', dbUser.status);
      req.user = user;
      next();
    } catch (dbErr) {
      console.log('❌ Erreur vérification statut utilisateur:', dbErr.message);
      return res.status(500).json({ message: 'Erreur serveur' });
    }
  });
};

const verifyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || user.status !== 'admin') {
      return res.status(403).json({ message: 'Accès refusé. Droits admin requis.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
};

const verifyCanCreateEmployees = async (req, res, next) => {
  const user = await User.findById(req.user.userId);
  const allowed = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'];
  if (!user || !allowed.includes(user.email.toLowerCase())) {
    return res.status(403).json({ message: 'Seul l\'admin principal peut créer des employés' });
  }
  next();
};

const verifyCanManageUsers = async (req, res, next) => {
  const user = await User.findById(req.user.userId);
  const allowed = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'];
  if (!user || !allowed.includes(user.email.toLowerCase())) {
    return res.status(403).json({ message: 'Seul l\'admin principal peut gérer les utilisateurs' });
  }
  next();
};

// ========================================
// ROUTES : AUTHENTIFICATION
// ========================================

// Inscription + OTP
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ message: 'Mot de passe trop court' });

  try {
    if (await User.findOne({ email })) return res.status(400).json({ message: 'Utilisateur déjà existant' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOTP();
    const otpExpires = Date.now() + 10 * 60 * 1000;

    const user = new User({ email, password: hashedPassword, name: name || '', otp, otpExpires });
    await user.save();

    await transporter.sendMail({
      from: `"Auth System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Code de vérification',
      html: `<h2>Bienvenue !</h2><p>Votre code OTP : <strong>${otp}</strong></p><p>Valable 10 minutes.</p>`
    });

    res.json({ message: 'OTP envoyé à votre email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Connexion + OTP
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ message: 'Utilisateur non trouvé' });

  const otp = generateOTP();
  user.otp = otp;
  user.otpExpires = Date.now() + 10 * 60 * 1000;
  await user.save();

  await transporter.sendMail({
    from: `"Auth System" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Code OTP',
    html: `<h2>Connexion</h2><p>Votre code : <strong>${otp}</strong></p>`
  });

  res.json({ message: 'OTP envoyé' });
});

// Vérification OTP + JWT
app.post('/api/auth/verify-otp', async (req, res) => {
  console.log('\n=== VÉRIFICATION OTP ===');
  const { email, otp } = req.body;
  console.log('Email:', email);
  console.log('OTP reçu:', otp);
  
  const user = await User.findOne({ email });
  if (!user) {
    console.log('❌ Utilisateur non trouvé');
    return res.status(400).json({ message: 'Utilisateur non trouvé' });
  }

  // Vérifier le statut de l'utilisateur
  if (user.status === 'blocked') {
    console.log('❌ Utilisateur bloqué:', email);
    return res.status(403).json({ message: 'Accès refusé - Compte désactivé' });
  }

  console.log('OTP stocké:', user.otp);
  console.log('OTP expire à:', user.otpExpires);
  console.log('Date actuelle:', new Date());
  console.log('OTP expiré?', Date.now() > user.otpExpires);

  if (!user || user.otp !== otp || Date.now() > user.otpExpires) {
    console.log('❌ OTP invalide ou expiré');
    return res.status(400).json({ message: 'OTP invalide ou expiré' });
  }

  console.log('✅ OTP valide, génération des tokens...');
  console.log('JWT_SECRET:', process.env.JWT_SECRET ? 'Défini (longueur: ' + process.env.JWT_SECRET.length + ')' : 'NON DÉFINI!');
  console.log('JWT_REFRESH_SECRET:', process.env.JWT_REFRESH_SECRET ? 'Défini' : 'NON DÉFINI!');

  // Token valide pendant 7 jours au lieu de 15 minutes
  const accessToken = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const refreshToken = jwt.sign({ userId: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

  console.log('Access Token généré (premiers 30 car):', accessToken.substring(0, 30) + '...');
  console.log('Refresh Token généré (premiers 30 car):', refreshToken.substring(0, 30) + '...');

  user.otp = undefined;
  user.otpExpires = undefined;
  user.isVerified = true;
  await user.save();

  console.log('✅ Utilisateur sauvegardé, tokens envoyés');

  res.json({
    message: 'Connexion réussie',
    accessToken,
    refreshToken,
    user: { 
      _id: user._id.toString(),
      email: user.email, 
      name: user.name, 
      profileImage: user.profileImage, 
      status: user.status 
    }
  });
});

// Rafraîchir le token
app.post('/api/auth/refresh-token', (req, res) => {
  console.log('\n=== RAFRAÎCHISSEMENT TOKEN ===');
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    console.log('❌ Refresh token manquant');
    return res.status(401).json({ message: 'Refresh token requis' });
  }

  console.log('Refresh token reçu (premiers 30 car):', refreshToken.substring(0, 30) + '...');

  jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, async (err, decoded) => {
    if (err) {
      console.log('❌ Erreur vérification refresh token:', err.message);
      return res.status(403).json({ message: 'Refresh token invalide' });
    }
    
    console.log('✅ Refresh token valide, userId:', decoded.userId);
    
    const user = await User.findById(decoded.userId);
    if (!user) {
      console.log('❌ Utilisateur non trouvé');
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    // Vérifier le statut de l'utilisateur
    if (user.status === 'blocked') {
      console.log('❌ Utilisateur bloqué:', user.email);
      return res.status(403).json({ message: 'Accès refusé - Compte désactivé' });
    }

    // Token valide pendant 7 jours
    const newAccessToken = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log('✅ Nouveau access token généré (premiers 30 car):', newAccessToken.substring(0, 30) + '...');
    
    res.json({ accessToken: newAccessToken });
  });
});

// Vérifier l'existence d'une carte d'identité
app.post('/api/auth/verify-id-card', async (req, res) => {
  console.log('\n=== VÉRIFICATION CARTE D\'IDENTITÉ ===');
  const { idCard } = req.body;
  console.log('ID Carte reçu:', idCard);
  
  try {
    // Chercher dans la collection VirtualIDCard
    const virtualCard = await VirtualIDCard.findOne({ 'cardData.idNumber': idCard });
    
    if (!virtualCard) {
      console.log('❌ Carte d\'identité non trouvée');
      return res.status(404).json({ 
        success: false, 
        exists: false,
        message: 'Carte d\'identité non trouvée' 
      });
    }

    console.log('✅ Carte d\'identité trouvée:', virtualCard.cardData.email);
    
    // Vérifier si un utilisateur existe déjà avec cet email
    const existingUser = await User.findOne({ email: virtualCard.cardData.email });
    
    if (existingUser) {
      console.log('⚠️ Un compte existe déjà avec cet email');
      return res.status(400).json({ 
        success: false, 
        exists: true,
        message: 'Un compte existe déjà avec cet email. Veuillez vous connecter.' 
      });
    }

    res.json({ 
      success: true, 
      exists: true,
      user: {
        email: virtualCard.cardData.email,
        name: virtualCard.cardData.firstName + ' ' + virtualCard.cardData.lastName,
        idCard: virtualCard.cardData.idNumber
      }
    });
  } catch (error) {
    console.error('❌ Erreur vérification carte:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de la vérification' 
    });
  }
});// Inscription avec Face ID et carte d'identité
app.post('/api/auth/register-faceid', async (req, res) => {
  console.log('\n=== INSCRIPTION FACE ID ===');
  const { email, name, idCard } = req.body;
  console.log('Email:', email);
  console.log('Name:', name);
  console.log('ID Carte:', idCard);

  try {
    // Vérifier que la carte existe
    const virtualCard = await VirtualIDCard.findOne({ 'cardData.idNumber': idCard });
    
    if (!virtualCard) {
      console.log('❌ Carte d\'identité non trouvée');
      return res.status(404).json({ 
        success: false,
        message: 'Carte d\'identité non trouvée' 
      });
    }

    // Vérifier que l'email correspond
    if (virtualCard.cardData.email !== email) {
      console.log('❌ Email ne correspond pas à la carte');
      return res.status(400).json({ 
        success: false,
        message: 'Email ne correspond pas à la carte d\'identité' 
      });
    }

    // Vérifier si l'utilisateur existe déjà
    let user = await User.findOne({ email });
    
    if (user) {
      console.log('⚠️ Utilisateur existe déjà');
      return res.status(400).json({ 
        success: false,
        message: 'Un compte existe déjà avec cet email' 
      });
    }

    // Créer un nouveau compte avec un mot de passe temporaire (sera changé lors de la première connexion)
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
    // Générer OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    user = new User({
      email,
      name,
      password: hashedPassword,
      otp,
      otpExpires: Date.now() + 10 * 60 * 1000, // 10 minutes
      isVerified: false,
      profileImage: virtualCard.cardImage?.frontImage || null,
      role: 'user',
      status: 'active'
    });

    await user.save();
    console.log('✅ Utilisateur créé avec Face ID');

    // Envoyer OTP par email
    await transporter.sendMail({
      from: `"Auth System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Code OTP - Inscription Face ID',
      text: `Votre code OTP pour finaliser votre inscription avec Face ID est: ${otp}. Il expire dans 10 minutes.`,
    });

    console.log('✅ OTP envoyé à:', email);

    res.status(201).json({ 
      success: true,
      message: `Code OTP envoyé à ${email}`,
      requiresOtp: true
    });
  } catch (error) {
    console.error('❌ Erreur inscription Face ID:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de l\'inscription' 
    });
  }
});

// Connexion automatique avec carte virtuelle (lorsque la carte est trouvée par email)
app.post('/api/auth/login-virtual-card', async (req, res) => {
  console.log('\n=== CONNEXION AUTOMATIQUE AVEC CARTE VIRTUELLE ===');
  const { cardId } = req.body;
  console.log('Card ID:', cardId);

  try {
    // Chercher la carte virtuelle par ID
    const virtualCard = await VirtualIDCard.findOne({
      'cardData.idNumber': cardId,
      isActive: true,
      verificationStatus: 'verified'
    });

    if (!virtualCard) {
      console.log('❌ Aucune carte virtuelle active trouvée pour cet ID');
      return res.status(404).json({
        success: false,
        message: 'Carte d\'identité virtuelle non trouvée ou inactive'
      });
    }

    // Récupérer l'utilisateur associé
    const user = await User.findById(virtualCard.userId);

    if (!user) {
      console.log('❌ Utilisateur associé non trouvé');
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Vérifier le statut de l'utilisateur
    if (user.status === 'blocked') {
      console.log('❌ Utilisateur bloqué');
      return res.status(403).json({
        success: false,
        message: 'Accès refusé - Compte désactivé'
      });
    }

    // Générer les tokens (connexion automatique réussie)
    const accessToken = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const refreshToken = jwt.sign({ userId: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    // Mettre à jour la dernière utilisation de la carte
    virtualCard.lastUsed = new Date();
    virtualCard.usageCount += 1;
    await virtualCard.save();

    console.log('✅ Connexion automatique réussie pour:', user.email);

    res.json({
      success: true,
      message: 'Connexion automatique réussie',
      accessToken,
      refreshToken,
      user: {
        _id: user._id.toString(),
        email: user.email,
        name: user.name,
        profileImage: user.profileImage,
        status: user.status
      }
    });
  } catch (error) {
    console.error('❌ Erreur connexion automatique:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la connexion automatique'
    });
  }
});

// Route de login direct pour les tests (sans OTP)
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(400).json({ message: 'Utilisateur non trouvé' });
    }

    // Vérifier le statut de l'utilisateur
    if (user.status === 'blocked') {
      console.log('❌ Utilisateur bloqué:', email);
      return res.status(403).json({ message: 'Accès refusé - Compte désactivé' });
    }

    // Vérifier le mot de passe avec bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Mot de passe incorrect' });
    }

    // Générer les tokens - valides pendant 7 jours
    const accessToken = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const refreshToken = jwt.sign({ userId: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

    res.json({
      message: 'Connexion réussie',
      accessToken,
      refreshToken,
      user: { 
        _id: user._id.toString(),
        email: user.email, 
        name: user.name, 
        profileImage: user.profileImage, 
        status: user.status 
      }
    });
  } catch (error) {
    console.error('Erreur admin-login:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ========================================
// ROUTES : NOTIFICATIONS PUSH
// ========================================

// Mettre à jour le token FCM de l'utilisateur
app.post('/api/users/fcm-token', verifyToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    
    if (!fcmToken) {
      return res.status(400).json({ 
        success: false,
        message: 'Token FCM requis' 
      });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'Utilisateur non trouvé' 
      });
    }

    user.fcmToken = fcmToken;
    await user.save();

    console.log(`✅ Token FCM mis à jour pour ${user.email}`);
    res.json({ 
      success: true,
      message: 'Token FCM mis à jour' 
    });
  } catch (error) {
    console.error('❌ Erreur mise à jour token FCM:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Fonction helper pour envoyer une notification push
async function sendPushNotification(userId, notification) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      console.log(`⚠️ Utilisateur ${userId} non trouvé`);
      return { success: false, error: 'User not found' };
    }

    // Créer la notification en base de données
    const notifDoc = new Notification({
      userId: userId,
      type: notification.data?.type || 'system',
      title: notification.title,
      message: notification.body,
      data: notification.data || {},
      read: false
    });
    await notifDoc.save();
    console.log(`✅ Notification enregistrée en DB pour user ${userId}`);

    // Compter les notifications non lues
    const unreadCount = await Notification.countDocuments({
      userId: userId,
      read: false
    });

    // Envoyer via WebSocket le nouveau compteur
    if (typeof broadcastToUser === 'function') {
      broadcastToUser(userId.toString(), {
        type: 'notification_update',
        unreadCount: unreadCount,
        notification: {
          id: notifDoc._id.toString(),
          type: notifDoc.type,
          title: notifDoc.title,
          message: notifDoc.message,
          data: notifDoc.data,
          createdAt: notifDoc.createdAt
        }
      });
    }

    // Envoyer la notification push via Firebase Cloud Messaging
    if (firebaseInitialized && user.fcmToken) {
      try {
        const message = {
          token: user.fcmToken,
          notification: {
            title: notification.title,
            body: notification.body
          },
          data: {
            ...notification.data,
            notificationId: notifDoc._id.toString(),
            timestamp: new Date().toISOString(),
            unreadCount: unreadCount.toString()
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'center_notifications',
              priority: 'high',
              defaultSound: true,
              defaultVibrateTimings: true,
              tag: notifDoc.type // Grouper les notifications par type
            }
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: unreadCount, // Badge avec le nombre exact
                contentAvailable: true
              }
            }
          }
        };

        const response = await admin.messaging().send(message);
        console.log(`✅ Notification push envoyée via FCM:`, response);
        console.log(`   User: ${user.email || userId}`);
        console.log(`   Title: ${notification.title}`);
        console.log(`   Badge: ${unreadCount}`);
        
        return { success: true, messageId: response, unreadCount };
      } catch (fcmError) {
        // Gérer les erreurs spécifiques FCM
        if (fcmError.code === 'messaging/invalid-registration-token' || 
            fcmError.code === 'messaging/registration-token-not-registered') {
          console.log(`⚠️ Token FCM invalide pour ${user.email}, suppression du token`);
          user.fcmToken = '';
          await user.save();
        } else {
          console.error('❌ Erreur FCM:', fcmError.message);
        }
        return { success: false, error: fcmError, dbSaved: true, unreadCount };
      }
    } else {
      if (!firebaseInitialized) {
        console.log('⚠️ Firebase non initialisé, notification enregistrée en DB uniquement');
      } else if (!user.fcmToken) {
        console.log(`⚠️ Pas de token FCM pour user ${user.email || userId}`);
      }
      return { success: true, dbOnly: true, unreadCount };
    }
  } catch (error) {
    console.error('❌ Erreur envoi notification:', error);
    return { success: false, error };
  }
}

// Envoyer un email de notification
async function sendEmailNotification(userEmail, subject, htmlContent) {
  try {
    if (!userEmail) {
      console.log('⚠️ Pas d\'email fourni');
      return { success: false };
    }

    const mailOptions = {
      from: process.env.EMAIL_USER || 'noreply@center.app',
      to: userEmail,
      subject: subject,
      html: htmlContent
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Email envoyé à ${userEmail}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Erreur envoi email:', error);
    return { success: false, error };
  }
}

// Initialiser les fonctions de notification et les modèles dans le controller
const publicationController = require('./controllers/publicationController');
const virtualIDCardController = require('./controllers/virtualIDCardController');
publicationController.initModels(Publication, User, Notification, VirtualIDCard);
publicationController.initNotifications(sendPushNotification, sendEmailNotification, BASE_URL);
publicationController.initWebSocket(broadcastToAll);

// Initialiser le contrôleur de cartes d'identité virtuelles
virtualIDCardController.initModels(VirtualIDCard, User);

// Envoyer une notification à un utilisateur
app.post('/api/notifications/send', verifyToken, async (req, res) => {
  try {
    const { userId, title, body, type, data } = req.body;
    
    if (!userId || !title || !body) {
      return res.status(400).json({ 
        success: false,
        message: 'Données manquantes' 
      });
    }

    // Créer la notification en base
    const notification = new Notification({
      userId,
      type: type || 'system',
      title,
      message: body,
      data,
      read: false
    });
    await notification.save();

    // Envoyer la push notification
    await sendPushNotification(userId, {
      title,
      body,
      data: { ...data, type, notificationId: notification._id.toString() }
    });

    res.json({ 
      success: true,
      message: 'Notification envoyée',
      notification 
    });
  } catch (error) {
    console.error('❌ Erreur envoi notification:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Récupérer les notifications de l'utilisateur
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const notifications = await Notification.find({ 
      userId: req.user.userId 
    })
    .sort({ createdAt: -1 })
    .limit(50);

    const unreadCount = await Notification.countDocuments({
      userId: req.user.userId,
      read: false
    });

    res.json({ 
      success: true,
      notifications,
      unreadCount
    });
  } catch (error) {
    console.error('❌ Erreur récupération notifications:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Marquer une notification comme lue
app.put('/api/notifications/:id/read', verifyToken, async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user.userId
    });

    if (!notification) {
      return res.status(404).json({ 
        success: false,
        message: 'Notification non trouvée' 
      });
    }

    notification.read = true;
    await notification.save();

    // Compter les notifications non lues restantes
    const unreadCount = await Notification.countDocuments({
      userId: req.user.userId,
      read: false
    });

    // Mettre à jour le badge via WebSocket
    if (typeof broadcastToUser === 'function') {
      broadcastToUser(req.user.userId, {
        type: 'notification_read',
        unreadCount: unreadCount,
        notificationId: req.params.id
      });
    }

    res.json({ 
      success: true,
      notification,
      unreadCount
    });
  } catch (error) {
    console.error('❌ Erreur mise à jour notification:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// ========================================
// ROUTES MESSAGERIE
// ========================================

// Envoyer un message
app.post('/api/messages/send', verifyToken, async (req, res) => {
  try {
    const { receiverId, content } = req.body;

    if (!receiverId || !content?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: 'Destinataire et contenu requis' 
      });
    }

    // Vérifier que le destinataire existe
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ 
        success: false,
        message: 'Destinataire non trouvé' 
      });
    }

    // Créer le message
    const message = new Message({
      senderId: req.user.userId,
      receiverId,
      content: content.trim(),
      isRead: false
    });

    await message.save();
    await message.populate('senderId', 'name profileImage');
    await message.populate('receiverId', 'name profileImage');

    // Envoyer une notification push au destinataire
    const sender = await User.findById(req.user.userId).select('name');
    await sendPushNotification(receiverId, {
      title: `💬 Message de ${sender.name}`,
      body: content.trim().substring(0, 100),
      data: {
        type: 'message',
        senderId: req.user.userId,
        messageId: message._id.toString()
      }
    });

    // Envoyer un email au destinataire
    if (receiver.email) {
      await sendEmailNotification(
        receiver.email,
        `💬 Nouveau message de ${sender.name}`,
        `<p>Vous avez reçu un nouveau message de <strong>${sender.name}</strong>:</p>
         <blockquote style="border-left: 3px solid #00FF88; padding-left: 15px; margin: 15px 0;">
           ${content.trim().substring(0, 200)}${content.length > 200 ? '...' : ''}
         </blockquote>
         <p>Connectez-vous à l'application pour répondre.</p>`
      );
    }

    console.log(`📨 Message envoyé de ${req.user.userId} à ${receiverId}`);

    res.json({ 
      success: true,
      message: message.toObject()
    });
  } catch (error) {
    console.error('❌ Erreur envoi message:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Récupérer la liste des utilisateurs pour la messagerie (accessible à tous les utilisateurs authentifiés)
app.get('/api/messages/users', verifyToken, async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION UTILISATEURS POUR MESSAGERIE ===');
    console.log('User ID:', req.user.userId);

    // Récupérer tous les utilisateurs actifs et admins (sauf l'utilisateur actuel)
    const users = await User.find({
      _id: { $ne: req.user.userId }, // Exclure l'utilisateur actuel
      status: { $in: ['active', 'admin'] }
    })
    .select('name email profileImage status')
    .sort({ name: 1 });

    const usersData = users.map(user => ({
      _id: user._id,
      name: user.name || user.email.split('@')[0], // Utiliser le nom ou la partie avant @ de l'email
      email: user.email,
      profileImage: user.profileImage,
      status: user.status
    }));

    console.log(`✅ ${usersData.length} utilisateurs trouvés pour la messagerie`);

    res.json({ 
      success: true,
      users: usersData 
    });
  } catch (error) {
    console.error('❌ Erreur récupération utilisateurs messagerie:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Récupérer les conversations (liste des personnes avec qui on a échangé)
app.get('/api/messages/conversations', verifyToken, async (req, res) => {
  try {
    // Récupérer tous les messages envoyés ou reçus par l'utilisateur
    const messages = await Message.find({
      $or: [
        { senderId: req.user.userId },
        { receiverId: req.user.userId }
      ]
    })
    .populate('senderId', 'name profileImage')
    .populate('receiverId', 'name profileImage')
    .sort({ createdAt: -1 });

    // Grouper par conversation (utilisateur unique)
    const conversationsMap = new Map();

    for (const msg of messages) {
      const otherUserId = msg.senderId._id.toString() === req.user.userId 
        ? msg.receiverId._id.toString() 
        : msg.senderId._id.toString();

      if (!conversationsMap.has(otherUserId)) {
        const otherUser = msg.senderId._id.toString() === req.user.userId 
          ? msg.receiverId 
          : msg.senderId;

        // Compter les messages non lus de cet utilisateur
        const unreadCount = await Message.countDocuments({
          senderId: otherUserId,
          receiverId: req.user.userId,
          isRead: false
        });

        conversationsMap.set(otherUserId, {
          userId: otherUserId,
          userName: otherUser.name,
          userImage: otherUser.profileImage,
          lastMessage: msg.content,
          lastMessageTime: msg.createdAt,
          unreadCount
        });
      }
    }

    const conversations = Array.from(conversationsMap.values());
    conversations.sort((a, b) => b.lastMessageTime - a.lastMessageTime);

    res.json({ 
      success: true,
      conversations 
    });
  } catch (error) {
    console.error('❌ Erreur récupération conversations:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Récupérer les messages d'une conversation
app.get('/api/messages/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const page = +req.query.page || 1;
    const limit = +req.query.limit || 50;
    const skip = (page - 1) * limit;

    const messages = await Message.find({
      $or: [
        { senderId: req.user.userId, receiverId: userId },
        { senderId: userId, receiverId: req.user.userId }
      ]
    })
    .populate('senderId', 'name profileImage')
    .populate('receiverId', 'name profileImage')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

    const total = await Message.countDocuments({
      $or: [
        { senderId: req.user.userId, receiverId: userId },
        { senderId: userId, receiverId: req.user.userId }
      ]
    });

    // Marquer les messages de l'autre utilisateur comme lus
    await Message.updateMany(
      {
        senderId: userId,
        receiverId: req.user.userId,
        isRead: false
      },
      {
        $set: { isRead: true, readAt: new Date() }
      }
    );

    res.json({ 
      success: true,
      messages: messages.reverse(), // Ordre chronologique
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    console.error('❌ Erreur récupération messages:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Marquer un message comme lu
app.put('/api/messages/:id/read', verifyToken, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      receiverId: req.user.userId
    });

    if (!message) {
      return res.status(404).json({ 
        success: false,
        message: 'Message non trouvé' 
      });
    }

    message.isRead = true;
    message.readAt = new Date();
    await message.save();

    res.json({ 
      success: true,
      message 
    });
  } catch (error) {
    console.error('❌ Erreur mise à jour message:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Supprimer un message
app.delete('/api/messages/:id', verifyToken, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      $or: [
        { senderId: req.user.userId },
        { receiverId: req.user.userId }
      ]
    });

    if (!message) {
      return res.status(404).json({ 
        success: false,
        message: 'Message non trouvé' 
      });
    }

    await message.deleteOne();

    res.json({ 
      success: true,
      message: 'Message supprimé' 
    });
  } catch (error) {
    console.error('❌ Erreur suppression message:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// ========================================
// ROUTES : PROFIL UTILISATEUR
// ========================================

// =======================
// GESTION UTILISATEUR
// =======================

// Récupérer le profil utilisateur
app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    res.json({ user: user.toObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.put('/api/user/update-name', verifyToken, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Nom requis' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    user.name = name.trim();
    await user.save();

    res.json({ 
      message: 'Nom mis à jour', 
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.put('/api/user/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Mot de passe trop court' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ message: 'Mot de passe actuel incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    const userWithUrl = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImage: user.profileImage,
      createdAt: user.createdAt
    };

    res.json({ 
      message: 'Mot de passe changé',
      user: userWithUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.post('/api/user/upload-profile-image', verifyToken, uploadCloudinary.single('profileImage'), async (req, res) => {
  console.log('\n=== UPLOAD PROFILE IMAGE (Cloudinary) ===');
  console.log('File:', req.file);
  console.log('User ID:', req.user?.userId);
  
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    if (!req.file) return res.status(400).json({ message: 'Image requise' });

    // Supprimer l'ancienne image de Cloudinary si elle existe
    if (user.profileImage && user.cloudinaryPublicId) {
      try {
        await deleteFromCloudinary(user.cloudinaryPublicId);
      } catch (err) {
        console.log('⚠️ Impossible de supprimer l\'ancienne image:', err.message);
      }
    }

    // Enregistrer la nouvelle URL Cloudinary
    user.profileImage = req.file.path; // URL Cloudinary
    user.cloudinaryPublicId = req.file.filename; // Public ID pour suppression future
    await user.save();

    const userWithUrl = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImage: user.profileImage,
      createdAt: user.createdAt
    };

    console.log('✅ Photo mise à jour (Cloudinary):', userWithUrl.profileImage);
    res.json({
      message: 'Photo mise à jour',
      user: userWithUrl
    });
  } catch (err) {
    console.error('❌ Erreur upload:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.delete('/api/user/delete-profile-image', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    if (user.cloudinaryPublicId) {
      try {
        await deleteFromCloudinary(user.cloudinaryPublicId);
        console.log('✅ Photo de profil supprimée de Cloudinary:', user.cloudinaryPublicId);
      } catch (err) {
        console.log('⚠️ Erreur suppression photo:', err.message);
      }
      user.profileImage = '';
      user.cloudinaryPublicId = undefined;
      await user.save();
    }

    const userWithUrl = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImage: '',
      createdAt: user.createdAt
    };

    res.json({ 
      message: 'Photo supprimée',
      user: userWithUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.delete('/api/user/delete-account', verifyToken, async (req, res) => {
  await User.findByIdAndDelete(req.user.userId);
  res.json({ message: 'Compte supprimé' });
});

// ========================================
// ROUTES : PUBLICATIONS
// ========================================

app.post('/api/publications', verifyToken, publicationUpload.array('media', 10), async (req, res) => {
  console.log('\n=== CRÉATION PUBLICATION ===');
  console.log('User ID:', req.user.userId);
  console.log('Content:', req.body.content?.substring(0, 50) + '...');
  console.log('Type:', req.body.type);
  console.log('Fichiers uploadés:', req.files?.length || 0);
  
  const { content, type, latitude, longitude, address, placeName, tags, category, visibility } = req.body;
  if (!content?.trim()) {
    console.log('❌ Contenu manquant');
    return res.status(400).json({ message: 'Contenu requis' });
  }

  const media = req.files?.map(file => ({
    type: file.mimetype.startsWith('image/') ? 'image' : 'video',
    url: file.path,
    filename: file.filename,
    cloudinaryPublicId: file.filename
  })) || [];

  const location = latitude && longitude ? { latitude: +latitude, longitude: +longitude, address, placeName } : undefined;
  const tagsArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

  console.log('Médias (Cloudinary):', media.length);
  console.log('Localisation:', location ? 'Oui' : 'Non');
  console.log('Tags:', tagsArray.length);

  const pub = new Publication({
    userId: req.user.userId,
    content: content.trim(),
    type: type || 'text',
    media,
    location,
    tags: tagsArray,
    category,
    visibility: visibility || 'public'
  });

  await pub.save();
  await pub.populate('userId', 'name email profileImage');

  console.log('✅ Publication créée (Cloudinary), ID:', pub._id);
  
  const pubObj = pub.toObject();
  
  // Diffuser la nouvelle publication via WebSocket
  broadcastToAll({
    type: 'new_publication',
    publication: pubObj
  });
  
  res.status(201).json({ message: 'Publication créée', publication: pubObj });
});

// ✅ ROUTE - Récupérer MES publications uniquement
app.get('/api/publications/my', verifyToken, async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION MES PUBLICATIONS ===');
    console.log('User ID:', req.user.userId);
    const page = +req.query.page || 1;
    const limit = +req.query.limit || 20;
    const skip = (page - 1) * limit;
    console.log('Page:', page, 'Limit:', limit);

    const publications = await Publication.find({ 
      isActive: true,
      userId: req.user.userId  // UNIQUEMENT mes publications
    })
      .populate('userId', 'name email profileImage')
      .populate('comments.userId', 'name email profileImage')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const publicationsData = publications.map(pub => pub.toObject());

    const total = await Publication.countDocuments({ 
      isActive: true,
      userId: req.user.userId 
    });

    console.log('✅ Mes publications trouvées:', publications.length, '/', total);
    res.json({
      publications: publicationsData,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total }
    });
  } catch (err) {
    console.error('❌ Erreur récupération mes publications:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/publications', verifyToken, async (req, res) => {
  console.log('\n=== RÉCUPÉRATION PUBLICATIONS ===');
  console.log('User ID:', req.user.userId);
  const page = +req.query.page || 1;
  const limit = +req.query.limit || 20;
  const skip = (page - 1) * limit;
  console.log('Page:', page, 'Limit:', limit);

  const publications = await Publication.find({ isActive: true })
    .populate('userId', 'name email profileImage')
    .populate('comments.userId', 'name email profileImage')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  // ✅ NE PAS transformer les URLs ici - le middleware le fera automatiquement
  const publicationsData = publications.map(pub => pub.toObject());

  const total = await Publication.countDocuments({ isActive: true });

  console.log('✅ Publications trouvées:', publications.length, '/', total);
  res.json({
    publications: publicationsData,
    pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total }
  });
});

// ✅ ROUTE - Récupérer les publications géolocalisées (AVANT /:id pour éviter les conflits)
app.get('/api/publications/geolocated', verifyToken, async (req, res) => {
  try {
    console.log('📍 Récupération des publications géolocalisées...');
    
    // ✅ CORRECTION - Chercher avec location.latitude et location.longitude (pas coordinates)
    const publications = await Publication.find({
      isActive: true,
      'location.latitude': { $exists: true, $ne: null },
      'location.longitude': { $exists: true, $ne: null }
    })
      .populate('userId', 'name email profileImage')
      .sort({ createdAt: -1 })
      .limit(100);

    console.log(`✅ ${publications.length} publications géolocalisées trouvées`);

    const publicationsData = publications.map(pub => ({
      _id: pub._id,
      userId: pub.userId?._id,
      userName: pub.userId?.name || 'Utilisateur',
      userImage: pub.userId?.profileImage || '',
      content: pub.content || '', // ✅ CORRECTION - 'content' (pas 'text')
      media: pub.media || [],
      location: pub.location || null,
      latitude: pub.location?.latitude, // ✅ Accès direct
      longitude: pub.location?.longitude, // ✅ Accès direct
      address: pub.location?.address || pub.location?.placeName || 'Adresse non disponible',
      likes: pub.likes?.length || 0,
      comments: pub.comments?.length || 0,
      createdAt: pub.createdAt
    }));

    res.json({
      success: true,
      total: publicationsData.length,
      publications: publicationsData
    });
  } catch (err) {
    console.error('❌ Erreur récupération publications géolocalisées:', err);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des publications géolocalisées',
      error: err.message
    });
  }
});

app.get('/api/publications/user/:userId', verifyToken, async (req, res) => {
  const publications = await Publication.find({ userId: req.params.userId, isActive: true })
    .populate('userId', 'name email profileImage')
    .sort({ createdAt: -1 });
  
  // ✅ NE PAS transformer les URLs ici - le middleware le fera automatiquement
  const publicationsData = publications.map(pub => pub.toObject());
  
  res.json({ publications: publicationsData });
});

// Route publique pour partage - pas besoin d'authentification
app.get('/api/publications/shared/:id', async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.id)
      .populate('userId', 'name email profileImage')
      .populate('comments.userId', 'name email profileImage');
    
    if (!pub || !pub.isActive) {
      return res.status(404).json({ 
        success: false,
        message: 'Publication introuvable' 
      });
    }

    // Tracker la visite
    const visitorId = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // Vérifier si c'est une nouvelle visite (pas visitée dans les dernières 24h)
    const existingVisit = pub.shareVisits.find(v => 
      v.visitorId === visitorId && 
      (Date.now() - new Date(v.visitedAt).getTime()) < 24 * 60 * 60 * 1000
    );
    
    if (!existingVisit) {
      pub.shareVisits.push({
        visitorId,
        visitedAt: new Date(),
        isNewUser: true,
        userAgent
      });
      await pub.save();
    }
    
    res.json({ 
      success: true,
      publication: pub 
    });
  } catch (error) {
    console.error('❌ Erreur récupération publication partagée:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

// Route pour obtenir les statistiques de partage d'une publication
app.get('/api/publications/:id/share-stats', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.id);
    
    if (!pub) {
      return res.status(404).json({ 
        success: false,
        message: 'Publication introuvable' 
      });
    }

    // Vérifier que l'utilisateur est le propriétaire
    if (pub.userId.toString() !== req.user.userId) {
      return res.status(403).json({ 
        success: false,
        message: 'Accès refusé' 
      });
    }

    // Calculer les statistiques
    const totalVisits = pub.shareVisits.length;
    const uniqueVisitors = new Set(pub.shareVisits.map(v => v.visitorId)).size;
    
    // Visites par jour (7 derniers jours)
    const last7Days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      
      const visitsCount = pub.shareVisits.filter(v => {
        const visitDate = new Date(v.visitedAt);
        return visitDate >= date && visitDate < nextDay;
      }).length;
      
      last7Days.push({
        date: date.toISOString().split('T')[0],
        visits: visitsCount
      });
    }

    res.json({
      success: true,
      stats: {
        totalVisits,
        uniqueVisitors,
        shareCount: pub.shareCount || 0,
        visitsByDay: last7Days,
        recentVisits: pub.shareVisits.slice(-10).reverse() // 10 dernières visites
      }
    });
  } catch (error) {
    console.error('❌ Erreur stats partage:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

app.get('/api/publications/:id', verifyToken, async (req, res) => {
  const pub = await Publication.findById(req.params.id)
    .populate('userId', 'name email profileImage')
    .populate('comments.userId', 'name email profileImage');
  if (!pub || !pub.isActive) return res.status(404).json({ message: 'Non trouvée' });
  res.json({ publication: pub });
});

app.put('/api/publications/:id', verifyToken, publicationUpload.array('media', 10), async (req, res) => {
  const pub = await Publication.findById(req.params.id);
  if (!pub || pub.userId.toString() !== req.user.userId) return res.status(403).json({ message: 'Accès refusé' });

  const { content, latitude, longitude, address, placeName, tags, category, visibility } = req.body;
  if (content !== undefined) pub.content = content.trim();
  if (req.files?.length) {
    req.files.forEach(f => pub.media.push({
      type: f.mimetype.startsWith('image/') ? 'image' : 'video',
      url: `${BASE_URL}/${f.path.replace(/\\/g, '/')}`,
      filename: f.filename
    }));
  }
  if (latitude && longitude) pub.location = { latitude: +latitude, longitude: +longitude, address, placeName };
  if (tags !== undefined) pub.tags = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (category !== undefined) pub.category = category;
  if (visibility !== undefined) pub.visibility = visibility;

  pub.updatedAt = new Date();
  await pub.save();
  await pub.populate('userId', 'name email profileImage');

  res.json({ message: 'Mise à jour OK', publication: pub });
});

// Route pour incrémenter le compteur de partages
app.post('/api/publications/:id/share', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.id);
    
    if (!pub) {
      return res.status(404).json({ 
        success: false,
        message: 'Publication introuvable' 
      });
    }

    // Incrémenter le compteur
    pub.shareCount = (pub.shareCount || 0) + 1;
    await pub.save();

    res.json({
      success: true,
      shareCount: pub.shareCount
    });
  } catch (error) {
    console.error('❌ Erreur incrémentation partage:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur' 
    });
  }
});

app.delete('/api/publications/:id', verifyToken, async (req, res) => {
  const pub = await Publication.findById(req.params.id);
  if (!pub || pub.userId.toString() !== req.user.userId) return res.status(403).json({ message: 'Accès refusé' });

  // Supprimer les médias de Cloudinary
  for (const media of pub.media) {
    if (media.cloudinaryPublicId) {
      try {
        await deleteFromCloudinary(media.cloudinaryPublicId);
        console.log('✅ Média supprimé de Cloudinary:', media.cloudinaryPublicId);
      } catch (err) {
        console.log('⚠️ Erreur suppression Cloudinary:', err.message);
      }
    }
  }

  pub.isActive = false;
  await pub.save();

  res.json({ message: 'Publication supprimée' });
});

app.post('/api/publications/:id/like', verifyToken, async (req, res) => {
  const pub = await Publication.findById(req.params.id).populate('userId', 'name email fcmToken notificationSettings');
  const index = pub.likes.indexOf(req.user.userId);
  const isLiking = index === -1;
  
  if (index > -1) {
    pub.likes.splice(index, 1);
  } else {
    pub.likes.push(req.user.userId);
    
    // Envoyer une notification au propriétaire de la publication
    if (pub.userId._id.toString() !== req.user.userId && pub.userId.notificationSettings?.likes !== false) {
      const liker = await User.findById(req.user.userId).select('name profileImage');
      
      // Notification push avec preview
      const contentPreview = pub.content?.substring(0, 50) || '[Publication]';
      await sendPushNotification(pub.userId._id, {
        title: '❤️ Nouveau like',
        body: `${liker.name} a aimé votre publication`,
        data: {
          type: 'like',
          publicationId: pub._id.toString(),
          userId: req.user.userId,
          userName: liker.name,
          userImage: liker.profileImage || '',
          publicationPreview: contentPreview
        }
      });

      // Email de notification
      if (pub.userId.email) {
        await sendEmailNotification(
          pub.userId.email,
          `❤️ ${liker.name} a aimé votre publication`,
          `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #FF0066, #FF6B9D); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0;">❤️ Nouveau like</h1>
            </div>
            <div style="padding: 30px; background: #f5f5f5; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; color: #333;">Bonjour <strong>${pub.userId.name}</strong>,</p>
              <p style="font-size: 16px; color: #333;"><strong>${liker.name}</strong> a aimé votre publication :</p>
              <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #FF0066;">
                <p style="font-size: 14px; color: #666; margin: 0;">${contentPreview}${pub.content?.length > 50 ? '...' : ''}</p>
              </div>
              <p style="text-align: center;">
                <a href="${BASE_URL}/publications/${pub._id}" style="display: inline-block; padding: 12px 30px; background: #FF0066; color: white; text-decoration: none; border-radius: 25px; font-weight: bold;">
                  Voir la publication
                </a>
              </p>
            </div>
          </div>`
        );
      }
    }
  }
  
  await pub.save();

  // Broadcast via WebSocket
  if (typeof broadcastToAll === 'function') {
    broadcastToAll({
      type: 'publication_like',
      publicationId: pub._id.toString(),
      likesCount: pub.likes.length,
      isLiked: isLiking
    });
  }

  res.json({ message: isLiking ? 'Liké' : 'Like retiré', likesCount: pub.likes.length });
});

// Sauvegarder une publication
app.post('/api/publications/:id/save', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const pubId = req.params.id;
    
    if (user.savedPublications.includes(pubId)) {
      return res.status(400).json({ message: 'Publication déjà sauvegardée' });
    }
    
    user.savedPublications.push(pubId);
    await user.save();
    
    res.json({ message: 'Publication sauvegardée', saved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Retirer une publication des sauvegardées
app.delete('/api/publications/:id/save', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const pubId = req.params.id;
    
    const index = user.savedPublications.indexOf(pubId);
    if (index === -1) {
      return res.status(400).json({ message: 'Publication non sauvegardée' });
    }
    
    user.savedPublications.splice(index, 1);
    await user.save();
    
    res.json({ message: 'Publication retirée des sauvegardées', saved: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer les publications sauvegardées
app.get('/api/users/saved-publications', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .populate({
        path: 'savedPublications',
        match: { isActive: true },
        populate: { path: 'userId', select: 'name email profileImage' }
      });
    
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    
    // ✅ NE PAS transformer les URLs ici - le middleware le fera automatiquement
    const pubsFiltered = user.savedPublications.filter(pub => pub !== null).map(pub => pub.toObject());
    
    res.json({ publications: pubsFiltered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer les commentaires d'une publication
app.get('/api/publications/:id/comments', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.id)
      .populate('comments.userId', 'name email profileImage');
    if (!pub || !pub.isActive) return res.status(404).json({ message: 'Publication non trouvée' });

    const comments = pub.comments.map(comment => comment.toObject());

    res.json({ comments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Ajouter un commentaire
// ========================================
// ROUTES : COMMENTAIRES (Mini-Chat Temps Réel)
// ========================================

// Récupérer tous les commentaires d'une publication
app.get('/api/publications/:id/comments', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.id)
      .populate('comments.userId', 'name email profileImage');
    
    if (!pub || !pub.isActive) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    // ✅ NE PAS transformer les URLs ici - le middleware le fera automatiquement
    const formattedComments = pub.comments.map(comment => comment.toObject());

    res.json({ comments: formattedComments });
  } catch (e) {
    console.error('Erreur récupération commentaires:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Ajouter un commentaire (texte, image, vidéo, audio)
app.post('/api/publications/:id/comments', verifyToken, commentUpload.array('media', 5), async (req, res) => {
  try {
    const { content, replyTo } = req.body;
    
    // Validation : au moins du contenu OU un média
    if (!content?.trim() && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ message: 'Commentaire vide' });
    }

    const pub = await Publication.findById(req.params.id);
    if (!pub || !pub.isActive) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    // Construire le commentaire
    const newComment = {
      userId: req.user.userId,
      content: content?.trim() || '',
      media: [],
      replyTo: replyTo || null,
      likes: [],
      isEdited: false
    };

    // Ajouter les médias si présents (Cloudinary)
    if (req.files && req.files.length > 0) {
      newComment.media = req.files.map(file => {
        let mediaType = 'image';
        if (file.mimetype.startsWith('video/')) mediaType = 'video';
        else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';

        return {
          type: mediaType,
          url: file.path,
          filename: file.filename,
          cloudinaryPublicId: file.filename,
          duration: null
        };
      });
    }

    pub.comments.push(newComment);
    await pub.save();

    // Récupérer le commentaire ajouté avec populate
    await pub.populate('comments.userId', 'name email profileImage');
    const addedComment = pub.comments[pub.comments.length - 1];

    const formattedComment = addedComment.toObject();

    // 🔥 Broadcast via WebSocket
    if (typeof broadcastToAll === 'function') {
      broadcastToAll({
        type: 'new_comment',
        publicationId: req.params.id,
        comment: formattedComment
      });
    }

    // Envoyer une notification au propriétaire de la publication
    await pub.populate('userId', 'name email fcmToken notificationSettings');
    if (pub.userId._id.toString() !== req.user.userId && pub.userId.notificationSettings?.comments !== false) {
      const commenter = await User.findById(req.user.userId).select('name profileImage');
      const commentText = content?.trim() || '[média]';
      
      // Créer un aperçu de la publication (texte ou première image)
      const publicationPreview = pub.content?.substring(0, 80) || '';
      const publicationImage = pub.media && pub.media.length > 0 && pub.media[0].type === 'image' 
        ? pub.media[0].url 
        : null;
      
      // Notification push avec preview de la publication
      await sendPushNotification(pub.userId._id, {
        title: '💬 Nouveau commentaire',
        body: `${commenter.name}: ${commentText.substring(0, 100)}`,
        data: {
          type: 'comment',
          publicationId: pub._id.toString(),
          commentId: addedComment._id.toString(),
          userId: req.user.userId,
          userName: commenter.name,
          userImage: commenter.profileImage || '',
          publicationPreview: publicationPreview,
          publicationImage: publicationImage,
          commentText: commentText.substring(0, 200)
        }
      });

      // Email notification avec preview
      if (pub.userId.email) {
        const publicationPreviewHtml = publicationImage 
          ? `<div style="text-align: center; margin: 15px 0;">
               <img src="${publicationImage}" style="max-width: 100%; border-radius: 10px; max-height: 200px; object-fit: cover;" />
             </div>`
          : '';
        
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #00FF88, #00CC66); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">💬 Nouveau commentaire</h1>
            </div>
            <div style="padding: 30px; background: #f5f5f5;">
              <p style="font-size: 16px; color: #333;">Bonjour <strong>${pub.userId.name}</strong>,</p>
              <p style="font-size: 16px; color: #333;">
                <strong>${commenter.name}</strong> a commenté votre publication :
              </p>
              
              ${publicationPreview ? `
                <div style="background: #e8f5e9; padding: 15px; border-radius: 10px; margin: 15px 0; border-left: 4px solid #00CC66;">
                  <p style="font-size: 13px; color: #666; margin: 0; font-style: italic;">Votre publication :</p>
                  <p style="font-size: 14px; color: #333; margin: 5px 0 0 0;">${publicationPreview}${publicationPreview.length >= 80 ? '...' : ''}</p>
                </div>
              ` : ''}
              
              ${publicationPreviewHtml}
              
              <div style="background: white; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #00FF88;">
                <p style="font-size: 13px; color: #666; margin: 0 0 8px 0;">Commentaire :</p>
                <p style="font-size: 14px; color: #555; margin: 0;"><strong>${commenter.name}</strong>: ${commentText}</p>
              </div>
              <p style="text-align: center;">
                <a href="${BASE_URL}" style="display: inline-block; padding: 12px 30px; background: #00FF88; color: black; text-decoration: none; border-radius: 25px; font-weight: bold;">
                  Voir le commentaire
                </a>
              </p>
            </div>
            <div style="background: #333; color: #999; text-align: center; padding: 15px; font-size: 12px;">
              <p>© 2025 CENTER - Application de gestion collaborative</p>
            </div>
          </div>
        `;
        
        await sendEmailNotification(
          pub.userId.email,
          '💬 Nouveau commentaire sur votre publication',
          emailHtml
        );
      }
    }

    res.status(201).json({ 
      message: 'Commentaire ajouté',
      comment: formattedComment
    });
  } catch (e) {
    console.error('Erreur ajout commentaire:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Modifier un commentaire
app.put('/api/publications/:pubId/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content?.trim()) {
      return res.status(400).json({ message: 'Contenu requis' });
    }

    const pub = await Publication.findById(req.params.pubId);
    if (!pub || !pub.isActive) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    const comment = pub.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Commentaire non trouvé' });
    }

    // Vérifier que c'est bien l'auteur
    if (comment.userId.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Accès refusé' });
    }

    comment.content = content.trim();
    comment.isEdited = true;
    comment.updatedAt = new Date();
    
    await pub.save();
    await pub.populate('comments.userId', 'name email profileImage');

    const updatedComment = pub.comments.id(req.params.commentId);
    
    const formattedComment = updatedComment.toObject();

    // 🔥 Broadcast via WebSocket
    if (typeof broadcastToAll === 'function') {
      broadcastToAll({
        type: 'edit_comment',
        publicationId: req.params.pubId,
        comment: formattedComment
      });
    }

    res.json({ 
      message: 'Commentaire modifié',
      comment: formattedComment
    });
  } catch (e) {
    console.error('Erreur modification commentaire:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Supprimer un commentaire
app.delete('/api/publications/:pubId/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.pubId);
    if (!pub || !pub.isActive) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    const comment = pub.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Commentaire non trouvé' });
    }

    // Vérifier que c'est bien l'auteur ou un admin
    const user = await User.findById(req.user.userId);
    const isAdmin = user.status === 'admin' || user.email === 'nyundumathryme@gmail.com';
    
    if (comment.userId.toString() !== req.user.userId && !isAdmin) {
      return res.status(403).json({ message: 'Accès refusé' });
    }

    // Supprimer les fichiers médias de Cloudinary
    if (comment.media && comment.media.length > 0) {
      for (const m of comment.media) {
        if (m.cloudinaryPublicId) {
          try {
            await deleteFromCloudinary(m.cloudinaryPublicId);
            console.log('✅ Média commentaire supprimé de Cloudinary:', m.cloudinaryPublicId);
          } catch (err) {
            console.log('⚠️ Erreur suppression média:', err.message);
          }
        }
      }
    }

    // Supprimer le commentaire du tableau
    pub.comments.pull(req.params.commentId);
    await pub.save();

    // 🔥 Broadcast via WebSocket
    if (typeof broadcastToAll === 'function') {
      broadcastToAll({
        type: 'delete_comment',
        publicationId: req.params.pubId,
        commentId: req.params.commentId
      });
    }

    res.json({ message: 'Commentaire supprimé' });
  } catch (e) {
    console.error('Erreur suppression commentaire:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Liker/Unliker un commentaire
app.post('/api/publications/:pubId/comments/:commentId/like', verifyToken, async (req, res) => {
  try {
    const pub = await Publication.findById(req.params.pubId);
    if (!pub || !pub.isActive) {
      return res.status(404).json({ message: 'Publication non trouvée' });
    }

    const comment = pub.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Commentaire non trouvé' });
    }

    const userId = req.user.userId;
    const likeIndex = comment.likes.indexOf(userId);

    if (likeIndex > -1) {
      // Unlike
      comment.likes.splice(likeIndex, 1);
    } else {
      // Like
      comment.likes.push(userId);
    }

    await pub.save();

    // 🔥 Broadcast via WebSocket
    if (typeof broadcastToAll === 'function') {
      broadcastToAll({
        type: 'like_comment',
        publicationId: req.params.pubId,
        commentId: req.params.commentId,
        likes: comment.likes
      });
    }

    res.json({ 
      message: likeIndex > -1 ? 'Like retiré' : 'Commentaire liké',
      likes: comment.likes
    });
  } catch (e) {
    console.error('Erreur like commentaire:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ⚠️ ROUTE SUPPRIMÉE - DOUBLON
// La route complète avec upload de média est définie plus haut (ligne ~2026)
// Cette version simplifiée sans média était redondante

app.delete('/api/publications/:id/media/:mediaIndex', verifyToken, async (req, res) => {
  const pub = await Publication.findById(req.params.id);
  if (pub.userId.toString() !== req.user.userId) return res.status(403).json({ message: 'Accès refusé' });

  const idx = +req.params.mediaIndex;
  if (idx < 0 || idx >= pub.media.length) return res.status(400).json({ message: 'Index invalide' });

  // Supprimer de Cloudinary
  if (pub.media[idx].cloudinaryPublicId) {
    try {
      await deleteFromCloudinary(pub.media[idx].cloudinaryPublicId);
      console.log('✅ Média supprimé de Cloudinary:', pub.media[idx].cloudinaryPublicId);
    } catch (err) {
      console.log('⚠️ Erreur suppression Cloudinary:', err.message);
    }
  }

  pub.media.splice(idx, 1);
  pub.updatedAt = new Date();
  await pub.save();

  res.json({ message: 'Média supprimé', media: pub.media });
});

// ========================================
// ROUTES : MARQUEURS
// ========================================

// Créer un marqueur
app.post('/api/markers', verifyToken, markerUpload.fields([
  { name: 'photos', maxCount: 10 },
  { name: 'videos', maxCount: 5 }
]), async (req, res) => {
  console.log('\n=== CRÉATION MARQUEUR ===');
  console.log('User ID:', req.user.userId);
  console.log('Latitude:', req.body.latitude);
  console.log('Longitude:', req.body.longitude);
  console.log('Title:', req.body.title);
  console.log('Photos:', req.files?.photos?.length || 0);
  console.log('Videos:', req.files?.videos?.length || 0);

  const { latitude, longitude, title, comment, color, userId } = req.body;
  if (!latitude || !longitude || !title) {
    console.log('❌ Champs requis manquants');
    return res.status(400).json({ message: 'Latitude, longitude et titre requis' });
  }

  try {
    const photos = req.files?.photos?.map(file => ({
      url: file.path,
      cloudinaryPublicId: file.filename
    })) || [];
    
    const videos = req.files?.videos?.map(file => ({
      url: file.path,
      cloudinaryPublicId: file.filename
    })) || [];

    const marker = new Marker({
      userId: req.user.userId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      title: title.trim(),
      comment: comment?.trim() || '',
      color: color || '#FF0000',
      photos,
      videos
    });

    await marker.save();
    await marker.populate('userId', 'name email');

    console.log('✅ Marqueur créé (Cloudinary), ID:', marker._id);
    res.status(201).json({ message: 'Marqueur créé', marker });
  } catch (err) {
    console.error('❌ Erreur création marqueur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer tous les marqueurs
app.get('/api/markers', verifyToken, async (req, res) => {
  console.log('\n=== RÉCUPÉRATION MARQUEURS ===');
  console.log('User ID:', req.user.userId);

  try {
    const markers = await Marker.find()
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    console.log('✅ Marqueurs trouvés:', markers.length);
    res.json({ markers });
  } catch (err) {
    console.error('❌ Erreur récupération marqueurs:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer les marqueurs d'un utilisateur
app.get('/api/markers/user/:userId', verifyToken, async (req, res) => {
  console.log('\n=== RÉCUPÉRATION MARQUEURS UTILISATEUR ===');
  console.log('User ID demandé:', req.params.userId);
  console.log('User ID connecté:', req.user.userId);

  try {
    const markers = await Marker.find({ userId: req.params.userId })
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    console.log('✅ Marqueurs utilisateur trouvés:', markers.length);
    res.json({ markers });
  } catch (err) {
    console.error('❌ Erreur récupération marqueurs utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer un marqueur par ID
app.get('/api/markers/:id', verifyToken, async (req, res) => {
  console.log('\n=== RÉCUPÉRATION MARQUEUR PAR ID ===');
  console.log('Marker ID:', req.params.id);

  try {
    const marker = await Marker.findById(req.params.id)
      .populate('userId', 'name email');

    if (!marker) {
      console.log('❌ Marqueur non trouvé');
      return res.status(404).json({ message: 'Marqueur non trouvé' });
    }

    console.log('✅ Marqueur trouvé');
    res.json({ marker });
  } catch (err) {
    console.error('❌ Erreur récupération marqueur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Mettre à jour un marqueur
app.put('/api/markers/:id', verifyToken, markerUpload.fields([
  { name: 'photos', maxCount: 10 },
  { name: 'videos', maxCount: 5 }
]), async (req, res) => {
  console.log('\n=== MISE À JOUR MARQUEUR ===');
  console.log('Marker ID:', req.params.id);
  console.log('User ID:', req.user.userId);

  try {
    const marker = await Marker.findById(req.params.id);
    if (!marker) {
      console.log('❌ Marqueur non trouvé');
      return res.status(404).json({ message: 'Marqueur non trouvé' });
    }

    if (marker.userId.toString() !== req.user.userId) {
      console.log('❌ Accès refusé');
      return res.status(403).json({ message: 'Accès refusé' });
    }

    const { title, comment, color } = req.body;
    
    if (title !== undefined) marker.title = title.trim();
    if (comment !== undefined) marker.comment = comment.trim();
    if (color !== undefined) marker.color = color;

    // Ajouter de nouveaux fichiers si fournis (Cloudinary)
    if (req.files?.photos?.length) {
      const newPhotos = req.files.photos.map(file => ({
        url: file.path,
        cloudinaryPublicId: file.filename
      }));
      marker.photos.push(...newPhotos);
    }

    if (req.files?.videos?.length) {
      const newVideos = req.files.videos.map(file => ({
        url: file.path,
        cloudinaryPublicId: file.filename
      }));
      marker.videos.push(...newVideos);
    }

    marker.updatedAt = new Date();
    await marker.save();
    await marker.populate('userId', 'name email');

    console.log('✅ Marqueur mis à jour (Cloudinary)');
    res.json({ message: 'Marqueur mis à jour', marker });
  } catch (err) {
    console.error('❌ Erreur mise à jour marqueur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Supprimer un marqueur
app.delete('/api/markers/:id', verifyToken, async (req, res) => {
  console.log('\n=== SUPPRESSION MARQUEUR ===');
  console.log('Marker ID:', req.params.id);
  console.log('User ID:', req.user.userId);

  try {
    const marker = await Marker.findById(req.params.id);
    if (!marker) {
      console.log('❌ Marqueur non trouvé');
      return res.status(404).json({ message: 'Marqueur non trouvé' });
    }

    if (marker.userId.toString() !== req.user.userId) {
      console.log('❌ Accès refusé');
      return res.status(403).json({ message: 'Accès refusé' });
    }

    // Supprimer les photos de Cloudinary
    for (const photo of marker.photos) {
      if (photo.cloudinaryPublicId) {
        try {
          await deleteFromCloudinary(photo.cloudinaryPublicId);
          console.log('✅ Photo supprimée de Cloudinary:', photo.cloudinaryPublicId);
        } catch (err) {
          console.error('⚠️ Erreur suppression photo:', err.message);
        }
      }
    }

    // Supprimer les vidéos de Cloudinary
    for (const video of marker.videos) {
      if (video.cloudinaryPublicId) {
        try {
          await deleteFromCloudinary(video.cloudinaryPublicId);
          console.log('✅ Vidéo supprimée de Cloudinary:', video.cloudinaryPublicId);
        } catch (err) {
          console.error('⚠️ Erreur suppression vidéo:', err.message);
        }
      }
    }

    await Marker.findByIdAndDelete(req.params.id);
    console.log('✅ Marqueur supprimé');
    res.json({ message: 'Marqueur supprimé' });
  } catch (err) {
    console.error('❌ Erreur suppression marqueur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Supprimer un média d'un marqueur
app.delete('/api/markers/:id/media/:type/:index', verifyToken, async (req, res) => {
  console.log('\n=== SUPPRESSION MÉDIA MARQUEUR ===');
  console.log('Marker ID:', req.params.id);
  console.log('Type:', req.params.type);
  console.log('Index:', req.params.index);

  try {
    const marker = await Marker.findById(req.params.id);
    if (!marker) {
      console.log('❌ Marqueur non trouvé');
      return res.status(404).json({ message: 'Marqueur non trouvé' });
    }

    if (marker.userId.toString() !== req.user.userId) {
      console.log('❌ Accès refusé');
      return res.status(403).json({ message: 'Accès refusé' });
    }

    const { type, index } = req.params;
    const idx = parseInt(index);

    if (type === 'photo' && idx >= 0 && idx < marker.photos.length) {
      if (marker.photos[idx].cloudinaryPublicId) {
        try {
          await deleteFromCloudinary(marker.photos[idx].cloudinaryPublicId);
          console.log('✅ Photo supprimée de Cloudinary:', marker.photos[idx].cloudinaryPublicId);
        } catch (err) {
          console.log('⚠️ Erreur suppression photo:', err.message);
        }
      }
      marker.photos.splice(idx, 1);
    } else if (type === 'video' && idx >= 0 && idx < marker.videos.length) {
      if (marker.videos[idx].cloudinaryPublicId) {
        try {
          await deleteFromCloudinary(marker.videos[idx].cloudinaryPublicId);
          console.log('✅ Vidéo supprimée de Cloudinary:', marker.videos[idx].cloudinaryPublicId);
        } catch (err) {
          console.log('⚠️ Erreur suppression vidéo:', err.message);
        }
      }
      marker.videos.splice(idx, 1);
    } else {
      console.log('❌ Type ou index invalide');
      return res.status(400).json({ message: 'Type ou index invalide' });
    }

    marker.updatedAt = new Date();
    await marker.save();

    console.log('✅ Média supprimé');
    res.json({ message: 'Média supprimé', marker });
  } catch (err) {
    console.error('❌ Erreur suppression média:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ========================================
// ROUTES : GESTION DES EMPLOYÉS (ADMIN) - COMPLÈTES
// ========================================

// Lister les employés (GET) - avec support des filtres
app.get('/api/employees', verifyToken, verifyCanCreateEmployees, async (req, res) => {
  try {
    const { search, department, status, sortBy, order } = req.query;
    
  // Récupérer l'email de l'utilisateur connecté
  // NOTE: verifyToken ajoute req.user (JWT payload). Utiliser req.user.userId ici.
  const currentUser = await User.findById(req.user?.userId);
  const currentUserEmail = currentUser ? currentUser.email : null;
    
    // Construire la requête de filtrage
    let query = {};
    
    // Filtre de recherche (nom, email, téléphone)
    if (search && search.trim() !== '') {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { role: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Filtre par département
    if (department && department !== 'Tous') {
      query.department = department;
    }
    
    // Filtre par statut
    if (status && status !== 'tous') {
      query.status = status;
    }
    
    // Définir le tri
    let sortOptions = { createdAt: -1 }; // Par défaut : plus récent
    if (sortBy) {
      const sortOrder = order === 'asc' ? 1 : -1;
      sortOptions = { [sortBy]: sortOrder };
    }
    
    const employees = await Employee.find(query).sort(sortOptions);
    
    // ✅ Mapper les employés et ajouter le statut "online" pour l'employé correspondant à l'utilisateur connecté
    const employeesWithStatus = employees.map(emp => {
      const empObj = emp.toObject();
      
      // DEBUG: Log pour voir les données brutes
      if (!empObj.name || empObj.name.includes('null')) {
        console.log('⚠️ Employé avec nom problématique:', {
          id: empObj._id,
          name: empObj.name,
          email: empObj.email,
          firstName: empObj.firstName,
          lastName: empObj.lastName
        });
      }
      
      // Si l'email de l'employé correspond à l'utilisateur connecté, il est en ligne
      if (currentUserEmail && empObj.email === currentUserEmail) {
        empObj.status = 'online';
      } else if (!empObj.status) {
        empObj.status = 'offline';
      }
      
      return empObj;
    });
    
    // ✅ Retourner les données avec statuts
    res.json({ 
      employees: employeesWithStatus,
      total: employeesWithStatus.length,
      filters: { search, department, status, sortBy, order }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors du listage des employés' });
  }
});

// Créer un employé (déjà présent)
app.post('/api/employees', verifyToken, verifyCanCreateEmployees, employeeUpload.fields([
  { name: 'faceImage', maxCount: 1 },
  { name: 'certificate', maxCount: 1 }
]), async (req, res) => {
  const { name, email, phone, role, department, startDate, endDate, certificateStartDate, certificateEndDate } = req.body;
  if (!name || !email || !phone) return res.status(400).json({ message: 'Champs requis' });

  try {
    if (await Employee.findOne({ email })) return res.status(400).json({ message: 'Email déjà utilisé' });

    const employee = new Employee({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      role: role?.trim() || '',
      department: department?.trim() || 'IT',
      faceImage: req.files.faceImage?.[0] ? req.files.faceImage[0].path : '',
      faceImagePublicId: req.files.faceImage?.[0] ? req.files.faceImage[0].filename : undefined,
      certificate: req.files.certificate?.[0] ? req.files.certificate[0].path : '',
      certificatePublicId: req.files.certificate?.[0] ? req.files.certificate[0].filename : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      certificateStartDate: certificateStartDate ? new Date(certificateStartDate) : undefined,
      certificateEndDate: certificateEndDate ? new Date(certificateEndDate) : undefined
    });

    await employee.save();
    console.log('✅ Employé créé (Cloudinary):', employee._id);
    res.json({ message: 'Employé créé', employee: employee.toObject() });

    // Créer une notification pour tous les admins (asynchrone)
    (async () => {
      try {
        const admins = await User.find({ 
          $or: [
            { status: 'admin' }, 
            { email: { $in: ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'] } }
          ] 
        });

        // Créer une notification pour chaque admin
        for (const admin of admins) {
          await Notification.create({
            userId: admin._id,
            type: 'employee_created',
            title: 'Nouvel employé',
            message: `${employee.name} a été ajouté comme employé`,
            data: {
              employeeId: employee._id,
              employeeName: employee.name,
              employeeEmail: employee.email,
              department: employee.department
            }
          });
          
          // Diffuser via WebSocket à cet admin
          broadcastToUser(admin._id.toString(), {
            type: 'new_employee',
            employee: employeeWithUrls
          });
        }

        // Envoyer email (optionnel)
        const emails = [...new Set(admins.map(a => a.email))].filter(Boolean);
        if (emails.length) {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emails.join(','),
            subject: `Nouvel employé: ${employee.name}`,
            html: `<h2>Nouvel employé</h2><p>${employee.name} (${employee.email})</p><p>Département: ${employee.department}</p>`
          });
        }
      } catch (err) {
        console.error('Erreur notification:', err);
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la création' });
  }
});

// Modifier un employé (PUT)
app.put('/api/employees/:id', verifyToken, verifyCanCreateEmployees, employeeUpload.fields([
  { name: 'faceImage', maxCount: 1 },
  { name: 'certificate', maxCount: 1 }
]), async (req, res) => {
  const { name, email, phone, role, department, startDate, endDate, certificateStartDate, certificateEndDate } = req.body;
  const id = req.params.id;

  try {
    const employee = await Employee.findById(id);
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });

    if (name) employee.name = name.trim();
    if (email) employee.email = email.trim();
    if (phone) employee.phone = phone.trim();
    if (role) employee.role = role.trim();
    if (department) employee.department = department.trim();
    if (startDate) employee.startDate = new Date(startDate);
    if (endDate) employee.endDate = new Date(endDate);
    if (certificateStartDate) employee.certificateStartDate = new Date(certificateStartDate);
    if (certificateEndDate) employee.certificateEndDate = new Date(certificateEndDate);

    // Mise à jour des fichiers si fournis (Cloudinary)
    if (req.files.faceImage?.[0]) {
      if (employee.faceImagePublicId) {
        try {
          await deleteFromCloudinary(employee.faceImagePublicId);
          console.log('✅ Ancienne photo visage supprimée:', employee.faceImagePublicId);
        } catch (err) {
          console.log('⚠️ Erreur suppression photo:', err.message);
        }
      }
      employee.faceImage = req.files.faceImage[0].path;
      employee.faceImagePublicId = req.files.faceImage[0].filename;
    }
    if (req.files.certificate?.[0]) {
      if (employee.certificatePublicId) {
        try {
          await deleteFromCloudinary(employee.certificatePublicId);
          console.log('✅ Ancien certificat supprimé:', employee.certificatePublicId);
        } catch (err) {
          console.log('⚠️ Erreur suppression certificat:', err.message);
        }
      }
      employee.certificate = req.files.certificate[0].path;
      employee.certificatePublicId = req.files.certificate[0].filename;
    }

    employee.updatedAt = new Date();
    await employee.save();

    res.json({ message: 'Employé mis à jour', employee: employee.toObject() });

    // Créer une notification pour tous les admins (asynchrone)
    (async () => {
      try {
        const admins = await User.find({ 
          $or: [
            { status: 'admin' }, 
            { email: { $in: ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'] } }
          ] 
        });

        for (const admin of admins) {
          await Notification.create({
            userId: admin._id,
            type: 'employee_updated',
            title: 'Employé mis à jour',
            message: `Les informations de ${employee.name} ont été modifiées`,
            data: {
              employeeId: employee._id,
              employeeName: employee.name
            }
          });
        }
      } catch (err) {
        console.error('Erreur notification:', err);
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la mise à jour' });
  }
});

// Supprimer un employé (DELETE)
app.delete('/api/employees/:id', verifyToken, verifyCanCreateEmployees, async (req, res) => {
  const id = req.params.id;

  try {
    const employee = await Employee.findById(id);
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });

    // Supprimer les fichiers de Cloudinary
    if (employee.faceImagePublicId) {
      try {
        await deleteFromCloudinary(employee.faceImagePublicId);
        console.log('✅ Photo visage supprimée de Cloudinary:', employee.faceImagePublicId);
      } catch (err) {
        console.log('⚠️ Erreur suppression photo:', err.message);
      }
    }
    if (employee.certificatePublicId) {
      try {
        await deleteFromCloudinary(employee.certificatePublicId);
        console.log('✅ Certificat supprimé de Cloudinary:', employee.certificatePublicId);
      } catch (err) {
        console.log('⚠️ Erreur suppression certificat:', err.message);
      }
    }

    const employeeName = employee.name;
    await Employee.findByIdAndDelete(id);
    res.json({ message: 'Employé supprimé' });

    // Créer une notification pour tous les admins (asynchrone)
    (async () => {
      try {
        const admins = await User.find({ 
          $or: [
            { status: 'admin' }, 
            { email: { $in: ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'] } }
          ] 
        });

        for (const admin of admins) {
          await Notification.create({
            userId: admin._id,
            type: 'employee_deleted',
            title: 'Employé supprimé',
            message: `${employeeName} a été retiré de la liste des employés`,
            data: {
              employeeName
            }
          });
        }
      } catch (err) {
        console.error('Erreur notification:', err);
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la suppression' });
  }
});

// ========================================
// ROUTES : NOTIFICATIONS
// ========================================

// Récupérer les notifications de l'utilisateur
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    const unreadCount = await Notification.countDocuments({ 
      userId: req.user.userId, 
      read: false 
    });

    res.json({ 
      notifications,
      unreadCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Marquer une notification comme lue
app.put('/api/notifications/:id/read', verifyToken, async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user.userId
    });

    if (!notification) return res.status(404).json({ message: 'Notification non trouvée' });

    notification.read = true;
    await notification.save();

    res.json({ message: 'Notification marquée comme lue', notification });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Marquer toutes les notifications comme lues
app.put('/api/notifications/read-all', verifyToken, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.userId, read: false },
      { $set: { read: true } }
    );

    res.json({ message: 'Toutes les notifications marquées comme lues' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Supprimer une notification
app.delete('/api/notifications/:id', verifyToken, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.userId
    });

    if (!notification) return res.status(404).json({ message: 'Notification non trouvée' });

    res.json({ message: 'Notification supprimée' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// ========================================
// ROUTES : GESTION DES UTILISATEURS (ADMIN)
// ========================================

// Statistiques admin globales
app.get('/api/admin/stats', verifyToken, verifyCanManageUsers, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ status: 'active' });
    const blockedUsers = await User.countDocuments({ status: 'blocked' });
    const adminUsers = await User.countDocuments({ status: 'admin' });
    
    const totalEmployees = await Employee.countDocuments();
    const activeEmployees = await Employee.countDocuments({ status: 'active' });
    const onLeaveEmployees = await Employee.countDocuments({ status: 'on_leave' });
    const terminatedEmployees = await Employee.countDocuments({ status: 'terminated' });
    
    const totalPublications = await Publication.countDocuments({ isActive: true });
    const totalMarkers = await Marker.countDocuments();

    res.json({
      users: {
        total: totalUsers,
        active: activeUsers,
        blocked: blockedUsers,
        admin: adminUsers
      },
      employees: {
        total: totalEmployees,
        active: activeEmployees,
        onLeave: onLeaveEmployees,
        terminated: terminatedEmployees
      },
      publications: {
        total: totalPublications
      },
      markers: {
        total: totalMarkers
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la récupération des statistiques' });
  }
});

// Récupérer toutes les cartes d'identité (ADMIN)
app.get('/api/admin/id-cards', verifyToken, verifyCanManageUsers, async (req, res) => {
  try {
    const idCards = await VirtualIDCard.find({})
      .populate('userId', 'name email profileImage')
      .sort({ createdAt: -1 });

    const idCardsData = idCards.map(card => ({
      _id: card._id,
      cardNumber: card.cardNumber,
      userId: card.userId?._id,
      user: card.userId ? {
        _id: card.userId._id,
        name: card.userId.name || card.userId.email.split('@')[0],
        email: card.userId.email,
        profileImage: card.userId.profileImage
      } : null,
      cardData: {
        firstName: card.cardData.firstName,
        lastName: card.cardData.lastName,
        dateOfBirth: card.cardData.dateOfBirth,
        placeOfBirth: card.cardData.placeOfBirth,
        nationality: card.cardData.nationality,
        idNumber: card.cardData.idNumber,
        issueDate: card.cardData.issueDate,
        expiryDate: card.cardData.expiryDate,
        photo: card.cardData.photo
      },
      createdAt: card.createdAt,
      isActive: card.isActive
    }));

    res.json({
      success: true,
      idCards: idCardsData,
      total: idCardsData.length
    });
  } catch (err) {
    console.error('Erreur récupération cartes d\'identité:', err);
    res.status(500).json({ 
      message: 'Erreur serveur lors de la récupération des cartes d\'identité',
      error: err.message 
    });
  }
});

// Route des statistiques accessibles à tous les utilisateurs authentifiés
// Retourne les données selon les permissions (employés vs admins)
app.get('/api/stats', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    // Vérifier si l'utilisateur est admin
    const isAdmin = user.status === 'admin' || 
                    ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase());

    // Statistiques de publications PERSONNELLES (pour chaque utilisateur)
    const totalPublications = await Publication.countDocuments({ 
      userId: req.user.userId,  // UNIQUEMENT les publications de l'utilisateur
      isActive: true 
    });
    
    // Compter les publications personnelles avec géolocalisation
    const publicationsWithLocation = await Publication.countDocuments({
      userId: req.user.userId,  // UNIQUEMENT les publications de l'utilisateur
      isActive: true,
      'location.latitude': { $exists: true, $ne: null },
      'location.longitude': { $exists: true, $ne: null }
    });

    const stats = {
      publications: {
        total: totalPublications,
        withLocation: publicationsWithLocation,
        locationRate: totalPublications > 0 ? ((publicationsWithLocation / totalPublications) * 100).toFixed(1) : '0'
      }
    };

    // Ajouter les statistiques d'employés et utilisateurs UNIQUEMENT pour les admins
    if (isAdmin) {
      const totalUsers = await User.countDocuments();
      const activeUsers = await User.countDocuments({ status: 'active' });
      const blockedUsers = await User.countDocuments({ status: 'blocked' });
      const adminUsers = await User.countDocuments({ status: 'admin' });
      
      const totalEmployees = await Employee.countDocuments();
      const activeEmployees = await Employee.countDocuments({ status: 'active' });
      const onLeaveEmployees = await Employee.countDocuments({ status: 'on_leave' });
      const terminatedEmployees = await Employee.countDocuments({ status: 'terminated' });
      
      const totalMarkers = await Marker.countDocuments();

      stats.users = {
        total: totalUsers,
        active: activeUsers,
        blocked: blockedUsers,
        admin: adminUsers
      };

      stats.employees = {
        total: totalEmployees,
        active: activeEmployees,
        onLeave: onLeaveEmployees,
        terminated: terminatedEmployees
      };

      stats.markers = {
        total: totalMarkers
      };
    }

    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur lors de la récupération des statistiques' });
  }
});

// Récupérer les statistiques de stockage de l'utilisateur
app.get('/api/users/me/storage', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    // Limite de stockage : 5 GB par utilisateur
    const STORAGE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB en bytes

    // Récupérer toutes les publications de l'utilisateur avec médias
    const publications = await Publication.find({ 
      userId: req.user.userId,
      isActive: true 
    }).select('media');

    let totalSize = 0;
    let mediaCount = 0;
    const mediaTypes = { images: 0, videos: 0, audio: 0, documents: 0 };

    // Calculer la taille totale des médias
    for (const publication of publications) {
      if (publication.media && publication.media.length > 0) {
        for (const media of publication.media) {
          mediaCount++;
          
          // Compter par type
          if (media.type === 'image') mediaTypes.images++;
          else if (media.type === 'video') mediaTypes.videos++;
          else if (media.type === 'audio') mediaTypes.audio++;
          else mediaTypes.documents++;

          // Calculer la taille du fichier
          if (media.filename) {
            const filePath = path.join(__dirname, 'uploads', 'publications', media.filename);
            try {
              if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                totalSize += stats.size;
              }
            } catch (err) {
              console.error(`Erreur lecture fichier ${media.filename}:`, err);
            }
          }
        }
      }
    }

    // Calculer le pourcentage utilisé
    const percentageUsed = ((totalSize / STORAGE_LIMIT) * 100).toFixed(2);

    res.json({
      success: true,
      storage: {
        used: totalSize, // en bytes
        usedMB: (totalSize / (1024 * 1024)).toFixed(2), // en MB
        usedGB: (totalSize / (1024 * 1024 * 1024)).toFixed(2), // en GB
        limit: STORAGE_LIMIT,
        limitGB: 5,
        available: STORAGE_LIMIT - totalSize,
        availableGB: ((STORAGE_LIMIT - totalSize) / (1024 * 1024 * 1024)).toFixed(2),
        percentageUsed: parseFloat(percentageUsed),
        mediaCount: mediaCount,
        mediaTypes: mediaTypes
      }
    });
  } catch (err) {
    console.error('Erreur récupération stockage:', err);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de la récupération du stockage' 
    });
  }
});

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION TOUS LES UTILISATEURS ===');
    console.log('User ID:', req.user.userId);

    // Récupérer tous les utilisateurs actifs, admins et bloqués (pour permettre la réactivation)
    const users = await User.find({
      _id: { $ne: req.user.userId }, // Exclure l'utilisateur actuel
      status: { $in: ['active', 'admin', 'blocked'] }
    })
    .select('name email profileImage status accessLevel aiChatAccess messageAccess')
    .sort({ name: 1 });

    const usersData = users.map(user => ({
      _id: user._id,
      name: user.name || user.email.split('@')[0], // Utiliser le nom ou la partie avant @ de l'email
      email: user.email,
      profileImage: user.profileImage,
      status: user.status,
      accessLevel: user.accessLevel || 0,
      aiChatAccess: user.aiChatAccess || false,
      messageAccess: user.messageAccess || false
    }));

    console.log(`✅ ${usersData.length} utilisateurs trouvés pour tous les utilisateurs authentifiés`);

    res.json({
      success: true,
      users: usersData
    });
  } catch (error) {
    console.error('❌ Erreur récupération tous les utilisateurs:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur'
    });
  }
});

// Route publique pour récupérer la liste des utilisateurs (pour messagerie)
app.get('/api/users/list', verifyToken, async (req, res) => {
  try {
    const users = await User.find({ status: { $in: ['active', 'admin'] } })
      .select('name email profileImage status')
      .sort({ name: 1 });

    const usersData = users.map(user => ({
      _id: user._id,
      name: user.name || user.email.split('@')[0],
      email: user.email,
      profileImage: user.profileImage,
      status: user.status
    }));

    res.json({ users: usersData });
  } catch (error) {
    console.error('Erreur récupération liste utilisateurs:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.put('/api/users/:id/status', verifyToken, verifyCanManageUsers, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'blocked', 'admin'].includes(status)) return res.status(400).json({ message: 'Statut invalide' });

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

  const mainAdmin = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase());
  if (mainAdmin) return res.status(403).json({ message: 'Impossible de modifier l\'admin principal' });

  user.status = status;
  await user.save();

  res.json({ message: 'Statut mis à jour', user });
});

app.put('/api/users/:id/access-level', verifyToken, verifyCanManageUsers, async (req, res) => {
  console.log('\n=== MISE À JOUR NIVEAU D\'ACCÈS ===');
  console.log('User ID:', req.params.id);
  console.log('Access Level:', req.body.accessLevel);
  console.log('Token User ID:', req.user.userId);

  const { accessLevel } = req.body;
  if (![0, 1, 2].includes(accessLevel)) {
    console.log('❌ Niveau d\'accès invalide:', accessLevel);
    return res.status(400).json({ message: 'Niveau d\'accès invalide' });
  }

  try {
    console.log('🔍 Recherche de l\'utilisateur...');
    const user = await User.findById(req.params.id);
    if (!user) {
      console.log('❌ Utilisateur non trouvé:', req.params.id);
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    console.log('✅ Utilisateur trouvé:', user.name, user.email);

    const mainAdmin = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase());
    if (mainAdmin) {
      console.log('🚫 Tentative de modification de l\'admin principal');
      return res.status(403).json({ message: 'Impossible de modifier l\'admin principal' });
    }

    console.log('🔄 Mise à jour du niveau d\'accès:', user.accessLevel, '→', accessLevel);
    user.accessLevel = accessLevel;
    await user.save();

    console.log('✅ Niveau d\'accès mis à jour avec succès');
    res.json({ message: 'Niveau d\'accès mis à jour', user });
  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour du niveau d\'accès:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

app.put('/api/users/:id/ai-chat-access', verifyToken, verifyCanManageUsers, async (req, res) => {
  console.log('\n=== BASCULE ACCÈS CHAT IA ===');
  console.log('User ID:', req.params.id);
  console.log('Token User ID:', req.user.userId);

  try {
    console.log('🔍 Recherche de l\'utilisateur...');
    const user = await User.findById(req.params.id);
    if (!user) {
      console.log('❌ Utilisateur non trouvé:', req.params.id);
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    console.log('✅ Utilisateur trouvé:', user.name, user.email);

    const mainAdmin = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase());
    if (mainAdmin) {
      console.log('🚫 Tentative de modification de l\'admin principal');
      return res.status(403).json({ message: 'Impossible de modifier l\'admin principal' });
    }

    // Basculer l'accès au chat IA
    const newAiChatAccess = !user.aiChatAccess;
    console.log('🔄 Bascule accès chat IA:', user.aiChatAccess, '→', newAiChatAccess);
    user.aiChatAccess = newAiChatAccess;
    await user.save();

    console.log('✅ Accès chat IA mis à jour avec succès');
    res.json({ 
      message: `Accès chat IA ${newAiChatAccess ? 'activé' : 'désactivé'}`, 
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        aiChatAccess: user.aiChatAccess
      }
    });
  } catch (error) {
    console.error('❌ Erreur lors de la bascule accès chat IA:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

app.put('/api/users/:id/message-access', verifyToken, verifyCanManageUsers, async (req, res) => {
  console.log('\n=== BASCULE ACCÈS MESSAGERIE ===');
  console.log('User ID:', req.params.id);
  console.log('Token User ID:', req.user.userId);

  try {
    console.log('🔍 Recherche de l\'utilisateur...');
    const user = await User.findById(req.params.id);
    if (!user) {
      console.log('❌ Utilisateur non trouvé:', req.params.id);
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    console.log('✅ Utilisateur trouvé:', user.name, user.email);

    const mainAdmin = ['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase());
    if (mainAdmin) {
      console.log('🚫 Tentative de modification de l\'admin principal');
      return res.status(403).json({ message: 'Impossible de modifier l\'admin principal' });
    }

    // Basculer l'accès à la messagerie
    const newMessageAccess = !user.messageAccess;
    console.log('🔄 Bascule accès messagerie:', user.messageAccess, '→', newMessageAccess);
    user.messageAccess = newMessageAccess;
    await user.save();

    console.log('✅ Accès messagerie mis à jour avec succès');
    res.json({
      message: `Accès messagerie ${newMessageAccess ? 'activé' : 'désactivé'}`,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        messageAccess: user.messageAccess
      }
    });
  } catch (error) {
    console.error('❌ Erreur lors de la bascule accès messagerie:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

app.delete('/api/users/:id', verifyToken, verifyCanManageUsers, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

  if (['nyundumathryme@gmail', 'nyundumathryme@gmail.com'].includes(user.email.toLowerCase())) {
    return res.status(403).json({ message: 'Impossible de supprimer l\'admin principal' });
  }

  if (user.cloudinaryPublicId) {
    try {
      await deleteFromCloudinary(user.cloudinaryPublicId);
      console.log('✅ Photo de profil supprimée de Cloudinary:', user.cloudinaryPublicId);
    } catch (err) {
      console.log('⚠️ Erreur suppression photo:', err.message);
    }
  }

  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'Utilisateur supprimé' });
});

// ========================================
// ROUTES : UTILITAIRES
// ========================================

// Route pour obtenir l'IP et l'URL de base du serveur
app.get('/api/server-info', (req, res) => {
  console.log('\n=== INFO SERVEUR DEMANDÉE ===');
  console.log('IP du serveur:', SERVER_IP);
  console.log('URL de base:', BASE_URL);
  
  res.json({
    serverIp: SERVER_IP,
    baseUrl: BASE_URL,
    port: process.env.PORT || 5000,
    timestamp: new Date().toISOString()
  });
});

// ========================================
// DÉMARRAGE DU SERVEUR
// ========================================

// 🔧 ENDPOINT DE MAINTENANCE: Nettoyer les employés avec "null null"
app.post('/api/admin/fix-employee-names', verifyToken, async (req, res) => {
  try {
    const employees = await Employee.find({});
    let fixedCount = 0;
    let errorCount = 0;

    for (const emp of employees) {
      let needsUpdate = false;
      const updates = {};

      // Vérifier si le nom contient "null" ou est vide
      if (!emp.name || emp.name.includes('null') || emp.name.trim() === '') {
        // Extraire le nom de l'email
        const emailName = emp.email.split('@')[0];
        updates.name = emailName.charAt(0).toUpperCase() + emailName.slice(1);
        needsUpdate = true;
      }

      if (needsUpdate) {
        try {
          await Employee.updateOne({ _id: emp._id }, { $set: updates });
          fixedCount++;
          console.log(`✅ Employé ${emp._id} corrigé: ${emp.name} → ${updates.name}`);
        } catch (err) {
          errorCount++;
          console.error(`❌ Erreur correction ${emp._id}:`, err.message);
        }
      }
    }

    res.json({
      success: true,
      message: `Nettoyage terminé: ${fixedCount} employés corrigés, ${errorCount} erreurs`,
      fixed: fixedCount,
      errors: errorCount,
      total: employees.length
    });
  } catch (err) {
    console.error('Erreur nettoyage employés:', err);
    res.status(500).json({ 
      message: 'Erreur lors du nettoyage',
      error: err.message 
    });
  }
});

// ========================================
// ROUTES : CARTES D'IDENTITÉ VIRTUELLES
// ========================================

const virtualIDCardRoutes = require('./routes/virtualIDCard');
app.use('/api/virtual-id-cards', virtualIDCardRoutes);

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log('\n========================================');
  console.log('🚀 SERVEUR DÉMARRÉ');
  console.log('========================================');
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`🌐 Réseau: ${BASE_URL}`);
  console.log(`🔗 IP détectée automatiquement: ${SERVER_IP}`);
  console.log('========================================');
  console.log('🔐 CONFIGURATION SÉCURITÉ:');
  console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ Défini (' + process.env.JWT_SECRET.length + ' caractères)' : '❌ NON DÉFINI');
  console.log('   JWT_REFRESH_SECRET:', process.env.JWT_REFRESH_SECRET ? '✅ Défini' : '❌ NON DÉFINI');
  console.log('========================================');
  console.log('📧 CONFIGURATION EMAIL:');
  console.log('   EMAIL_USER:', process.env.EMAIL_USER ? '✅ ' + process.env.EMAIL_USER : '❌ NON DÉFINI');
  console.log('   EMAIL_PASS:', process.env.EMAIL_PASS ? '✅ Défini' : '❌ NON DÉFINI');
  console.log('========================================');
  console.log('💾 CONFIGURATION DATABASE:');
  console.log('   MONGO_URI:', process.env.MONGO_URI ? '✅ Défini' : '❌ NON DÉFINI');
  console.log('========================================\n');
});

// ========================================
// CONFIGURATION WEBSOCKET
// ========================================

const wss = new WebSocketServer({ server });
const clients = new Map(); // Map<userId, WebSocket>

wss.on('connection', (ws) => {
  console.log('🔌 Nouvelle connexion WebSocket');
  let userId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Authentification
      if (data.type === 'auth' && data.token) {
        try {
          const decoded = jwt.verify(data.token, process.env.JWT_SECRET);
          userId = decoded.userId; // Utiliser userId au lieu de id
          clients.set(userId, ws);
          console.log(`✅ Client authentifié: ${decoded.email || userId}`);
          
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: 'Authentifié avec succès',
            userId: userId,
            email: decoded.email
          }));
        } catch (err) {
          console.log('❌ Token invalide');
          ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Token invalide'
          }));
        }
      }
      
      // Abonnement à un canal
      else if (data.type === 'subscribe') {
        console.log(`📢 Abonnement au canal: ${data.channel}`);
      }
      
      // Désabonnement
      else if (data.type === 'unsubscribe') {
        console.log(`📢 Désabonnement du canal: ${data.channel}`);
      }
    } catch (err) {
      console.error('❌ Erreur parsing message WebSocket:', err);
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`🔌 Client déconnecté: ${userId}`);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket:', error);
  });
});

// Fonction pour diffuser des notifications
function broadcastToUser(userId, data) {
  const client = clients.get(userId);
  if (client && client.readyState === 1) { // 1 = OPEN
    client.send(JSON.stringify(data));
    console.log(`📤 Message envoyé à ${userId}`);
    return true;
  }
  return false;
}

// Fonction pour diffuser à tous les utilisateurs
function broadcastToAll(data) {
  let sent = 0;
  clients.forEach((client, userId) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
      sent++;
    }
  });
  console.log(`📤 Message diffusé à ${sent} clients`);
  return sent;
}

// Exporter les fonctions de broadcast
global.broadcastToUser = broadcastToUser;
global.broadcastToAll = broadcastToAll;

// ========================================
// ROUTES DE COMMUNICATION (EMAIL & WHATSAPP)
// ========================================

// Envoyer un email à un employé
app.post('/api/employees/:id/send-email', verifyToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    const employee = await Employee.findById(req.params.id);
    
    if (!employee) {
      return res.status(404).json({ message: 'Employé non trouvé' });
    }

    if (!employee.email) {
      return res.status(400).json({ message: 'L\'employé n\'a pas d\'email' });
    }

    if (!subject || !message) {
      return res.status(400).json({ message: 'Sujet et message requis' });
    }

    // Configuration du transporteur email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER || 'your-email@gmail.com',
        pass: process.env.EMAIL_PASS || 'your-app-password'
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER || 'your-email@gmail.com',
      to: employee.email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px;">
            <h2 style="color: #00FF88; border-bottom: 2px solid #00FF88; padding-bottom: 10px;">
              Message de CENTER App
            </h2>
            <div style="margin-top: 20px; line-height: 1.6; color: #333;">
              ${message.replace(/\n/g, '<br>')}
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px;">
              <p>Ce message a été envoyé depuis l'application CENTER.</p>
            </div>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    
    res.json({ 
      message: 'Email envoyé avec succès',
      to: employee.email 
    });
  } catch (err) {
    console.error('Erreur envoi email:', err);
    res.status(500).json({ 
      message: 'Erreur lors de l\'envoi de l\'email',
      error: err.message 
    });
  }
});

// Générer un lien WhatsApp pour contacter un employé
app.get('/api/employees/:id/whatsapp-link', verifyToken, async (req, res) => {
  try {
    const { message } = req.query;
    const employee = await Employee.findById(req.params.id);
    
    if (!employee) {
      return res.status(404).json({ message: 'Employé non trouvé' });
    }

    if (!employee.phone) {
      return res.status(400).json({ message: 'L\'employé n\'a pas de numéro de téléphone' });
    }

    // Nettoyer le numéro de téléphone (enlever espaces, tirets, etc.)
    let cleanPhone = employee.phone.replace(/[\s\-\(\)]/g, '');
    
    // Si le numéro commence par 0, remplacer par l'indicatif pays (exemple: +237 pour Cameroun)
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '237' + cleanPhone.substring(1);
    }
    
    // Si pas d'indicatif, ajouter +237 par défaut
    if (!cleanPhone.startsWith('+') && !cleanPhone.startsWith('237')) {
      cleanPhone = '237' + cleanPhone;
    }

    // Construire le lien WhatsApp
    const defaultMessage = message || `Bonjour ${employee.name}, je vous contacte depuis l'application CENTER.`;
    const encodedMessage = encodeURIComponent(defaultMessage);
    const whatsappLink = `https://wa.me/${cleanPhone}?text=${encodedMessage}`;
    
    res.json({ 
      whatsappLink,
      phone: employee.phone,
      cleanPhone,
      message: defaultMessage
    });
  } catch (err) {
    console.error('Erreur génération lien WhatsApp:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la génération du lien WhatsApp',
      error: err.message 
    });
  }
});

// Initier un appel téléphonique (retourne le numéro)
app.get('/api/employees/:id/call', verifyToken, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    
    if (!employee) {
      return res.status(404).json({ message: 'Employé non trouvé' });
    }

    if (!employee.phone) {
      return res.status(400).json({ message: 'L\'employé n\'a pas de numéro de téléphone' });
    }

    res.json({ 
      phone: employee.phone,
      name: employee.name,
      callUri: `tel:${employee.phone}` 
    });
  } catch (err) {
    console.error('Erreur récupération téléphone:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération du numéro',
      error: err.message 
    });
  }
});

// ============= ROUTES STATISTIQUES =============

// Récupérer statistiques globales
app.get('/api/statistics/overview', verifyToken, async (req, res) => {
  try {
    const employees = await Employee.find();
    
    const totalEmployees = employees.length;
    const onlineEmployees = employees.filter(e => e.status === 'online').length;
    const offlineEmployees = employees.filter(e => e.status === 'offline').length;
    const awayEmployees = employees.filter(e => e.status === 'away').length;
    
    // Statistiques par département
    const departmentStats = {};
    employees.forEach(emp => {
      const dept = emp.department || 'Non défini';
      if (!departmentStats[dept]) {
        departmentStats[dept] = {
          total: 0,
          online: 0,
          offline: 0,
          away: 0
        };
      }
      departmentStats[dept].total++;
      if (emp.status === 'online') departmentStats[dept].online++;
      if (emp.status === 'offline') departmentStats[dept].offline++;
      if (emp.status === 'away') departmentStats[dept].away++;
    });
    
    // Statistiques par rôle
    const roleStats = {};
    employees.forEach(emp => {
      const role = emp.role || 'Non défini';
      roleStats[role] = (roleStats[role] || 0) + 1;
    });
    
    // Employés avec géolocalisation
    const employeesWithLocation = employees.filter(e => 
      e.location && e.location.latitude && e.location.longitude
    ).length;
    
    // Statistiques de présence (dernières 24h)
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentlyActive = employees.filter(e => 
      e.lastSeen && new Date(e.lastSeen) > last24h
    ).length;

    // ✅ Ajouter les statistiques des publications avec géolocalisation
    const totalPublications = await Publication.countDocuments({ isActive: true });
    const publicationsWithLocation = await Publication.countDocuments({
      isActive: true,
      'location.latitude': { $exists: true, $ne: null },
      'location.longitude': { $exists: true, $ne: null }
    });

    res.json({
      success: true,
      statistics: {
        total: totalEmployees,
        online: onlineEmployees,
        offline: offlineEmployees,
        away: awayEmployees,
        departments: Object.keys(departmentStats).length,
        departmentStats,
        roleStats,
        withLocation: employeesWithLocation,
        recentlyActive,
        activeRate: totalEmployees > 0 ? ((onlineEmployees / totalEmployees) * 100).toFixed(1) : 0,
        locationRate: totalEmployees > 0 ? ((employeesWithLocation / totalEmployees) * 100).toFixed(1) : 0,
        // Statistiques des publications
        publications: {
          total: totalPublications,
          withLocation: publicationsWithLocation,
          locationRate: totalPublications > 0 ? ((publicationsWithLocation / totalPublications) * 100).toFixed(1) : '0'
        }
      }
    });
  } catch (err) {
    console.error('Erreur récupération statistiques:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des statistiques',
      error: err.message 
    });
  }
});

// Récupérer géolocalisation de tous les employés
app.get('/api/statistics/geolocation', verifyToken, async (req, res) => {
  try {
    const employees = await Employee.find({
      'location.latitude': { $exists: true },
      'location.longitude': { $exists: true }
    }).select('firstName lastName department role status location faceImage avatar');
    
    const locationsData = employees.map(emp => ({
      id: emp._id,
      name: `${emp.firstName} ${emp.lastName}`,
      department: emp.department,
      role: emp.role,
      status: emp.status,
      image: emp.faceImage || emp.avatar,
      location: {
        latitude: emp.location.latitude,
        longitude: emp.location.longitude,
        address: emp.location.address || 'Adresse non disponible',
        lastUpdate: emp.location.lastUpdate || emp.lastSeen
      }
    }));

    res.json({
      success: true,
      total: locationsData.length,
      locations: locationsData
    });
  } catch (err) {
    console.error('Erreur récupération géolocalisation:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des données de géolocalisation',
      error: err.message 
    });
  }
});

// Récupérer détails des employés en ligne
app.get('/api/statistics/online-employees', verifyToken, async (req, res) => {
  try {
    const employees = await Employee.find({ status: 'online' })
      .select('firstName lastName department role email phone faceImage avatar lastSeen location')
      .sort({ lastSeen: -1 });
    
    res.json({
      success: true,
      total: employees.length,
      employees: employees.map(emp => ({
        id: emp._id,
        name: `${emp.firstName} ${emp.lastName}`,
        department: emp.department,
        role: emp.role,
        email: emp.email,
        phone: emp.phone,
        image: emp.faceImage || emp.avatar,
        lastSeen: emp.lastSeen,
        hasLocation: !!(emp.location?.latitude && emp.location?.longitude)
      }))
    });
  } catch (err) {
    console.error('Erreur récupération employés en ligne:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des employés en ligne',
      error: err.message 
    });
  }
});

// Récupérer statistiques détaillées par département
app.get('/api/statistics/departments-details', verifyToken, async (req, res) => {
  try {
    const employees = await Employee.find()
      .select('firstName lastName department role status faceImage avatar');
    
    const departmentDetails = {};
    
    employees.forEach(emp => {
      const dept = emp.department || 'Non défini';
      if (!departmentDetails[dept]) {
        departmentDetails[dept] = {
          name: dept,
          total: 0,
          online: 0,
          offline: 0,
          away: 0,
          employees: [],
          roles: {}
        };
      }
      
      departmentDetails[dept].total++;
      if (emp.status === 'online') departmentDetails[dept].online++;
      if (emp.status === 'offline') departmentDetails[dept].offline++;
      if (emp.status === 'away') departmentDetails[dept].away++;
      
      departmentDetails[dept].employees.push({
        id: emp._id,
        name: `${emp.firstName} ${emp.lastName}`,
        role: emp.role,
        status: emp.status,
        image: emp.faceImage || emp.avatar
      });
      
      const role = emp.role || 'Non défini';
      departmentDetails[dept].roles[role] = (departmentDetails[dept].roles[role] || 0) + 1;
    });
    
    const departmentsArray = Object.values(departmentDetails).sort((a, b) => b.total - a.total);

    res.json({
      success: true,
      total: departmentsArray.length,
      departments: departmentsArray
    });
  } catch (err) {
    console.error('Erreur récupération détails départements:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des détails des départements',
      error: err.message 
    });
  }
});

// ✅ NOUVELLE ROUTE - Mettre à jour la position GPS d'un employé
app.put('/api/employees/:id/location', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, address } = req.body;

    console.log(`📍 Mise à jour position employé ${id}:`, { latitude, longitude, address });

    // Validation des coordonnées
    if (!latitude || !longitude) {
      return res.status(400).json({
        message: 'Latitude et longitude sont requis'
      });
    }

    if (latitude < -90 || latitude > 90) {
      return res.status(400).json({
        message: 'Latitude invalide (doit être entre -90 et 90)'
      });
    }

    if (longitude < -180 || longitude > 180) {
      return res.status(400).json({
        message: 'Longitude invalide (doit être entre -180 et 180)'
      });
    }

    const employee = await Employee.findByIdAndUpdate(
      id,
      {
        $set: {
          'location.latitude': parseFloat(latitude),
          'location.longitude': parseFloat(longitude),
          'location.address': address || 'Adresse non disponible',
          'location.lastUpdate': new Date()
        }
      },
      { new: true, runValidators: true }
    );

    if (!employee) {
      return res.status(404).json({
        message: 'Employé non trouvé'
      });
    }

    console.log(`✅ Position mise à jour pour ${employee.firstName} ${employee.lastName}`);

    res.json({
      success: true,
      message: 'Position mise à jour avec succès',
      employee: {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        location: employee.location
      }
    });
  } catch (err) {
    console.error('❌ Erreur mise à jour position:', err);
    res.status(500).json({
      message: 'Erreur lors de la mise à jour de la position',
      error: err.message
    });
  }
});

// ============= ROUTES STORIES =============

// Récupérer toutes les stories (dernières 24h)
app.get('/api/stories', verifyToken, async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const stories = await Story.find({
      createdAt: { $gte: twentyFourHoursAgo }
    })
      .populate('userId', 'name email profileImage')
      .sort({ createdAt: -1 });

    // Marquer les stories comme vues par l'utilisateur actuel
    const viewedStories = stories.map(story => {
      const isViewed = story.viewedBy?.some(v => v.toString() === req.user.userId);
      return {
        _id: story._id,
        content: story.content,
        mediaUrl: story.mediaUrl,
        mediaType: story.mediaType,
        backgroundColor: story.backgroundColor,
        userId: story.userId._id, // ID du propriétaire pour vérification ownership
        user: {
          _id: story.userId._id,
          name: story.userId.name,
          email: story.userId.email,
          profileImage: story.userId.profileImage
        },
        createdAt: story.createdAt,
        expiresAt: story.expiresAt,
        viewCount: story.views?.length || story.viewedBy?.length || 0,
        isViewed: isViewed,
        viewedBy: story.viewedBy || []
      };
    });

    res.json({
      success: true,
      stories: viewedStories,
      total: viewedStories.length
    });
  } catch (err) {
    console.error('Erreur récupération stories:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des stories',
      error: err.message 
    });
  }
});

// Créer une nouvelle story
app.post('/api/stories', verifyToken, storyUpload.single('media'), async (req, res) => {
  try {
    console.log('\n=== CRÉATION STORY (Cloudinary) ===');
    console.log('Body:', req.body);
    console.log('File:', req.file);
    
    const { content, backgroundColor, duration, mediaType: bodyMediaType } = req.body;
    
    let mediaUrl = null;
    let mediaType = 'text';
    let cloudinaryPublicId = null;

    if (req.file) {
      // Utiliser l'URL Cloudinary directement
      mediaUrl = req.file.path; // URL complète Cloudinary
      cloudinaryPublicId = req.file.filename; // Public ID pour suppression
      
      // Détection du type de média
      console.log('📹 MIME type du fichier:', req.file.mimetype);
      console.log('📁 Extension du fichier:', req.file.originalname.split('.').pop());
      
      if (req.file.mimetype.startsWith('video/')) {
        mediaType = 'video';
        console.log('✅ Détecté comme VIDÉO');
      } else if (req.file.mimetype.startsWith('image/')) {
        mediaType = 'image';
        console.log('✅ Détecté comme IMAGE');
      } else {
        // Fallback sur l'extension si MIME type n'est pas clair
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
          mediaType = 'video';
          console.log('✅ Détecté comme VIDÉO (par extension)');
        } else {
          mediaType = 'image';
          console.log('✅ Détecté comme IMAGE (par extension)');
        }
      }
      
      console.log('✅ Fichier uploadé sur Cloudinary:', mediaUrl);
      console.log('🆔 Public ID:', cloudinaryPublicId);
      console.log('📊 Type final:', mediaType);
    } else if (bodyMediaType) {
      mediaType = bodyMediaType;
    }

    const newStory = new Story({
      userId: req.user.userId,
      content: content || '',
      mediaUrl,
      mediaType,
      cloudinaryPublicId, // Stocker pour suppression future
      backgroundColor: backgroundColor || '#00D4FF',
      duration: parseInt(duration) || 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
    });

    await newStory.save();
    console.log('✅ Story sauvegardée:', newStory._id);

    const populatedStory = await Story.findById(newStory._id)
      .populate('userId', 'firstName lastName faceImage avatar email');

    // Vérifier que l'utilisateur existe et a été populé
    if (!populatedStory.userId) {
      console.error('❌ Utilisateur non trouvé pour la story');
      return res.status(500).json({ 
        message: 'Erreur lors de la récupération des informations utilisateur',
        error: 'User not found'
      });
    }

    // Notifier via WebSocket
    const storyData = {
      type: 'new_story',
      story: {
        _id: populatedStory._id,
        content: populatedStory.content,
        mediaUrl: populatedStory.mediaUrl,
        mediaType: populatedStory.mediaType,
        backgroundColor: populatedStory.backgroundColor,
        duration: populatedStory.duration,
        userId: {
          _id: populatedStory.userId._id,
          firstName: populatedStory.userId.firstName || '',
          lastName: populatedStory.userId.lastName || '',
          email: populatedStory.userId.email || '',
          faceImage: populatedStory.userId.faceImage || null,
          avatar: populatedStory.userId.avatar || null
        },
        createdAt: populatedStory.createdAt,
        expiresAt: populatedStory.expiresAt
      }
    };
    
    broadcastToAll(storyData);

    res.status(201).json({
      success: true,
      message: 'Story créée avec succès',
      story: storyData.story
    });
  } catch (err) {
    console.error('Erreur création story:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la création de la story',
      error: err.message 
    });
  }
});

// Marquer une story comme vue
app.post('/api/stories/:id/view', verifyToken, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    
    if (!story) {
      return res.status(404).json({ message: 'Story non trouvée' });
    }

    // Vérifier si déjà vu
    const alreadyViewed = story.viewedBy.includes(req.user.userId);
    
    if (!alreadyViewed) {
      story.viewedBy.push(req.user.userId);
      story.views.push({
        userId: req.user.userId,
        viewedAt: new Date()
      });
      await story.save();
    }

    res.json({
      success: true,
      message: 'Story marquée comme vue',
      viewCount: story.viewedBy.length,
      alreadyViewed
    });
  } catch (err) {
    console.error('Erreur marquage vue story:', err);
    res.status(500).json({ 
      message: 'Erreur lors du marquage de la story',
      error: err.message 
    });
  }
});

// Récupérer les vues d'une story avec les profils des utilisateurs
app.get('/api/stories/:id/views', verifyToken, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id)
      .populate({
        path: 'views.userId',
        select: 'name email profilePicture role department'
      });
    
    if (!story) {
      return res.status(404).json({ message: 'Story non trouvée' });
    }

    // Vérifier que c'est l'auteur de la story
    if (story.userId.toString() !== req.user.userId) {
      return res.status(403).json({ 
        message: 'Seul l\'auteur peut voir qui a vu sa story' 
      });
    }

    res.json({
      success: true,
      viewCount: story.views.length,
      viewers: story.views.map(view => ({
        id: view.userId._id,
        name: view.userId.name,
        email: view.userId.email,
        profilePicture: view.userId.profilePicture,
        role: view.userId.role,
        department: view.userId.department,
        viewedAt: view.viewedAt
      }))
    });
  } catch (err) {
    console.error('Erreur récupération vues story:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la récupération des vues',
      error: err.message 
    });
  }
});

// Supprimer une story
app.delete('/api/stories/:id', verifyToken, async (req, res) => {
  try {
    console.log('\n=== SUPPRESSION STORY ===');
    console.log('Story ID:', req.params.id);
    console.log('User ID:', req.user.userId);

    const story = await Story.findById(req.params.id);
    
    if (!story) {
      return res.status(404).json({ message: 'Story non trouvée' });
    }

    // Vérifier que c'est l'auteur de la story
    if (story.userId.toString() !== req.user.userId) {
      return res.status(403).json({ 
        message: 'Seul l\'auteur peut supprimer sa story' 
      });
    }

    // Supprimer le média de Cloudinary si présent
    if (story.cloudinaryPublicId) {
      try {
        console.log('🗑️ Suppression du média Cloudinary:', story.cloudinaryPublicId);
        await deleteFromCloudinary(story.cloudinaryPublicId);
        console.log('✅ Média supprimé de Cloudinary');
      } catch (cloudinaryError) {
        console.error('❌ Erreur suppression Cloudinary:', cloudinaryError);
        // Ne pas bloquer la suppression de la story si Cloudinary échoue
      }
    }

    // Supprimer la story de la base de données
    await Story.findByIdAndDelete(req.params.id);
    console.log('✅ Story supprimée de la base de données');

    // Notifier via WebSocket que la story a été supprimée
    broadcastToAll({
      type: 'story_deleted',
      storyId: req.params.id,
      userId: req.user.userId
    });

    res.json({
      success: true,
      message: 'Story supprimée avec succès'
    });
  } catch (err) {
    console.error('Erreur suppression story:', err);
    res.status(500).json({ 
      message: 'Erreur lors de la suppression de la story',
      error: err.message 
    });
  }
});

// ========================================
// ROUTES : GROUP CHAT
// ========================================

// Récupérer les messages du group chat général
app.get('/api/chat/groups/general/messages', verifyToken, async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION MESSAGES GROUP CHAT ===');
    console.log('User ID:', req.user.userId);

    // Pour l'instant, on utilise la collection Message existante avec un champ spécial pour les messages de groupe
    // Plus tard, on pourra créer une collection séparée pour les messages de groupe
    const messages = await Message.find({
      // Messages de groupe général (on peut utiliser un champ spécial ou une logique différente)
      $or: [
        // Messages envoyés au groupe général
        { receiverId: 'general_group' },
        // Ou messages marqués comme groupe
        { isGroupMessage: true, groupId: 'general' }
      ]
    })
    .populate('senderId', 'name email profileImage')
    .sort({ createdAt: 1 }) // Ordre chronologique
    .limit(100); // Limiter aux 100 derniers messages

    const messagesData = messages.map(msg => ({
      _id: msg._id,
      content: msg.content,
      senderId: msg.senderId,
      sender: {
        _id: msg.senderId._id,
        name: msg.senderId.name || msg.senderId.email.split('@')[0],
        email: msg.senderId.email,
        profileImage: msg.senderId.profileImage
      },
      createdAt: msg.createdAt,
      type: 'group_message'
    }));

    console.log(`✅ ${messagesData.length} messages de group chat trouvés`);

    res.json({
      success: true,
      messages: messagesData
    });
  } catch (error) {
    console.error('❌ Erreur récupération messages group chat:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur'
    });
  }
});

// Récupérer les utilisateurs en ligne pour le group chat
app.get('/api/chat/groups/general/online', verifyToken, async (req, res) => {
  try {
    console.log('\n=== RÉCUPÉRATION UTILISATEURS EN LIGNE GROUP CHAT ===');
    console.log('User ID:', req.user.userId);

    // Pour l'instant, retourner tous les utilisateurs actifs/admins
    // Plus tard, on pourra implémenter un système de présence en temps réel
    const onlineUsers = await User.find({
      status: { $in: ['active', 'admin'] }
    })
    .select('name email profileImage status lastSeen')
    .sort({ name: 1 });

    const onlineUsersData = onlineUsers.map(user => ({
      _id: user._id,
      name: user.name || user.email.split('@')[0],
      email: user.email,
      profileImage: user.profileImage,
      status: user.status,
      isOnline: true, // Pour l'instant, tous sont considérés en ligne
      lastSeen: user.lastSeen || new Date()
    }));

    console.log(`✅ ${onlineUsersData.length} utilisateurs en ligne trouvés`);

    res.json({
      success: true,
      onlineUsers: onlineUsersData
    });
  } catch (error) {
    console.error('❌ Erreur récupération utilisateurs en ligne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur'
    });
  }
});

// Envoyer un message dans le group chat général
app.post('/api/chat/groups/general/messages', verifyToken, async (req, res) => {
  try {
    console.log('\n=== ENVOI MESSAGE GROUP CHAT ===');
    console.log('User ID:', req.user.userId);
    console.log('Content:', req.body.content?.substring(0, 50) + '...');

    const { content } = req.body;

    if (!content?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contenu du message requis'
      });
    }

    // Créer un message de groupe en utilisant la collection Message existante
    const groupMessage = new Message({
      senderId: req.user.userId,
      receiverId: 'general_group', // Identifiant spécial pour le groupe général
      content: content.trim(),
      isGroupMessage: true,
      groupId: 'general',
      createdAt: new Date()
    });

    await groupMessage.save();

    // Populate pour retourner les données complètes
    await groupMessage.populate('senderId', 'name email profileImage');

    const messageData = {
      _id: groupMessage._id,
      content: groupMessage.content,
      senderId: groupMessage.senderId,
      sender: {
        _id: groupMessage.senderId._id,
        name: groupMessage.senderId.name || groupMessage.senderId.email.split('@')[0],
        email: groupMessage.senderId.email,
        profileImage: groupMessage.senderId.profileImage
      },
      createdAt: groupMessage.createdAt,
      type: 'group_message'
    };

    console.log('✅ Message de group chat envoyé:', groupMessage._id);

    // Diffuser le message via WebSocket à tous les utilisateurs connectés
    broadcastToAll({
      type: 'group_message',
      message: messageData
    });

    res.status(201).json({
      success: true,
      message: 'Message envoyé dans le group chat',
      messageData: messageData
    });
  } catch (error) {
    console.error('❌ Erreur envoi message group chat:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur'
    });
  }
});