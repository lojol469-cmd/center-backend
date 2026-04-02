"""
🤖 Kibali Chat Agent API — Hugging Face Space
=============================================
SmolVLM-256M-Instruct + FAISS + DuckDuckGo Search
Port: 7860 (HF Spaces standard)
"""

import os
import sys
import logging
import io
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import json
import numpy as np

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from PIL import Image
import PyPDF2
import fitz

# Importer l'agent SmolVLM (même dossier)
from unified_agent import UnifiedAgent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── DuckDuckGo Search (gratuit, sans clé API) ──────────────────────────────
try:
    from ddgs import DDGS
    WEB_SEARCH_AVAILABLE = True
    logger.info("✅ DuckDuckGo Search disponible")
except Exception as e:
    WEB_SEARCH_AVAILABLE = False
    logger.warning(f"⚠️ DuckDuckGo non disponible: {e}")

def _web_search(query: str, max_results: int = 5) -> list:
    try:
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=max_results))
    except Exception as e:
        logger.warning(f"⚠️ DuckDuckGo search échouée: {e}")
        return []

# ── SentenceTransformer (HF Hub) ───────────────────────────────────────────
try:
    from sentence_transformers import SentenceTransformer
    import faiss
    _st_model_id = os.environ.get("MINILM_MODEL_ID", "sentence-transformers/all-MiniLM-L6-v2")
    _embedding_model = SentenceTransformer(_st_model_id)
    FAISS_AVAILABLE = True
    logger.info(f"✅ SentenceTransformer chargé : {_st_model_id}")
except Exception as e:
    _embedding_model = None
    FAISS_AVAILABLE = False
    logger.warning(f"⚠️ SentenceTransformer non disponible: {e}")

# ── Prompts ────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """Tu es Kibali Enfant Agent, un assistant IA ultra-puissant créé par Nyundu Francis Arnaud.
Tu es expert en vision par ordinateur, raisonnement avancé, et recherche d'informations.
Tu réponds de manière concise, précise et rapide. Maximum 3-4 phrases par réponse sauf si demandé autrement."""

SEARCH_PROMPT = """Recherche des informations précises et récentes sur ce sujet.
Utilise DuckDuckGo pour trouver des sources fiables. Résume les points clés en 3-5 phrases maximum."""

EXPLAIN_APP_PROMPT = """Tu es un guide expert de l'application CENTER SETRAF.
L'application CENTER est une plateforme sociale avec:
- 📱 Feed vidéos et publications (style TikTok)
- 🤖 Chat intelligent avec Kibali Agent (IA multimodale)
- 💰 Wallet Topocoin (TPC) pour boost et pourboires
- 🎬 Studio live streaming RTMP/HLS
- 🔐 Authentification sécurisée
Explique clairement comment utiliser les fonctionnalités."""

PROBLEM_SOLVING_PROMPT = """Analyse le problème, identifie les causes possibles,
et propose des solutions concrètes et applicables immédiatement."""

SUMMARIZATION_PROMPT = """Résume l'information en gardant uniquement les points essentiels.
Sois ultra-concis : maximum 3-4 phrases pour tout résumé."""

CONVERSATION_PROMPT = """Maintiens une conversation naturelle et engageante.
Pose des questions de clarification si nécessaire. Sois amical mais professionnel."""

# ── FAISS Memory ───────────────────────────────────────────────────────────

class FAISSMemoryManager:
    DIM = 384

    def __init__(self):
        self.embedding_model = _embedding_model
        if FAISS_AVAILABLE and self.embedding_model:
            self.index = faiss.IndexFlatL2(self.DIM)
            logger.info("✅ FAISS Memory Manager initialisé")
        else:
            self.index = None
            logger.info("✅ Memory Manager initialisé (mode simple sans FAISS)")

        self.documents: List[Dict[str, Any]] = []
        self.conversations: Dict[str, List] = {}

    def add_document(self, text: str, metadata: Dict[str, Any], doc_type: str = "text") -> int:
        doc_id = len(self.documents)
        self.documents.append({"id": doc_id, "text": text, "type": doc_type, "metadata": metadata, "timestamp": datetime.now().isoformat()})
        if self.embedding_model and self.index is not None:
            emb = self.embedding_model.encode([text])
            self.index.add(np.array(emb, dtype=np.float32))
        return doc_id

    def search(self, query: str, k: int = 5) -> List[Dict[str, Any]]:
        if not self.embedding_model or self.index is None or self.index.ntotal == 0:
            return self.documents[-k:] if self.documents else []
        emb = self.embedding_model.encode([query])
        distances, indices = self.index.search(np.array(emb, dtype=np.float32), min(k, self.index.ntotal))
        results = []
        for i, idx in enumerate(indices[0]):
            if idx != -1:
                doc = self.documents[idx].copy()
                doc["similarity"] = float(1 / (1 + distances[0][i]))
                results.append(doc)
        return results

    def add_to_conversation(self, conv_id: str, message: dict):
        self.conversations.setdefault(conv_id, []).append(message)

    def get_conversation(self, conv_id: str) -> list:
        return self.conversations.get(conv_id, [])

# ── FastAPI app ─────────────────────────────────────────────────────────────

app = FastAPI(title="Kibali Chat Agent API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic models ─────────────────────────────────────────────────────────

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

# ── Initialisation (au démarrage) ──────────────────────────────────────────

memory = FAISSMemoryManager()

logger.info("⏳ Chargement SmolVLM depuis HuggingFace Hub...")
agent = UnifiedAgent(enable_voice=False, enable_vision=True, enable_detection=False, enable_llm=True)
logger.info("✅ Agent SmolVLM initialisé")

# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "name": "Kibali Chat Agent API",
        "version": "2.0.0",
        "status": "running",
        "smolvlm_ready": agent.tools["vision"].is_ready,
        "faiss_ready": FAISS_AVAILABLE,
        "web_search": WEB_SEARCH_AVAILABLE,
        "endpoints": {"/health": "GET", "/chat": "POST", "/upload": "POST", "/stats": "GET"},
    }

@app.get("/health")
async def health():
    return {"status": "ok", "smolvlm": agent.tools["vision"].is_ready}

@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    description: Optional[str] = Form(None),
):
    """Analyse une image ou un PDF avec SmolVLM."""
    file_content = await file.read()
    file_type = file.content_type or ""
    filename = file.filename or "upload"
    results = {"filename": filename, "type": file_type, "documents": []}

    # Détection image par extension
    img_exts = {"jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "heic"}
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext in img_exts:
        file_type = f"image/{ext}"

    if file_type.startswith("image/"):
        try:
            image = Image.open(io.BytesIO(file_content)).convert("RGB")
            question = description or "Analyse cette image en détail avec tous les éléments visibles."

            if agent.tools["vision"].is_ready:
                # Sauvegarder temporairement
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                    image.save(tmp.name)
                    analysis = agent.process_image(image_path=tmp.name, question=question)
                    import os; os.unlink(tmp.name)

                vision_result = analysis.get("vision", {})
                description_text = vision_result.get("description", "")
                synthesis_text = analysis.get("synthesis", "")
            else:
                description_text = f"Image {image.width}x{image.height} chargée. Modèle IA en démarrage..."
                synthesis_text = ""
                vision_result = {}
                analysis = {}

            doc_id = memory.add_document(
                text=f"{description_text}\n{synthesis_text}",
                metadata={"filename": filename, "type": "image", "dimensions": f"{image.width}x{image.height}"},
                doc_type="image",
            )
            results["documents"].append({"id": doc_id, "type": "image", "description": description_text})
            results["description"] = description_text
            results["synthesis"] = synthesis_text
            results["vision"] = vision_result
            image.close()
        except Exception as e:
            raise HTTPException(500, f"Erreur traitement image: {e}")

    elif file_type == "application/pdf":
        try:
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_content))
            all_text = ""
            for i, page in enumerate(pdf_reader.pages):
                text = page.extract_text()
                if text.strip():
                    all_text += f"\n\n=== Page {i+1} ===\n{text}"

            chunk_size, overlap = 1000, 200
            chunks, start = [], 0
            while start < len(all_text):
                end = start + chunk_size
                chunk = all_text[start:end].strip()
                if chunk:
                    chunks.append(chunk)
                start = end - overlap

            for i, chunk in enumerate(chunks):
                doc_id = memory.add_document(
                    text=chunk,
                    metadata={"filename": filename, "chunk_index": i, "total_chunks": len(chunks)},
                    doc_type="pdf_rag",
                )
                results["documents"].append({"id": doc_id, "type": "pdf_chunk", "chunk_index": i, "preview": chunk[:100]})

            results["total_pages"] = len(pdf_reader.pages)
            results["total_chunks"] = len(chunks)
            results["synthesis"] = f"✅ PDF '{filename}' indexé : {len(pdf_reader.pages)} pages, {len(chunks)} sections"
        except Exception as e:
            raise HTTPException(500, f"Erreur traitement PDF: {e}")
    else:
        raise HTTPException(400, f"Type non supporté: {file_type}")

    return JSONResponse(content=results)

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Chat avec Kibali IA + RAG FAISS + DuckDuckGo Search."""
    import uuid
    conv_id = request.conversation_id or str(uuid.uuid4())
    message = request.message
    message_lower = message.lower()
    tools_used = []

    # ── Intention ──
    def detect_intent(msg):
        ml = msg.lower()
        if any(w in ml for w in ["recherche", "cherche", "trouve", "internet", "actualité", "news"]):
            return "search"
        if any(w in ml for w in ["comment utiliser", "application", "center", "fonctionner"]):
            return "explain_app"
        if any(w in ml for w in ["erreur", "bug", "problème", "marche pas"]):
            return "problem_solving"
        if any(w in ml for w in ["résume", "résumer", "bref"]):
            return "summarization"
        return "conversation"

    intent = detect_intent(message)

    # ── FAISS memory ──
    relevant_docs = memory.search(message, k=5) if request.use_memory else []
    if relevant_docs:
        tools_used.append(f"FAISS ({len(relevant_docs)} docs)")

    context_text = ""
    if relevant_docs:
        context_text = "\n📚 MÉMOIRE:\n"
        for i, doc in enumerate(relevant_docs, 1):
            context_text += f"{i}. [{doc.get('type','?')}] {doc.get('text','')[:120]}...\n"

    # ── Historique ──
    history = memory.get_conversation(conv_id)
    history_text = ""
    if history:
        for msg in history[-3:]:
            history_text += f"{msg.get('role','?')}: {msg.get('content','')}\n"

    # ── DuckDuckGo Search ──
    web_context = ""
    needs_web = (
        intent == "search" or
        any(w in message_lower for w in [
            "actualité", "news", "aujourd'hui", "récent", "qui est", "c'est quoi",
            "qu'est-ce", "définition", "recherche", "trouve", "cherche", "google",
            "dernière", "nouveau", "internet", "en ligne",
        ])
    )
    if needs_web and WEB_SEARCH_AVAILABLE:
        try:
            logger.info(f"🌐 DuckDuckGo: '{message[:60]}'")
            ddg_results = _web_search(message, max_results=5)
            if ddg_results:
                web_context = "\n🌐 RECHERCHE WEB (DuckDuckGo):\n"
                for i, r in enumerate(ddg_results[:5], 1):
                    web_context += f"{i}. {r.get('title','')}\n   {r.get('body','')[:200]}...\n   {r.get('href','')}\n\n"
                tools_used.append(f"DuckDuckGo ({len(ddg_results)} résultats)")
        except Exception as e:
            logger.warning(f"⚠️ DuckDuckGo échouée: {e}")

    # ── Prompt par intention ──
    prompts = {
        "search": SEARCH_PROMPT,
        "explain_app": EXPLAIN_APP_PROMPT,
        "problem_solving": PROBLEM_SOLVING_PROMPT,
        "summarization": SUMMARIZATION_PROMPT,
        "conversation": CONVERSATION_PROMPT,
    }
    sys_prompt = prompts.get(intent, CONVERSATION_PROMPT)

    full_message = f"""{sys_prompt}

{history_text}
{context_text}
{web_context}

Utilisateur: {message}

Réponds de manière naturelle et concise."""

    # ── Génération ──
    if agent.tools["llm"].is_ready:
        agent_result = agent.chat(
            message=full_message,
            context={"max_tokens": 300, "temperature": request.temperature},
        )
        response_text = agent_result.get("response", "Aucune réponse.")
        tools_used.append("SmolVLM-256M")
    else:
        response_text = (
            "Bonjour ! Je suis Kibali, votre assistant IA. "
            "Le modèle SmolVLM est en cours de chargement sur le Space HuggingFace. "
            "Réessayez dans quelques instants !"
        )
        tools_used.append("Mode démarrage")

    # ── Mémoriser ──
    memory.add_to_conversation(conv_id, {"role": "user", "content": message, "timestamp": datetime.now().isoformat()})
    memory.add_to_conversation(conv_id, {"role": "assistant", "content": response_text, "timestamp": datetime.now().isoformat()})

    return ChatResponse(
        response=response_text,
        conversation_id=conv_id,
        sources=[{"id": d["id"], "type": d["type"], "preview": d["text"][:80]} for d in relevant_docs] if relevant_docs else None,
        reasoning=f"Outils: {' + '.join(tools_used)}",
        timestamp=datetime.now().isoformat(),
    )

@app.get("/stats")
async def stats():
    return {
        "documents_indexed": len(memory.documents),
        "conversations": len(memory.conversations),
        "faiss_vectors": memory.index.ntotal if memory.index is not None else 0,
        "smolvlm_ready": agent.tools["vision"].is_ready,
        "web_search": WEB_SEARCH_AVAILABLE,
        "timestamp": datetime.now().isoformat(),
    }

# ── Lancement ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
