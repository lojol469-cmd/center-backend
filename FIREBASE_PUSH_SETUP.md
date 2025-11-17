# 🔔 Configuration des Notifications Push Firebase - PRODUCTION

## ✅ Ce qui a été fait

### 1. **Intégration Firebase Admin SDK**
- ✅ Package `firebase-admin` ajouté à `package.json`
- ✅ Initialisation dans `server.js` avec gestion d'erreur
- ✅ Protection des fichiers sensibles dans `.gitignore`

### 2. **Implémentation des Notifications**
- ✅ Fonction `sendPushNotification()` mise à jour avec FCM
- ✅ Support Android et iOS
- ✅ Gestion automatique des tokens invalides
- ✅ Enregistrement en base de données

### 3. **Sécurité**
- ✅ Fichiers JSON Firebase exclus de Git
- ✅ Chemin configuré via variable d'environnement
- ✅ Vérification d'existence du fichier au démarrage

## 🚀 Déploiement en Production

### Sur Render.com

1. **Ajouter la clé Firebase aux fichiers de build** :
   ```bash
   # Dans Render Dashboard > Environment
   # Créer une variable d'environnement
   FIREBASE_SERVICE_ACCOUNT_PATH=./firebase/msdos-6eb64-firebase-adminsdk-fbsvc-4d32384129.json
   ```

2. **Uploader le fichier JSON sur Render** :
   
   **Option A : Via Secret Files (Recommandé)**
   - Dashboard Render → Service → Settings
   - Scroll vers "Secret Files"
   - Add Secret File :
     - **Filename**: `firebase/msdos-6eb64-firebase-adminsdk-fbsvc-4d32384129.json`
     - **Contents**: Copier-coller le contenu du fichier JSON

   **Option B : Via Build Command**
   - Encoder le fichier en base64 localement :
     ```powershell
     $content = Get-Content backend\firebase\msdos-6eb64-firebase-adminsdk-fbsvc-4d32384129.json -Raw
     [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))
     ```
   - Ajouter la variable d'environnement :
     - `FIREBASE_SERVICE_ACCOUNT_BASE64`: (coller le résultat)
   
   - Modifier le Build Command dans Render :
     ```bash
     cd backend && npm install && mkdir -p firebase && echo $FIREBASE_SERVICE_ACCOUNT_BASE64 | base64 -d > firebase/msdos-6eb64-firebase-adminsdk-fbsvc-4d32384129.json
     ```

3. **Redémarrer le service Render**
   - Manual Deploy → Clear build cache & deploy

### Variables d'Environnement Requises

Dans `.env` (local) ou Render Dashboard (production) :

```env
# Firebase Admin SDK
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase/msdos-6eb64-firebase-adminsdk-fbsvc-4d32384129.json

# Existing variables...
PORT=5000
MONGO_URI=mongodb+srv://...
JWT_SECRET=...
# etc.
```

## 🧪 Test des Notifications

### 1. Vérifier l'initialisation
Après le démarrage du serveur, vous devriez voir :
```
✅ Firebase Admin SDK initialisé
   Project ID: msdos-6eb64
```

### 2. Tester l'envoi
```bash
# Test via curl ou Postman
POST http://your-server.com/api/notifications/send
Headers: Authorization: Bearer <token>
Body:
{
  "userId": "USER_ID",
  "title": "Test Notification",
  "body": "Ceci est un test",
  "type": "system",
  "data": {
    "type": "test",
    "testId": "123"
  }
}
```

### 3. Vérifier les logs
En cas de problème, les logs indiqueront :
- ⚠️ Token FCM manquant
- ❌ Erreur FCM avec code d'erreur
- ✅ Notification envoyée avec succès

## 📱 Configuration Côté Flutter

Le côté Flutter doit :
1. Obtenir le token FCM via Firebase Messaging
2. L'envoyer au backend via `POST /api/users/fcm-token`
3. Écouter les notifications en foreground/background

## 🔍 Résolution de Problèmes

### Erreur : "Firebase non initialisé"
- Vérifier que le fichier JSON existe au bon chemin
- Vérifier les permissions du fichier
- Vérifier les logs au démarrage du serveur

### Erreur : "invalid-registration-token"
- Le token FCM est expiré ou invalide
- Le backend le supprime automatiquement
- L'utilisateur doit se reconnecter

### Notifications non reçues
1. Vérifier que l'utilisateur a un `fcmToken` en base
2. Vérifier les logs du serveur
3. Tester avec un token valide connu
4. Vérifier la configuration Firebase Console

## 📊 Monitoring

Les notifications sont :
- ✅ Toujours enregistrées en base de données
- ✅ Envoyées via FCM si Firebase est initialisé
- ✅ Logguées avec détails (succès/erreur)

Console logs à surveiller :
```
✅ Notification enregistrée en DB pour user XXXXX
✅ Notification push envoyée via FCM: projects/msdos-6eb64/...
   User: user@email.com
   Title: Nouveau like
```

## 🔐 Sécurité en Production

✅ **Déjà configuré** :
- Fichiers JSON exclus de Git
- Variables d'environnement pour les chemins
- Validation des tokens FCM
- Gestion des erreurs sans exposer les détails

⚠️ **À faire** :
- Limiter le nombre de notifications par utilisateur/heure
- Ajouter un système de retry pour les échecs FCM
- Logger les métriques d'envoi (succès/échecs)

## 📚 Ressources

- [Firebase Admin SDK Node.js](https://firebase.google.com/docs/admin/setup)
- [FCM Send Messages](https://firebase.google.com/docs/cloud-messaging/send-message)
- [Render Secret Files](https://render.com/docs/configure-environment-variables#secret-files)

---

**Dernière mise à jour** : 17 novembre 2025  
**Status** : ✅ Prêt pour la production
