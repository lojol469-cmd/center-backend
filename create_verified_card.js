const mongoose = require('mongoose');
require('dotenv').config();

async function createVerifiedCard() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/center-app');

    const VirtualIDCard = require('./models/VirtualIDCard');
    const User = require('./models/User');

    // Trouver un utilisateur existant
    const user = await User.findOne({}).select('_id name email');
    if (!user) {
      console.log('❌ Aucun utilisateur trouvé');
      process.exit(1);
    }

    console.log(`👤 Utilisateur trouvé: ${user.name} (${user.email})`);

    // Vérifier si l'utilisateur a déjà une carte
    const existingCard = await VirtualIDCard.findOne({ userId: user._id });
    if (existingCard) {
      console.log('📋 Carte existante trouvée, mise à jour...');
      existingCard.verificationStatus = 'verified';
      existingCard.isActive = true;
      await existingCard.save();
      console.log('✅ Carte mise à jour et vérifiée');
    } else {
      console.log('🆕 Création d\'une nouvelle carte vérifiée...');
      const newCard = new VirtualIDCard({
        userId: user._id,
        cardNumber: 'TEST-' + Date.now(),
        verificationStatus: 'verified',
        isActive: true,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 an
        issueDate: new Date(),
        personalInfo: {
          firstName: user.name?.split(' ')[0] || 'Test',
          lastName: user.name?.split(' ')[1] || 'User',
          dateOfBirth: new Date('1990-01-01'),
          nationality: 'Test'
        }
      });
      await newCard.save();
      console.log('✅ Nouvelle carte créée et vérifiée');
    }

    console.log(`🎉 Utilisateur ${user.name} a maintenant une carte d'identité virtuelle vérifiée!`);
    console.log('🔄 Redémarrez l\'app Flutter pour voir le badge de vérification');

    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  }
}

createVerifiedCard();