/**
 * Script pour créer un utilisateur de test pour les tests de cartes d'identité
 */

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function createTestUser() {
  try {
    console.log('🔧 Création d\'un utilisateur de test...');

    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGO_URI);

    // Définition du schéma User
    const userSchema = new mongoose.Schema({
      email: { type: String, required: true, unique: true },
      password: { type: String, required: true },
      name: { type: String },
      status: { type: String, default: 'active' },
      role: { type: String, default: 'user' },
      profileImage: { type: String },
      otp: { type: String },
      otpExpires: { type: Date },
      isVerified: { type: Boolean, default: false },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    });

    const User = mongoose.model('User', userSchema);

    // Vérifier si l'utilisateur de test existe déjà
    const existingUser = await User.findOne({ email: 'test@example.com' });

    if (existingUser) {
      console.log('✅ Utilisateur de test existe déjà');
      console.log('📧 Email: test@example.com');
      console.log('🔑 Mot de passe: testpassword123');
      return;
    }

    // Créer un mot de passe hashé
    const hashedPassword = await bcrypt.hash('testpassword123', 10);

    // Créer l'utilisateur de test
    const testUser = new User({
      email: 'test@example.com',
      password: hashedPassword,
      name: 'Test User',
      status: 'active',
      role: 'user',
      isVerified: true
    });

    await testUser.save();

    console.log('✅ Utilisateur de test créé avec succès !');
    console.log('📧 Email: test@example.com');
    console.log('🔑 Mot de passe: testpassword123');
    console.log('🆔 ID:', testUser._id);

  } catch (error) {
    console.error('❌ Erreur lors de la création de l\'utilisateur de test:', error.message);
  } finally {
    await mongoose.connection.close();
  }
}

// Exécuter si appelé directement
if (require.main === module) {
  createTestUser();
}

module.exports = { createTestUser };