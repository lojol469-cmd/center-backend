"""
🤖 API CHAT AGENT MULTIMODAL AVEC FAISS
========================================

API REST pour un agent de chat intelligent capable d'analyser:
- Images (JPEG, PNG, WebP)
- PDFs (extraction de texte et images)
- Documents texte

Utilise FAISS pour la recherche vectorielle et tous les modèles IA disponibles.

Auteur: BelikanM
Date: 13 Novembre 2025
"""

import os
import sys
import logging
import socket
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import json
import base64
import io
from dotenv import load_dotenv

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import uvicorn

# Imports pour traitement
from PIL import Image
import PyPDF2
import fitz  # PyMuPDF pour extraction d'images des PDFs
import numpy as np

# Imports IA
from sentence_transformers import SentenceTransformer
import faiss

# Charger variables d'environnement
load_dotenv(Path(__file__).parent / "models" / ".env")

# Ajouter le chemin des modèles
sys.path.append(str(Path(__file__).parent / "models"))
from unified_agent import UnifiedAgent

# Configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Import DuckDuckGo pour recherche internet (gratuit, sans clé API)
try:
    from ddgs import DDGS
    _ddgs_test = DDGS()
    WEB_SEARCH_AVAILABLE = True
    logger.info("✅ DuckDuckGo Search initialisé (gratuit, sans clé API)")
except Exception as e:
    WEB_SEARCH_AVAILABLE = False
    logger.warning(f"⚠️ DuckDuckGo Search non disponible: {e}")

def _duckduckgo_search(query: str, max_results: int = 5) -> list:
    """Recherche web via DuckDuckGo (gratuit, sans clé API)."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return results
    except Exception as e:
        logger.warning(f"⚠️ DuckDuckGo search échouée: {e}")
        return []

# Configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ==========================================
# 10 PROMPTS PUISSANTS POUR KIBALI AGENT
# ==========================================

SYSTEM_PROMPT = """Tu es Kibali Enfant Agent, un assistant IA ultra-puissant créé par Nyundu Francis Arnaud. 
Tu es expert en vision par ordinateur, raisonnement avancé, et recherche d'informations. 
Tu réponds de manière concise, précise et rapide. Maximum 3-4 phrases par réponse sauf si demandé autrement."""

VISION_PROMPT = """Analyse cette image avec précision. Décris les objets, personnes, couleurs, actions et contexte 
de manière détaillée mais concise. Si c'est une interface, explique chaque élément visible."""

REASONING_PROMPT = """Raisonne étape par étape. Décompose le problème, analyse les options, 
et donne une réponse logique et structurée. Sois concis mais complet."""

SEARCH_PROMPT = """Recherche des informations précises et récentes sur ce sujet. 
Utilise DuckDuckGo pour trouver des sources fiables. Résume les points clés en 3-5 phrases maximum."""

EXPLAIN_APP_PROMPT = """Tu es un guide expert de l'application CENTER. 
L'application CENTER est une plateforme de gestion d'employés avec:
- 👤 Gestion des profils employés (photos, informations)
- 🤖 Chat intelligent avec Kibali Agent (IA multimodale)
- 📸 Reconnaissance faciale pour pointage
- 📊 Tableau de bord et statistiques
- 🔐 Authentification sécurisée

Explique clairement et simplement comment utiliser les fonctionnalités. 
Donne des instructions étape par étape si nécessaire."""

TECHNICAL_PROMPT = """Tu es un expert technique. Explique les concepts de manière claire 
avec des exemples concrets. Adapte ton niveau selon l'utilisateur."""

CREATIVE_PROMPT = """Génère du contenu créatif et original. Sois innovant dans tes propositions 
tout en restant pertinent et utile."""

PROBLEM_SOLVING_PROMPT = """Analyse le problème, identifie les causes possibles, 
et propose des solutions concrètes et applicables immédiatement."""

SUMMARIZATION_PROMPT = """Résume l'information en gardant uniquement les points essentiels. 
Sois ultra-concis : maximum 3-4 phrases pour tout résumé."""

CONVERSATION_PROMPT = """Maintiens une conversation naturelle et engageante. 
Pose des questions de clarification si nécessaire. Sois amical mais professionnel."""

# Paramètres de performance optimisés
MAX_TOKENS_FAST = 150  # Réponses rapides
MAX_TOKENS_NORMAL = 300  # Réponses standard
TEMPERATURE_PRECISE = 0.3  # Précis et factuel
TEMPERATURE_BALANCED = 0.7  # Équilibré

# ==========================================
# DÉTECTION AUTOMATIQUE DE L'IP
# ==========================================

def get_local_ip():
    """Détecte l'IP locale du réseau"""
    try:
        # Créer une socket pour obtenir l'IP locale
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        return "127.0.0.1"

app = FastAPI(title="Chat Agent API", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# MODÈLES PYDANTIC
# ==========================================

class ChatMessage(BaseModel):
    role: str  # 'user' ou 'assistant'
    content: str
    images: Optional[List[str]] = None  # URLs ou base64
    timestamp: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    use_vision: bool = True
    use_memory: bool = True
    temperature: float = 0.7

class ChatResponse(BaseModel):
    response: str
    conversation_id: str
    sources: Optional[List[Dict[str, Any]]] = None
    reasoning: Optional[str] = None
    timestamp: str

# ==========================================
# GESTIONNAIRE DE MÉMOIRE VECTORIELLE FAISS
# ==========================================

class FAISSMemoryManager:
    """Gestionnaire de mémoire avec FAISS pour recherche vectorielle"""
    
    def __init__(self, embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        try:
            # Résoudre le chemin local du modèle (snapshot HuggingFace)
            _local_cache = Path(__file__).parent.parent / "frontend-center" / "models--sentence-transformers--all-MiniLM-L6-v2"
            _resolved_path = embedding_model
            if _local_cache.is_dir():
                _snapshots = list((_local_cache / "snapshots").iterdir()) if (_local_cache / "snapshots").is_dir() else []
                if _snapshots:
                    _resolved_path = str(sorted(_snapshots)[-1])
                    logger.info(f"📂 SentenceTransformer local: {_resolved_path}")
            self.embedding_model = SentenceTransformer(_resolved_path, local_files_only=True)
        except Exception as e:
            logger.warning(f"⚠️ Impossible de charger le modèle d'embeddings: {e}")
            logger.info("ℹ️ Fonctionnement sans recherche vectorielle FAISS")
            self.embedding_model = None
        
        self.dimension = 384  # Dimension des embeddings MiniLM
        
        # Index FAISS (IndexFlatL2 pour recherche exacte)
        self.index = faiss.IndexFlatL2(self.dimension) if self.embedding_model else None
        
        # Stockage des métadonnées
        self.documents: List[Dict[str, Any]] = []
        self.document_embeddings: List[np.ndarray] = []
        
        # Conversations
        self.conversations: Dict[str, List[ChatMessage]] = {}
        
        if self.embedding_model:
            logger.info(f"✅ FAISS Memory Manager initialisé (dim={self.dimension})")
        else:
            logger.info("✅ Memory Manager initialisé (mode simple sans FAISS)")
    
    def add_document(
        self,
        text: str,
        metadata: Dict[str, Any],
        doc_type: str = "text"
    ) -> int:
        """Ajouter un document à la mémoire vectorielle"""
        
        if not self.embedding_model:
            # Mode simple : juste stocker sans embeddings
            doc_id = len(self.documents)
            self.documents.append({
                "id": doc_id,
                "text": text,
                "type": doc_type,
                "metadata": metadata,
                "timestamp": datetime.now().isoformat()
            })
            return doc_id
        
        # Mode FAISS : avec embeddings
        # Générer l'embedding
        embedding = self.embedding_model.encode([text])[0]
        
        # Ajouter à FAISS
        self.index.add(np.array([embedding], dtype=np.float32))
        
        # Stocker les métadonnées
        doc_id = len(self.documents)
        self.documents.append({
            "id": doc_id,
            "text": text,
            "type": doc_type,
            "metadata": metadata,
            "timestamp": datetime.now().isoformat()
        })
        self.document_embeddings.append(embedding)
        
        logger.info(f"📄 Document ajouté: {doc_type} (ID: {doc_id})")
        return doc_id
    
    def search(self, query: str, k: int = 5) -> List[Dict[str, Any]]:
        """Rechercher les documents les plus similaires"""
        
        if not self.embedding_model:
            # Mode simple : retourner les derniers documents
            return self.documents[-k:] if self.documents else []
        
        if self.index.ntotal == 0:
            return []
        
        # Générer l'embedding de la requête
        query_embedding = self.embedding_model.encode([query])[0]
        
        # Recherche dans FAISS
        distances, indices = self.index.search(
            np.array([query_embedding], dtype=np.float32),
            min(k, self.index.ntotal)
        )
        
        # Récupérer les documents
        results = []
        for i, idx in enumerate(indices[0]):
            if idx != -1:
                doc = self.documents[idx].copy()
                doc["similarity"] = float(1 / (1 + distances[0][i]))  # Convertir distance en similarité
                results.append(doc)
        
        logger.info(f"🔍 Recherche: {len(results)} résultats pour '{query[:50]}...'")
        return results
    
    def add_to_conversation(self, conv_id: str, message: ChatMessage):
        """Ajouter un message à une conversation"""
        if conv_id not in self.conversations:
            self.conversations[conv_id] = []
        self.conversations[conv_id].append(message)
    
    def get_conversation(self, conv_id: str) -> List[ChatMessage]:
        """Récupérer une conversation"""
        return self.conversations.get(conv_id, [])
    
    def save_to_disk(self, path: str):
        """Sauvegarder l'index FAISS sur disque"""
        faiss.write_index(self.index, f"{path}/faiss.index")
        
        with open(f"{path}/documents.json", "w", encoding="utf-8") as f:
            json.dump(self.documents, f, ensure_ascii=False, indent=2)
        
        logger.info(f"💾 Index FAISS sauvegardé: {path}")
    
    def load_from_disk(self, path: str):
        """Charger l'index FAISS depuis le disque"""
        index_path = f"{path}/faiss.index"
        docs_path = f"{path}/documents.json"
        
        if os.path.exists(index_path):
            self.index = faiss.read_index(index_path)
            logger.info(f"📂 Index FAISS chargé: {self.index.ntotal} vecteurs")
        
        if os.path.exists(docs_path):
            with open(docs_path, "r", encoding="utf-8") as f:
                self.documents = json.load(f)
            logger.info(f"📂 {len(self.documents)} documents chargés")

# ==========================================
# GESTIONNAIRE DE CHAT
# ==========================================

class ChatAgentManager:
    """Gestionnaire principal du chat agent"""
    
    def __init__(self):
        # Désactiver temporairement les modèles lourds pour permettre le démarrage rapide
        self.agent = UnifiedAgent(
            enable_voice=False,
            enable_vision=True,
            enable_detection=False,
            enable_llm=True
        )
        self.memory = FAISSMemoryManager()
        
        # Créer le dossier de stockage
        self.storage_path = Path(__file__).parent / "storage" / "chat_memory"
        self.storage_path.mkdir(parents=True, exist_ok=True)
        
        # Charger la mémoire existante
        self.memory.load_from_disk(str(self.storage_path))
        
        logger.info("✅ Chat Agent Manager initialisé")
    
    def detect_intent(self, message: str) -> str:
        """Détecter l'intention de l'utilisateur"""
        message_lower = message.lower()
        
        # Recherche sur internet
        if any(word in message_lower for word in ["recherche", "cherche", "trouve", "internet", "google", "web"]):
            return "search"
        
        # Explication de l'application
        if any(word in message_lower for word in ["comment", "utiliser", "fonctionner", "faire", "aide", "option", "fonction", "menu"]):
            if any(word in message_lower for word in ["application", "app", "center", "plateforme", "système"]):
                return "explain_app"
        
        # Problème technique
        if any(word in message_lower for word in ["erreur", "bug", "problème", "marche pas", "fonctionne pas"]):
            return "problem_solving"
        
        # Résumé
        if any(word in message_lower for word in ["résume", "résumer", "synthèse", "bref", "court"]):
            return "summarization"
        
        # Créatif
        if any(word in message_lower for word in ["imagine", "crée", "génère", "invente", "idée"]):
            return "creative"
        
        # Par défaut : conversation normale
        return "conversation"
    
    def get_prompt_by_intent(self, intent: str) -> str:
        """Obtenir le prompt approprié selon l'intention"""
        prompts = {
            "search": SEARCH_PROMPT,
            "explain_app": EXPLAIN_APP_PROMPT,
            "problem_solving": PROBLEM_SOLVING_PROMPT,
            "summarization": SUMMARIZATION_PROMPT,
            "creative": CREATIVE_PROMPT,
            "reasoning": REASONING_PROMPT,
            "technical": TECHNICAL_PROMPT,
            "conversation": CONVERSATION_PROMPT
        }
        return prompts.get(intent, CONVERSATION_PROMPT)
    
    async def process_upload(
        self,
        file: UploadFile,
        description: Optional[str] = None
    ) -> Dict[str, Any]:
        """Traiter un fichier uploadé (image ou PDF) - Supporte TOUS les formats"""
        
        file_content = await file.read()
        file_type = file.content_type
        filename = file.filename
        
        results = {"filename": filename, "type": file_type, "documents": []}
        
        try:
            # === DÉTECTION UNIVERSELLE DU TYPE DE FICHIER ===
            original_type = file_type
            
            # Liste complète des extensions d'images supportées
            image_extensions = [
                'jpg', 'jpeg', 'jpe', 'jfif',  # JPEG
                'png', 'apng',                  # PNG
                'gif',                          # GIF
                'bmp', 'dib',                   # Bitmap
                'webp',                         # WebP
                'tiff', 'tif',                  # TIFF
                'svg', 'svgz',                  # SVG
                'ico', 'cur',                   # Icon
                'heic', 'heif',                 # HEIC
                'avif',                         # AVIF
                'psd',                          # Photoshop
                'raw', 'cr2', 'nef', 'arw'     # RAW formats
            ]
            
            # 1. DÉTECTION PAR EXTENSION
            if filename:
                ext = filename.lower().split('.')[-1].replace('-', '').replace('_', '')
                # Extraire l'extension même si le nom contient des tirets ou underscores
                parts = filename.lower().split('.')
                if len(parts) > 1:
                    ext = parts[-1]
                    # Gérer les cas comme "profile-1762679949026-478326994.jpg"
                    if ext in image_extensions:
                        file_type = f"image/{ext.replace('jpeg', 'jpg')}"
                        logger.info(f"📎 Extension détectée: .{ext} → {file_type}")
                    elif ext == 'pdf':
                        file_type = "application/pdf"
                        logger.info(f"📎 Extension PDF détectée")
            
            # 2. DÉTECTION PAR CONTENU (si type générique ou inconnu)
            if file_type in ["application/octet-stream", None, ""] or not file_type.startswith("image/"):
                try:
                    # Essayer d'ouvrir comme image avec PIL
                    test_image = Image.open(io.BytesIO(file_content))
                    detected_format = test_image.format.lower() if test_image.format else "unknown"
                    file_type = f"image/{detected_format}"
                    logger.info(f"📎 Détection par contenu: {detected_format.upper()}")
                    test_image.close()
                except Exception as e:
                    logger.debug(f"Pas une image PIL: {e}")
            
            # 3. ACCEPTER TOUT TYPE COMMENÇANT PAR image/
            if file_type and file_type.startswith("image/"):
                logger.info(f"✅ Type image validé: {file_type}")
            
            logger.info(f"🔍 Type original: {original_type} → Type final: {file_type}")
            
            # === TRAITEMENT IMAGE (TOUS FORMATS) ===
            if file_type and file_type.startswith("image/"):
                try:
                    image = Image.open(io.BytesIO(file_content))
                    
                    # Convertir en RGB si nécessaire (pour PNG avec transparence, etc.)
                    if image.mode in ('RGBA', 'LA', 'P'):
                        background = Image.new('RGB', image.size, (255, 255, 255))
                        if image.mode == 'P':
                            image = image.convert('RGBA')
                        background.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
                        image = background
                        logger.info(f"🔄 Image convertie de {image.mode} en RGB")
                    
                    # Analyser l'image avec SmolVLM + YOLO (si disponibles)
                    logger.info(f"👁️ [Analyse Image] Traitement de l'image: {filename} ({file_type})")
                    
                    # Vérifier si les outils visuels sont disponibles
                    if ("vision" in self.agent.tools and self.agent.tools["vision"].is_ready) or ("detection" in self.agent.tools and self.agent.tools["detection"].is_ready):
                        # Sauvegarder temporairement l'image pour process_image
                        temp_path = Path(__file__).parent / "storage" / "temp" / filename
                        temp_path.parent.mkdir(parents=True, exist_ok=True)
                        image.save(temp_path)
                        
                        # UTILISER TOUS LES OUTILS: SmolVLM + YOLO + Mistral + DuckDuckGo
                        analysis = self.agent.process_image(
                            image_path=str(temp_path),
                            question=description or "Analyse cette image en détail avec tous les objets visibles.",
                            detect_objects=True  # ✅ TOUJOURS ACTIVER YOLO
                        )
                        
                        # Nettoyer le fichier temporaire
                        if temp_path.exists():
                            temp_path.unlink()
                        
                        # Extraire la description depuis le résultat
                        # process_image retourne: {vision: {description: ...}, detection: ..., synthesis: ...}
                        if "error" in analysis:
                            logger.warning(f"⚠️ Erreur analyse IA: {analysis['error']}")
                            # Analyse basique sans IA
                            description_text = f"Image {file_type} de dimensions {image.width}x{image.height} pixels"
                            synthesis_text = f"Image chargée avec succès. Modèles IA temporairement désactivés pour les tests."
                            analysis = {"tools_used": ["Mode Basique"]}
                        else:
                            vision_result = analysis.get("vision", {})
                            description_text = vision_result.get("description", "")
                            synthesis_text = analysis.get("synthesis", "")
                    else:
                        # Mode basique sans modèles IA
                        logger.info("📝 [Mode Basique] Analyse image sans IA")
                        description_text = f"Image {file_type} de dimensions {image.width}x{image.height} pixels"
                        synthesis_text = f"Image chargée avec succès. Modèles IA temporairement désactivés pour permettre les tests de connectivité."
                        analysis = {"tools_used": ["Mode Basique"]}
                    
                    # Combiner vision et synthèse pour FAISS
                    full_description = f"{description_text}\n\nSynthèse: {synthesis_text}" if synthesis_text else description_text
                    
                    # Ajouter à la mémoire FAISS
                    doc_id = self.memory.add_document(
                        text=full_description,
                        metadata={
                            "filename": filename,
                            "type": "image",
                            "format": file_type,
                            "size": len(file_content),
                            "dimensions": f"{image.width}x{image.height}",
                            "vision": vision_result,
                            "synthesis": synthesis_text,
                            "analysis": analysis
                        },
                        doc_type="image"
                    )
                    
                    # AJOUTER LES RÉSULTATS AU FORMAT FLUTTER
                    results["documents"].append({
                        "id": doc_id,
                        "type": "image",
                        "format": file_type,
                        "dimensions": f"{image.width}x{image.height}",
                        "description": description_text,
                        "synthesis": synthesis_text,
                        "analysis": analysis
                    })
                    
                    # AJOUTER AUSSI DIRECTEMENT AU NIVEAU RACINE POUR FLUTTER
                    results["description"] = description_text
                    results["synthesis"] = synthesis_text
                    results["vision"] = vision_result
                    results["detection"] = analysis.get("detection")
                    results["tools_used"] = analysis.get("tools_used", [])
                    results["web_search"] = analysis.get("web_search")
                    
                    logger.info(f"✅ Image analysée: {filename} ({image.width}x{image.height})")
                    image.close()
                    
                except Exception as e:
                    logger.error(f"❌ Erreur traitement image: {e}")
                    raise HTTPException(500, f"Erreur traitement image: {str(e)}")
            
            # === TRAITEMENT PDF AVEC CHUNKING INTELLIGENT POUR RAG ===
            elif file_type == "application/pdf":
                logger.info(f"📄 Traitement PDF RAG: {filename}")
                
                pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_content))
                all_text = ""
                total_chunks = 0
                
                # ÉTAPE 1: Extraire tout le texte
                for page_num, page in enumerate(pdf_reader.pages):
                    text = page.extract_text()
                    if text.strip():
                        all_text += f"\n\n=== Page {page_num + 1} ===\n\n{text}"
                
                logger.info(f"📖 PDF: {len(pdf_reader.pages)} pages, {len(all_text)} caractères")
                
                # ÉTAPE 1.5: Si le PDF n'a pas de texte (PDF scanné), extraire le texte des images
                is_scanned_pdf = len(all_text.strip()) < 100  # Moins de 100 caractères = probablement scanné
                
                if is_scanned_pdf:
                    logger.info(f"🖼️ PDF scanné détecté - Extraction du texte via analyse d'images...")
                    try:
                        pdf_document = fitz.open(stream=file_content, filetype="pdf")
                        
                        # Limiter à 20 pages pour éviter les traitements trop longs
                        max_pages = min(len(pdf_document), 20)
                        logger.info(f"📸 Analyse de {max_pages} pages (sur {len(pdf_document)})...")
                        
                        # Créer un dossier temporaire pour les images
                        temp_dir = Path(__file__).parent / "storage" / "temp"
                        temp_dir.mkdir(parents=True, exist_ok=True)
                        
                        for page_num in range(max_pages):
                            page = pdf_document[page_num]
                            
                            # Convertir la page en image
                            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))  # 2x zoom pour meilleure qualité
                            
                            # Sauvegarder temporairement
                            temp_img_path = temp_dir / f"pdf_page_{page_num}.png"
                            pix.save(str(temp_img_path))
                            
                            # Analyser l'image avec SmolVLM
                            try:
                                if "vision" in self.agent.tools and self.agent.tools["vision"].is_ready:
                                    page_analysis = await self.agent.process_image(
                                        image_path=str(temp_img_path),
                                        query=f"Extrais et décris tout le texte visible sur cette page {page_num + 1}. Décris aussi les schémas, tableaux et éléments visuels importants.",
                                        detect_objects=False  # Pas besoin de YOLO pour du texte
                                    )
                                    
                                    page_text = page_analysis.get("vision", "")
                                    if page_text:
                                        all_text += f"\n\n=== Page {page_num + 1} (analysée visuellement) ===\n\n{page_text}"
                                else:
                                    # Mode basique
                                    logger.info(f"📝 [Mode Basique] Page {page_num + 1} - OCR non disponible")
                                    all_text += f"\n\n=== Page {page_num + 1} (PDF scanné - OCR désactivé) ===\n\n[Texte non extractible - modèles IA temporairement désactivés]"
                                
                                # Nettoyer l'image temporaire
                                if temp_img_path.exists():
                                    temp_img_path.unlink()
                                    
                            except Exception as e:
                                logger.warning(f"⚠️ Erreur analyse page {page_num + 1}: {e}")
                                # Nettoyer même en cas d'erreur
                                if temp_img_path.exists():
                                    temp_img_path.unlink()
                                continue
                        
                        pdf_document.close()
                        logger.info(f"✅ Analyse visuelle complétée: {len(all_text)} caractères extraits")
                        
                    except Exception as e:
                        logger.error(f"❌ Erreur extraction visuelle PDF: {e}")
                
                # ÉTAPE 2: CHUNKING INTELLIGENT (découper en morceaux optimaux)
                if len(all_text.strip()) > 0:
                    chunk_size = 1000  # ~1000 caractères par chunk
                    chunk_overlap = 200  # 200 caractères de chevauchement
                    
                    chunks = []
                    start = 0
                    while start < len(all_text):
                        end = start + chunk_size
                        
                        # Trouver la fin d'une phrase pour ne pas couper au milieu
                        if end < len(all_text):
                            # Chercher le dernier point, point d'exclamation ou point d'interrogation
                            last_period = max(
                                all_text.rfind('.', start, end),
                                all_text.rfind('!', start, end),
                                all_text.rfind('?', start, end),
                                all_text.rfind('\n', start, end)
                            )
                            if last_period != -1 and last_period > start + chunk_size // 2:
                                end = last_period + 1
                        
                        chunk = all_text[start:end].strip()
                        if chunk:
                            chunks.append(chunk)
                        
                        start = end - chunk_overlap  # Chevauchement pour garder le contexte
                    
                    logger.info(f"✂️ PDF découpé en {len(chunks)} chunks intelligents")
                else:
                    logger.warning(f"⚠️ Aucun texte extrait du PDF - Création d'un chunk de métadonnées")
                    chunks = [f"Document PDF: {filename} - {len(pdf_reader.pages)} pages (PDF scanné sans texte extractible)"]
                
                # ÉTAPE 3: Ajouter chaque chunk à FAISS
                for i, chunk in enumerate(chunks):
                    doc_id = self.memory.add_document(
                        text=chunk,
                        metadata={
                            "filename": filename,
                            "chunk_index": i,
                            "total_chunks": len(chunks),
                            "type": "pdf_chunk",
                            "chunk_size": len(chunk)
                        },
                        doc_type="pdf_rag"
                    )
                    
                    total_chunks += 1
                    
                    results["documents"].append({
                        "id": doc_id,
                        "type": "pdf_chunk",
                        "chunk_index": i,
                        "preview": chunk[:150] + "..."
                    })
                
                # ÉTAPE 4: Extraire et analyser les images du PDF (SEULEMENT si ce n'est PAS un PDF scanné)
                # Car si c'est scanné, on a déjà analysé les pages complètes ci-dessus
                if not is_scanned_pdf:
                    try:
                        pdf_document = fitz.open(stream=file_content, filetype="pdf")
                        
                        for page_num in range(min(len(pdf_document), 10)):  # Max 10 pages pour les images
                            page = pdf_document[page_num]
                            images = page.get_images()
                            
                            for img_index, img in enumerate(images[:3]):  # Max 3 images par page
                                try:
                                    xref = img[0]
                                    base_image = pdf_document.extract_image(xref)
                                    image_bytes = base_image["image"]
                                    
                                    # Analyser l'image
                                    if "vision" in self.agent.tools and self.agent.tools["vision"].is_ready:
                                        analysis = await self.agent.process_image(
                                            image_path=str(temp_img_path),
                                            query="Décris cette image extraite d'un document PDF.",
                                            detect_objects=False
                                        )
                                        
                                        vision_desc = analysis.get("vision", "")
                                    else:
                                        # Mode basique
                                        logger.info(f"📝 [Mode Basique] Image PDF {page_num + 1}.{img_index} - analyse désactivée")
                                        vision_desc = f"Image extraite de la page {page_num + 1} du PDF (analyse IA temporairement désactivée)"
                                    
                                    # Nettoyer
                                    if temp_img_path.exists():
                                        temp_img_path.unlink()
                                    
                                    # Ajouter à FAISS seulement si on a une description
                                    if vision_desc:
                                        doc_id = self.memory.add_document(
                                            text=f"Image page {page_num + 1}: {vision_desc}",
                                            metadata={
                                                "filename": filename,
                                                "page": page_num + 1,
                                                "image_index": img_index,
                                                "type": "pdf_image"
                                            },
                                            doc_type="pdf_image"
                                        )
                                        
                                        results["documents"].append({
                                            "id": doc_id,
                                            "type": "pdf_image",
                                            "page": page_num + 1
                                        })
                                        
                                except Exception as e:
                                    logger.warning(f"⚠️ Erreur image PDF page {page_num}: {e}")
                                    continue
                        
                        pdf_document.close()
                    except Exception as e:
                        logger.warning(f"⚠️ Extraction images PDF échouée: {e}")
                
                results["total_pages"] = len(pdf_reader.pages)
                results["total_chunks"] = total_chunks
                results["description"] = f"PDF traité: {len(pdf_reader.pages)} pages, {total_chunks} chunks ajoutés à la base de connaissances"
                results["synthesis"] = f"✅ Document '{filename}' ajouté à votre base de connaissances RAG avec {total_chunks} sections indexées. Vous pouvez maintenant poser des questions sur ce document !"
                
                logger.info(f"✅ PDF RAG traité: {total_chunks} chunks + images indexés")
            
            else:
                raise HTTPException(400, f"Type de fichier non supporté: {file_type}")
            
            # Sauvegarder la mémoire
            self.memory.save_to_disk(str(self.storage_path))
            
        except Exception as e:
            logger.error(f"❌ Erreur traitement fichier: {e}")
            raise HTTPException(500, f"Erreur traitement: {str(e)}")
        
        return results
    
    def chat(
        self,
        message: str,
        conversation_id: str,
        use_memory: bool = True,
        temperature: float = 0.7
    ) -> ChatResponse:
        """
        🔥 CHAT ULTRA-INTELLIGENT - UTILISE TOUS LES OUTILS DISPONIBLES
        
        Pipeline intelligent:
        1. Détection d'intention → Type de réponse nécessaire
        2. FAISS (Mémoire) → Documents/images similaires du passé
        3. DuckDuckGo (Web) → Recherche internet en temps réel si nécessaire
        4. SmolVLM + YOLO → Analyse visuelle si contexte pertinent
        5. Mistral-7B (LLM) → Synthèse intelligente avec tous les outils
        """
        
        # ========================================
        # ÉTAPE 1: DÉTECTION D'INTENTION
        # ========================================
        intent = self.detect_intent(message)
        system_prompt = self.get_prompt_by_intent(intent)
        
        logger.info(f"🎯 Intention détectée: {intent}")
        
        tools_used = []  # Tracer les outils utilisés
        
        # ========================================
        # ÉTAPE 2: RECHERCHE DANS LA MÉMOIRE FAISS
        # ========================================
        relevant_docs = []
        if use_memory:
            logger.info("💾 [FAISS] Recherche dans la mémoire vectorielle...")
            relevant_docs = self.memory.search(message, k=5)  # Augmenté à 5 pour plus de contexte
            if relevant_docs:
                tools_used.append(f"FAISS ({len(relevant_docs)} docs)")
                logger.info(f"   ✓ {len(relevant_docs)} documents pertinents trouvés")
        
        # ========================================
        # ÉTAPE 3: ANALYSE DU BESOIN D'OUTILS VISUELS
        # ========================================
        message_lower = message.lower()
        needs_visual_search = any(keyword in message_lower for keyword in [
            "image", "photo", "voir", "montre", "visuel", "capture",
            "précédent", "dernier", "avant", "historique visuel"
        ])
        
        visual_context = None
        if needs_visual_search and relevant_docs:
            # Chercher des images dans les documents pertinents
            for doc in relevant_docs:
                if doc.get("type") == "image":
                    logger.info("👁️ [SmolVLM] Document visuel trouvé dans FAISS")
                    visual_context = doc.get("metadata", {})
                    tools_used.append("SmolVLM (via FAISS)")
                    break
        
        # ========================================
        # ÉTAPE 4: CONSTRUIRE CONTEXTE MÉMOIRE + STATISTIQUES
        # ========================================
        context = ""
        pdf_chunks_count = 0
        pdf_files = set()
        
        if relevant_docs:
            context = "\n📚 MÉMOIRE CONTEXTUELLE (FAISS):\n"
            for i, doc in enumerate(relevant_docs, 1):
                doc_type = doc.get('type', 'texte')
                doc_text = doc.get('text', '')[:150]
                context += f"{i}. [{doc_type}] {doc_text}...\n"
                
                # Compter les chunks PDF et les fichiers uniques
                if doc_type in ['pdf_rag', 'pdf_chunk']:
                    pdf_chunks_count += 1
                    metadata = doc.get('metadata', {})
                    filename = metadata.get('filename', '')
                    if filename:
                        pdf_files.add(filename)
        
        # ========================================
        # ÉTAPE 5: HISTORIQUE CONVERSATIONNEL
        # ========================================
        history = self.memory.get_conversation(conversation_id)
        history_text = ""
        if history:
            logger.info(f"📜 Historique: {len(history[-2:])} derniers messages")
            for msg in history[-2:]:
                history_text += f"{msg.role}: {msg.content}\n"
        
        # ========================================
        # ÉTAPE 6: RECHERCHE WEB DUCKDUCKGO (Si nécessaire)
        # ========================================
        web_search_context = ""
        
        # Triggers de recherche web élargis
        needs_web_search = (
            intent == "search" or
            any(keyword in message_lower for keyword in [
                "actualité", "news", "aujourd'hui", "récent", "maintenant",
                "qui est", "c'est quoi", "qu'est-ce", "définition",
                "recherche", "trouve", "cherche", "google",
                "dernière", "dernier", "nouveau", "nouvelle",
                "site web", "internet", "en ligne",
                # Ajouter des triggers pour logos/marques
                "logo", "marque", "entreprise", "société", "produit"
            ])
        )
        
        if needs_web_search and WEB_SEARCH_AVAILABLE:
            try:
                logger.info(f"🌐 [DuckDuckGo] Recherche internet: '{message[:60]}...'")
                ddg_results = _duckduckgo_search(message, max_results=5)
                
                if ddg_results:
                    web_search_context = "\n🌐 RECHERCHE INTERNET (DuckDuckGo):\n"
                    for i, result in enumerate(ddg_results[:5], 1):
                        title = result.get('title', 'N/A')
                        content = result.get('body', '')[:200]
                        url = result.get('href', '')
                        web_search_context += f"{i}. {title}\n   {content}...\n   Source: {url}\n\n"
                    
                    tools_used.append(f"DuckDuckGo ({len(ddg_results)} résultats)")
                    logger.info(f"   ✓ {len(ddg_results)} résultats trouvés")
            except Exception as e:
                logger.warning(f"⚠️ Recherche DuckDuckGo échouée: {e}")
        
        # ========================================
        # ÉTAPE 7: CONSTRUIRE PROMPT ENRICHI AVEC TOUS LES OUTILS
        # ========================================
        if intent == "explain_app":
            full_message = f"""{EXPLAIN_APP_PROMPT}

{context}
{web_search_context}

Question: {message}

Réponds en 3-4 phrases claires et pratiques."""
            max_tokens = 150
            temp = 0.3
            
        elif intent == "search" or web_search_context:
            full_message = f"""{SEARCH_PROMPT}

{web_search_context}
{context}

Question: {message}

Résume les informations trouvées en 3-5 phrases."""
            max_tokens = 200
            temp = 0.3
            
        elif intent in ["problem_solving", "summarization"]:
            prompt_map = {
                "problem_solving": PROBLEM_SOLVING_PROMPT,
                "summarization": SUMMARIZATION_PROMPT
            }
            full_message = f"""{prompt_map[intent]}

{context}
{web_search_context}

{message}"""
            max_tokens = 200
            temp = 0.5
            
        else:
            # Conversation normale avec TOUS les contextes disponibles
            full_message = f"""{SYSTEM_PROMPT}

{history_text}
{context}
{web_search_context}

Utilisateur: {message}

Réponds de manière naturelle et concise."""
            max_tokens = 150
            temp = 0.7
        
        # ========================================
        # ÉTAPE 8: GÉNÉRATION AVEC MISTRAL-7B (OU RÉPONSE PAR DÉFAUT)
        # ========================================
        if "llm" in self.agent.tools and self.agent.tools["llm"].is_ready:
            logger.info("🧠 [Mistral-7B] Génération de réponse avec tous les contextes...")
            agent_result = self.agent.chat(
                message=full_message,
                with_voice=False,
                context={
                    "intent": intent,
                    "max_tokens": max_tokens,
                    "temperature": temp,
                    "tools_used": tools_used
                }
            )
            
            response_text = agent_result.get("response", "Aucune réponse générée")
            tools_used.append("Mistral-7B (LLM)")
        else:
            # Réponse par défaut quand les modèles sont désactivés
            logger.info("📝 [Mode Basique] Génération de réponse simple (modèles désactivés)")
            if intent == "explain_app":
                response_text = "L'application CENTER est une plateforme de gestion d'employés avec chat IA, reconnaissance faciale et tableau de bord. Elle permet de gérer les profils employés, faire du pointage automatique et communiquer avec un assistant IA intelligent."
            elif intent == "search":
                response_text = "Fonction de recherche disponible. Les modèles IA sont temporairement désactivés pour permettre les tests de connectivité."
            else:
                response_text = f"Bonjour ! Je suis Kibali, votre assistant IA. Les modèles avancés sont temporairement désactivés pour les tests, mais je peux vous aider avec des réponses de base. Votre message : '{message}'"
            
            tools_used.append("Mode Basique (sans LLM)")
        
        # Ajouter les statistiques PDF si présentes
        if pdf_chunks_count > 0:
            pdf_stats = f"📄 RAG: {pdf_chunks_count} chunks"
            if len(pdf_files) > 0:
                pdf_stats += f" de {len(pdf_files)} PDF"
            tools_used.append(pdf_stats)
            logger.info(f"📊 Statistiques RAG: {pdf_chunks_count} chunks de {len(pdf_files)} PDFs")
        
        # ========================================
        # ÉTAPE 9: MÉMORISATION
        # ========================================
        self.memory.add_to_conversation(
            conversation_id,
            ChatMessage(role="user", content=message, timestamp=datetime.now().isoformat())
        )
        self.memory.add_to_conversation(
            conversation_id,
            ChatMessage(role="assistant", content=response_text, timestamp=datetime.now().isoformat())
        )
        
        # Résumé des outils utilisés
        tools_summary = " + ".join(tools_used)
        logger.info(f"✅ Réponse générée - Outils: {tools_summary}")
        
        # Ajouter un footer avec les statistiques si des PDFs ont été utilisés
        if pdf_chunks_count > 0:
            response_footer = f"\n\n---\n💡 *Réponse basée sur {pdf_chunks_count} section(s) de {len(pdf_files)} document(s) PDF*"
            response_text = response_text + response_footer
        
        return ChatResponse(
            response=response_text,
            conversation_id=conversation_id,
            sources=[{
                "id": doc["id"],
                "type": doc["type"],
                "similarity": doc["similarity"],
                "preview": doc["text"][:100],
                "tool": f"📄 RAG" if doc.get('type') in ['pdf_rag', 'pdf_chunk'] else "FAISS"
            } for doc in relevant_docs] if relevant_docs else None,
            reasoning=f"Outils utilisés: {tools_summary}",
            timestamp=datetime.now().isoformat()
        )

# ==========================================
# INSTANCE GLOBALE
# ==========================================

chat_manager = ChatAgentManager()

# ==========================================
# ROUTES API
# ==========================================

@app.get("/")
async def root():
    """Page d'accueil de l'API"""
    return {
        "name": "Chat Agent API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "upload": "/upload",
            "chat": "/chat",
            "history": "/conversation/{conv_id}",
            "search": "/search",
            "stats": "/stats"
        }
    }

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "ok"}

@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    description: Optional[str] = Form(None)
):
    """
    Upload un fichier (image ou PDF) pour analyse
    
    Le fichier est analysé et ajouté à la mémoire vectorielle FAISS.
    """
    return JSONResponse(content={
        "filename": file.filename,
        "type": file.content_type,
        "description": "Upload temporairement désactivé - modèles IA non chargés",
        "synthesis": "Fonctionnalité disponible une fois les modèles réactivés",
        "documents": []
    })

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Envoyer un message de chat
    
    L'agent utilise FAISS pour rechercher le contexte pertinent
    et génère une réponse intelligente.
    """
    # Générer un ID de conversation si non fourni
    conv_id = request.conversation_id or f"conv_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    # Réponse par défaut
    response_text = f"Bonjour ! Je suis Kibali, votre assistant IA. Les modèles avancés sont temporairement désactivés pour les tests, mais je peux confirmer que votre message a été reçu : '{request.message}'"
    
    return ChatResponse(
        response=response_text,
        conversation_id=conv_id,
        sources=None,
        reasoning="Mode Basique (sans LLM)",
        timestamp=datetime.now().isoformat()
    )

@app.get("/conversation/{conv_id}")
async def get_conversation(conv_id: str):
    """Récupérer l'historique d'une conversation"""
    return {
        "conversation_id": conv_id,
        "messages": [],
        "total": 0,
        "note": "Historique temporairement désactivé - modèles IA non chargés"
    }

@app.post("/search")
async def search_memory(query: str, k: int = 10):
    """Rechercher dans la mémoire vectorielle"""
    return {
        "query": query,
        "results": [],
        "total": 0,
        "note": "Recherche temporairement désactivée - modèles IA non chargés"
    }

@app.get("/stats")
async def get_stats():
    """Statistiques de la mémoire avec détails RAG PDF"""
    return {
        "total_documents": 0,
        "total_vectors": 0,
        "conversations": 0,
        "embedding_dimension": 384,
        "rag_statistics": {
            "pdf_chunks": 0,
            "unique_pdfs": 0,
            "pdf_files": [],
            "images": 0,
            "other_documents": 0
        },
        "note": "Statistiques temporairement désactivées - modèles IA non chargés"
    }

@app.delete("/clear")
async def clear_memory():
    """Effacer toute la mémoire"""
    return {"status": "memory cleared", "note": "Mémoire temporairement désactivée - modèles IA non chargés"}

@app.get("/pdf/{filename}")
async def get_pdf_details(filename: str):
    """Obtenir les détails d'un PDF spécifique"""
    return {
        "filename": filename,
        "total_chunks": 0,
        "total_characters": 0,
        "average_chunk_size": 0,
        "chunks": [],
        "note": "Détails PDF temporairement désactivés - modèles IA non chargés"
    }

# ==========================================
# LANCEMENT
# ==========================================

if __name__ == "__main__":
    local_ip = get_local_ip()
    port = 8001
    
    print(f"""
╔═══════════════════════════════════════════════════════╗
║  🤖 CHAT AGENT API - Multimodal avec FAISS          ║
║  Version 1.0.0                                        ║
║                                                       ║
║  📡 Serveur démarré sur:                             ║
║     - Local:   http://127.0.0.1:{port}                ║
║     - Network: http://{local_ip}:{port}              ║
║                                                       ║
║  🔗 Endpoints disponibles:                           ║
║     - POST /chat       : Discussion avec l'agent    ║
║     - POST /upload     : Upload fichier             ║
║     - GET  /           : Page d'accueil             ║
╚═══════════════════════════════════════════════════════╝

✅ Copiez cette URL dans votre application Flutter:
   http://{local_ip}:{port}
    """)
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info"
    )
