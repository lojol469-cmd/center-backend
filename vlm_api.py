"""
🎬 VLM API — SmolVLM-256M-Instruct + MiniLM-L6-v2
===================================================
API REST complète : intelligence vidéo, recommandations YouTube-style, chat multimodal.

╔══════════════════════════════════════════════════════════════════════════╗
║  LISTE COMPLÈTE DES ACTIONS (GET /)                                     ║
╠══════════════════════════════════════════════════════════════════════════╣
║  ─── Système ──────────────────────────────────────────────────────     ║
║  GET  /                          Liste toutes les actions               ║
║  GET  /health                    Statut SmolVLM + MiniLM + MongoDB      ║
║                                                                          ║
║  ─── Chat & Conversation ──────────────────────────────────────────     ║
║  POST /chat                      Chat multimodal texte + image          ║
║                                                                          ║
║  ─── Validation & Modération ──────────────────────────────────────     ║
║  POST /validate-payment          Valide screenshot paiement Airtel      ║
║  POST /analyze-content           Modération visuelle/textuelle          ║
║  POST /describe-image            Description générique d'une image      ║
║                                                                          ║
║  ─── Intelligence Vidéo (à la place de l'utilisateur) ─────────────    ║
║  POST /video/caption             Génère sous-titres depuis une frame    ║
║  POST /video/auto-tags           Tags automatiques pour une vidéo       ║
║  POST /video/title               5 suggestions de titres accrocheurs    ║
║  POST /video/description         Description SEO complète d'une vidéo   ║
║  POST /video/thumbnail-score     Score qualité miniature (style YouTube)║
║  POST /video/moderation          Modère une frame vidéo avant publi     ║
║                                                                          ║
║  ─── Recommandations YouTube-style ultra-avancées ─────────────────    ║
║  GET  /recommend/feed            Feed personnalisé utilisateur           ║
║  POST /recommend/similar         Vidéos similaires par image/texte      ║
║  POST /recommend/score           Calcule score algorithme d'une vidéo   ║
╚══════════════════════════════════════════════════════════════════════════╝

Modèles :
  SmolVLM-256M-Instruct  — Vision + Texte (4-bit GPU / float32 CPU)
  MiniLM-L6-v2           — Embeddings sémantiques pour recommandations

Port : 8005
"""

import io
import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("vlm_api")

# ── Paths ─────────────────────────────────────────────────────────────────
sys.path.append(str(Path(__file__).parent / "models"))

_REPO_ROOT = Path(__file__).parent.parent
_MINILM_DEFAULT = str(_REPO_ROOT / "frontend-center" / "models--sentence-transformers--all-MiniLM-L6-v2")
_SMOLVLM_DEFAULT = str(_REPO_ROOT / "frontend-center" / "models--HuggingFaceTB--SmolVLM-256M-Instruct")
_KIBALI_DEFAULT = str(Path(__file__).parent / "kibali-final-merged")


def _resolve_hf_snapshot(base_dir: str) -> str:
    """Resolve HuggingFace cache structure snapshots/<hash>/ automatically."""
    p = Path(base_dir)
    snapshots = p / "snapshots"
    if snapshots.is_dir():
        candidates = sorted(snapshots.iterdir())
        if candidates:
            resolved = str(candidates[-1])
            logger.info(f"📂 HF snapshot résolu : {resolved}")
            return resolved
    return base_dir

# ── Global state ──────────────────────────────────────────────────────────
agent = None            # UnifiedAgent (SmolVLM) — yeux
minilm_model = None     # SentenceTransformer (MiniLM-L6-v2)
mongo_db = None         # MongoDB database handle
llm_model = None        # Mistral 7B Kibali — cerveau de raisonnement
llm_tokenizer = None    # Tokenizer Mistral
video_index: Dict[str, Any] = {}     # videoId → {embedding, meta}
index_built_at: float = 0.0
INDEX_TTL = 300         # Rebuild index every 5 minutes


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan — chargement de tous les modèles
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent, minilm_model, mongo_db, llm_model, llm_tokenizer

    # 1. SmolVLM
    model_path = os.environ.get("SMOLVLM_MODEL_PATH", _SMOLVLM_DEFAULT)
    logger.info(f"🔄 Chargement SmolVLM depuis : {model_path}")
    try:
        from unified_agent import UnifiedAgent  # type: ignore[import-not-found]
        agent = UnifiedAgent(model_path=model_path, enable_llm=True, enable_vision=True)
        logger.info("✅ SmolVLM-256M-Instruct prêt")
    except Exception as exc:
        logger.warning(f"⚠️ SmolVLM non chargé : {exc}")
        agent = None

    # 2. Mistral 7B Kibali — cerveau de raisonnement (4-bit NF4)
    kibali_path = os.environ.get("KIBALI_MODEL_PATH", _KIBALI_DEFAULT)
    logger.info(f"🔄 Chargement Mistral Kibali 7B (4-bit NF4) depuis : {kibali_path}")
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig  # type: ignore
        _bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        llm_tokenizer = AutoTokenizer.from_pretrained(kibali_path, use_fast=True)
        llm_model = AutoModelForCausalLM.from_pretrained(
            kibali_path,
            quantization_config=_bnb,
            device_map="auto",
            torch_dtype=torch.float16,
        )
        llm_model.eval()
        logger.info("✅ Mistral Kibali 7B prêt (4-bit NF4 GPU)")
    except Exception as exc:
        logger.warning(f"⚠️ Mistral Kibali non chargé — fallback SmolVLM seul : {exc}")
        llm_model = None
        llm_tokenizer = None

    # 3. MiniLM pour les embeddings / recommandations
    minilm_path = _resolve_hf_snapshot(os.environ.get("MINILM_MODEL_PATH", _MINILM_DEFAULT))
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        minilm_model = SentenceTransformer(minilm_path)
        logger.info("✅ MiniLM-L6-v2 prêt (recommandations)")
    except Exception as exc:
        logger.warning(f"⚠️ MiniLM non chargé : {exc}")
        minilm_model = None

    # 4. MongoDB
    mongo_uri = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017/myDatabase60")
    try:
        from pymongo import MongoClient  # type: ignore
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=3000)
        client.admin.command("ping")
        db_name = os.environ.get("MONGO_DB_NAME", "myDatabase60")
        mongo_db = client[db_name]
        logger.info(f"✅ MongoDB connecté ({db_name})")
        _build_video_index()
    except Exception as exc:
        logger.warning(f"⚠️ MongoDB non disponible : {exc}")
        mongo_db = None

    yield

    agent = None
    minilm_model = None
    mongo_db = None
    llm_model = None
    llm_tokenizer = None


# ─────────────────────────────────────────────────────────────────────────────
# Video Index — construction & helpers
# ─────────────────────────────────────────────────────────────────────────────

def _video_to_text(v: dict) -> str:
    """Concatène les champs textuels d'une vidéo pour l'encodage MiniLM."""
    parts = [v.get("title", ""), v.get("description", ""), " ".join(v.get("tags", []))]
    return " | ".join(p for p in parts if p)


def _build_video_index():
    """Index toutes les vidéos approuvées avec embeddings MiniLM."""
    global video_index, index_built_at
    if mongo_db is None or minilm_model is None:
        return
    try:
        cursor = mongo_db.videos.find(
            {"moderation.approved": True, "visibility": "public"},
            {
                "_id": 1, "title": 1, "description": 1, "tags": 1,
                "thumbnailUrl": 1, "videoUrl": 1, "author": 1,
                "views": 1, "likes": 1, "shares": 1,
                "algorithm_score": 1, "trending_rank": 1,
                "createdAt": 1, "duration": 1,
            },
        )
        videos = list(cursor)
        if not videos:
            logger.warning("⚠️ Aucune vidéo approuvée pour l'index")
            return

        texts = [_video_to_text(v) for v in videos]
        embeddings = minilm_model.encode(texts, batch_size=32, show_progress_bar=False)

        new_index: Dict[str, Any] = {}
        for v, emb in zip(videos, embeddings):
            vid = str(v["_id"])
            new_index[vid] = {
                "embedding": emb,
                "meta": {
                    "id": vid,
                    "title": v.get("title", ""),
                    "description": v.get("description", ""),
                    "tags": v.get("tags", []),
                    "thumbnailUrl": v.get("thumbnailUrl", ""),
                    "videoUrl": v.get("videoUrl", ""),
                    "author": str(v.get("author", "")),
                    "views": v.get("views", 0),
                    "likes": len(v.get("likes", [])),
                    "shares": v.get("shares", 0),
                    "algorithm_score": v.get("algorithm_score", 0),
                    "trending_rank": v.get("trending_rank", 0),
                    "createdAt": str(v.get("createdAt", "")),
                    "duration": v.get("duration", 0),
                },
            }

        video_index = new_index
        index_built_at = time.time()
        logger.info(f"✅ Index vidéo : {len(video_index)} vidéos indexées")
    except Exception as exc:
        logger.error(f"❌ Erreur indexation vidéos : {exc}")


def _ensure_index_fresh():
    if time.time() - index_built_at > INDEX_TTL:
        _build_video_index()


def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="VLM API — Intelligence Vidéo + Recommandations YouTube-style",
    version="2.0.0",
    description="SmolVLM-256M-Instruct + MiniLM-L6-v2 : vision, captions auto, chat, modération, recommandations",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers internes
# ─────────────────────────────────────────────────────────────────────────────

def _vlm_ready() -> bool:
    return (
        agent is not None
        and agent.tools.get("vision") is not None
        and agent.tools["vision"].is_ready
    )


def _minilm_ready() -> bool:
    return minilm_model is not None


def _parse_json_from_text(text: str) -> dict:
    """Extrait le premier objet JSON d'un texte libre."""
    try:
        match = re.search(r"\{.*?\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
    except (json.JSONDecodeError, AttributeError):
        pass
    return {}


def _parse_json_array(text: str) -> list:
    """Extrait le premier tableau JSON d'un texte libre."""
    try:
        match = re.search(r"\[.*?\]", text, re.DOTALL)
        if match:
            return json.loads(match.group())
    except (json.JSONDecodeError, AttributeError):
        pass
    return [s.strip().strip('"\'') for s in text.split(",") if s.strip()][:20]


def _run_vision_prompt(image_bytes: bytes, prompt: str) -> str:
    """Sauvegarde l'image dans un tempfile puis appelle agent.process_image."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        result = agent.process_image(tmp_path, question=prompt)
        return result.get("vision", {}).get("description", "")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _require_vlm():
    if not _vlm_ready():
        raise HTTPException(status_code=503, detail="SmolVLM non disponible")


def _llm_ready() -> bool:
    return llm_model is not None and llm_tokenizer is not None


def _run_llm(prompt: str, max_tokens: int = 300, temperature: float = 0.1) -> str:
    """Génère du texte avec Mistral Kibali 7B 4-bit. Fallback sur SmolVLM si indisponible."""
    if not _llm_ready():
        # Fallback : SmolVLM génère du texte
        if agent is not None:
            return agent.generate(prompt, max_tokens=max_tokens, temperature=temperature)
        return ""
    import torch
    # Format Mistral instruct : [INST] ... [/INST]
    fmt = f"[INST] {prompt.strip()} [/INST]"
    inputs = llm_tokenizer(fmt, return_tensors="pt", truncation=True, max_length=2048).to(llm_model.device)
    with torch.no_grad():
        output = llm_model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=max(0.01, temperature),
            do_sample=temperature > 0.05,
            repetition_penalty=1.1,
            pad_token_id=llm_tokenizer.eos_token_id,
        )
    generated = output[0][inputs["input_ids"].shape[1]:]
    return llm_tokenizer.decode(generated, skip_special_tokens=True).strip()


def _cloudinary_frame_url(video_url: str, percentage: int) -> str:
    """Transforme une URL Cloudinary vidéo en URL de frame JPEG à un pourcentage donné.

    Exemple:
      https://res.cloudinary.com/xxx/video/upload/v1234/videos/abc.mp4
      → https://res.cloudinary.com/xxx/video/upload/so_25p/v1234/videos/abc.jpg
    """
    pct = max(0, min(100, percentage))
    m = re.match(
        r"(https://res\.cloudinary\.com/[^/]+/video/upload/)(.*?)(\.[a-zA-Z0-9]{2,4})$",
        video_url,
    )
    if not m:
        return ""
    base, path, _ext = m.groups()
    return f"{base}so_{pct}p/{path}.jpg"


def _download_bytes(url: str, timeout: int = 12) -> Optional[bytes]:
    """Télécharge des bytes depuis une URL. Retourne None en cas d'échec."""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "VLM-Moderator/2.0",
                "Accept": "image/jpeg,image/png,image/*",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            return data if data else None
    except Exception as exc:
        logger.debug(f"⚠️ _download_bytes failed {url[:80]}: {exc}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# SYSTÈME
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    """Liste complète de toutes les actions disponibles sur cette API."""
    return {
        "name": "VLM API — Intelligence Vidéo + Recommandations YouTube-style",
        "version": "2.0.0",
        "models": {
            "vision_llm": "SmolVLM-256M-Instruct",
            "embeddings": "all-MiniLM-L6-v2",
        },
        "actions": {
            "système": {
                "GET /": "Liste toutes les actions disponibles",
                "GET /health": "Statut SmolVLM + MiniLM + MongoDB + taille index vidéos",
            },
            "chat_et_conversation": {
                "POST /chat": (
                    "Chat multimodal intelligent — texte + image optionnelle. "
                    "Supporte historique de conversation."
                ),
            },
            "validation_et_modération": {
                "POST /validate-payment": (
                    "Valide un screenshot de paiement Airtel Money. "
                    "Extrait montant, numéro destinataire, transaction_id, validité."
                ),
                "POST /analyze-content": (
                    "Modération visuelle et/ou textuelle. "
                    "Détecte violence, contenu sexuel, harcèlement, spam."
                ),
                "POST /describe-image": "Description générique détaillée d'une image.",
            },
            "intelligence_vidéo": {
                "POST /video/caption": (
                    "📝 Génère automatiquement des sous-titres et captions depuis une frame "
                    "ou miniature vidéo — à la place de l'utilisateur."
                ),
                "POST /video/auto-tags": (
                    "🏷️ Génère des tags SEO optimisés, hashtags et tags longue traîne "
                    "pour maximiser la découverte d'une vidéo."
                ),
                "POST /video/title": (
                    "✍️ Propose 5 titres accrocheurs et optimisés YouTube "
                    "(styles : engaging, clickbait, informative, funny)."
                ),
                "POST /video/description": (
                    "📄 Rédige une description SEO complète avec mots-clés, "
                    "appel à l'action et horodatages suggérés."
                ),
                "POST /video/thumbnail-score": (
                    "📊 Évalue la qualité et l'attractivité d'une miniature vidéo : "
                    "contraste, texte, émotions, composition, CTR estimé."
                ),
                "POST /video/moderation": (
                    "🛡️ Modère une frame vidéo avant publication : "
                    "détecte violence, contenu adulte, droits d'auteur, etc."
                ),
                "POST /video/moderate-full": (
                    "🎬 Modère une vidéo COMPLÈTE frame par frame avec SmolVLM. "
                    "Télécharge les frames Cloudinary (so_0p…so_100p), analyse chaque frame, "
                    "synthétise un verdict humain avec score 0-100, tier, recommandations "
                    "et suggestions de titre/description améliorés."
                ),
            },
            "recommandations_youtube_style": {
                "GET /recommend/feed": (
                    "🎬 Feed personnalisé YouTube-style ultra-avancé. "
                    "Algorithme : historique visionnage → embedding MiniLM → cosine similarity "
                    "→ boost algorithm_score + trending_rank + vues."
                ),
                "POST /recommend/similar": (
                    "🔍 Trouve des vidéos similaires depuis une image (frame/miniature) : "
                    "SmolVLM analyse l'image → MiniLM encode → recherche vectorielle."
                ),
                "POST /recommend/score": (
                    "⚡ Calcule et met à jour le score algorithme d'une vidéo "
                    "(engagement 40% + fraîcheur 30% + vélocité 20% + boost 10%)."
                ),
            },
        },
    }


@app.get("/health")
def health():
    """Statut détaillé de tous les modèles et services."""
    vlm_ok = _vlm_ready()
    minilm_ok = _minilm_ready()
    db_ok = mongo_db is not None
    return {
        "status": "ok" if vlm_ok else "degraded",
        "models": {
            "smolvlm": {
                "loaded": vlm_ok,
                "name": "SmolVLM-256M-Instruct",
                "quantization": (
                    "4bit-NF4" if vlm_ok and getattr(agent, "_device", "cpu") == "cuda"
                    else "float32-CPU"
                ),
                "device": getattr(agent, "_device", "unknown") if agent else "unloaded",
            },
            "minilm": {
                "loaded": minilm_ok,
                "name": "all-MiniLM-L6-v2",
                "purpose": "embeddings sémantiques pour recommandations",
            },
        },
        "database": {
            "connected": db_ok,
            "video_index_size": len(video_index),
            "index_age_seconds": int(time.time() - index_built_at) if index_built_at > 0 else -1,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# CHAT MULTIMODAL
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/chat")
async def chat(
    message: str = Form(..., description="Message de l'utilisateur"),
    image: Optional[UploadFile] = File(None, description="Image optionnelle (JPEG/PNG)"),
    context: Optional[str] = Form(None, description="Instructions système ou contexte"),
    history: Optional[str] = Form(None, description="Historique JSON [{role,content}]"),
):
    """
    Chat multimodal intelligent avec SmolVLM-256M-Instruct.
    Supporte texte seul ou texte + image. Contexte système configurable.
    """
    _require_vlm()

    system_ctx = context or "Tu es un assistant IA intelligent, précis et serviable."

    if image:
        raw_bytes = await image.read()
        if not raw_bytes:
            raise HTTPException(status_code=400, detail="Image vide")
        prompt = f"{system_ctx}\n\nQuestion sur cette image : {message}"
        response = _run_vision_prompt(raw_bytes, prompt)
    else:
        full_prompt = f"{system_ctx}\n\nUtilisateur : {message}\nAssistant :"
        response = agent.generate(full_prompt, max_tokens=600, temperature=0.7)

    return {
        "response": response,
        "model": "SmolVLM-256M-Instruct",
        "with_image": image is not None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# VALIDATION & MODÉRATION
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/validate-payment")
async def validate_payment(
    image: UploadFile = File(..., description="Screenshot du paiement Airtel Money"),
    expected_amount: Optional[str] = Form(None, description="Montant attendu en XAF"),
    payment_number: Optional[str] = Form(None, description="Numéro destinataire attendu"),
    pack_label: Optional[str] = Form(None, description="Label du pack TPC commandé"),
):
    """Valide un screenshot Airtel Money et extrait montant, numéro, transaction."""
    _require_vlm()

    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Image vide")

    context_parts: List[str] = []
    if expected_amount:
        context_parts.append(f"Montant attendu : {expected_amount} XAF")
    if payment_number:
        context_parts.append(f"Numéro destinataire attendu : {payment_number}")
    if pack_label:
        context_parts.append(f"Pack commandé : {pack_label}")
    ctx = " | ".join(context_parts) if context_parts else "Aucun contexte"

    prompt = (
        f"Tu es un expert en validation de reçus de paiement mobile. {ctx}.\n"
        "Analyse ce screenshot et détermine :\n"
        "1. Est-ce un vrai reçu Airtel Money ?\n"
        "2. Quel est le montant visible ?\n"
        "3. Quel est le numéro destinataire ?\n"
        "4. Y a-t-il un identifiant de transaction ?\n"
        "5. Le montant et numéro correspondent-ils aux valeurs attendues ?\n\n"
        "Réponds UNIQUEMENT avec ce JSON :\n"
        '{"valid": true/false, "amount_detected": "montant ou unknown", '
        '"recipient_number": "numéro ou unknown", "transaction_id": "id ou unknown", '
        '"confidence": 0.0-1.0, "reason": "explication en français"}'
    )

    raw_output = _run_vision_prompt(raw_bytes, prompt)
    logger.info(f"📋 validate-payment : {raw_output[:200]}")
    parsed = _parse_json_from_text(raw_output)

    return {
        "valid": bool(parsed.get("valid", False)),
        "amount_detected": str(parsed.get("amount_detected", "unknown")),
        "recipient_number": str(parsed.get("recipient_number", "unknown")),
        "transaction_id": str(parsed.get("transaction_id", "unknown")),
        "confidence": float(parsed.get("confidence", 0.5)),
        "reason": str(parsed.get("reason", raw_output[:300])),
        "raw_output": raw_output[:500],
    }


@app.post("/analyze-content")
async def analyze_content(
    image: Optional[UploadFile] = File(None, description="Image à analyser"),
    text: Optional[str] = Form(None, description="Texte à analyser"),
    context: Optional[str] = Form(None, description="Contexte de modération"),
):
    """Modération visuelle et/ou textuelle — détecte violence, nudité, harcèlement, spam."""
    _require_vlm()

    has_text = bool(text and text.strip())
    if image is None and not has_text:
        raise HTTPException(status_code=400, detail="Fournir une image ou du texte")

    text_block = text.strip()[:500] if has_text else ""

    # ── ÉTAPE 1 : SmolVLM = yeux (description factuelle) ─────────────────
    if image is not None:
        raw_bytes = await image.read()
        if not raw_bytes or len(raw_bytes) < 10:
            raise HTTPException(status_code=400, detail="Image invalide")
        vision_desc = _run_vision_prompt(
            raw_bytes,
            "Décris précisément et objectivement ce que tu vois dans cette image en 2-3 phrases. "
            "Mentionne les personnes, vêtements, objets, activités et ambiance générale."
        )
        logger.info(f"👁️  SmolVLM description : {vision_desc[:200]}")
    else:
        vision_desc = ""

    # ── ÉTAPE 2 : Mistral Kibali 7B = cerveau (raisonnement + décision) ──
    content_block = f'Texte soumis : "{text_block}"\n' if has_text else ""
    vision_block = f"Description visuelle de l'image : {vision_desc}\n" if vision_desc else ""

    reasoning_prompt = (
        "Tu es un modérateur de contenu senior pour une plateforme familiale (enfants et familles).\n"
        "Ton rôle : analyser le contenu soumis et décider s'il est acceptable ou non.\n\n"
        f"{content_block}"
        f"{vision_block}"
        "\nAnalyse et réponds à ces questions :\n"
        "1. Ce contenu contient-il des éléments sexuels, érotiques ou à caractère adulte ? (OUI/NON)\n"
        "2. Ce contenu contient-il de la violence, du sang ou des scènes choquantes ? (OUI/NON)\n"
        "3. Ce contenu contient-il des insultes, du harcèlement ou de la haine ? (OUI/NON)\n"
        "4. Ce contenu est-il approprié pour des enfants de 10 ans ? (OUI/NON)\n"
        "5. VERDICT FINAL : ACCEPTÉ ou REFUSÉ ? Explique en une phrase.\n\n"
        "Réponds ligne par ligne, sois factuel et strict."
    )

    llm_response = _run_llm(reasoning_prompt, max_tokens=250, temperature=0.05)
    logger.info(f"🧠 Mistral verdict : {llm_response[:300]}")

    # ── ÉTAPE 3 : Parsing de la réponse structurée ───────────────────────
    lines = [l.strip() for l in llm_response.split("\n") if l.strip()]

    # Parsing par lignes numérotées (OUI/NON strict) — évite les faux positifs
    def _numbered_oui(num: int) -> bool:
        """Retourne True si la ligne numérotée dit OUI (et pas NON)."""
        pat = re.compile(r"^" + str(num) + r"[\.\:\-\)]\s*", re.IGNORECASE)
        for l in lines:
            if pat.match(l):
                after = pat.sub("", l).lower()
                if "non" in after:
                    return False
                if "oui" in after:
                    return True
        return False

    has_sexual   = _numbered_oui(1)
    has_violence = _numbered_oui(2)
    has_hate     = _numbered_oui(3)

    # Verdict final (ligne 5) = vérité absolue — override les catégories individuelles
    verdict_line = next(
        (l for l in lines if "verdict" in l.lower() or "accepté" in l.lower() or "refusé" in l.lower()),
        lines[-1] if lines else ""
    )
    final_refused  = bool(verdict_line) and ("refus" in verdict_line.lower())
    final_accepted = bool(verdict_line) and ("accept" in verdict_line.lower()) and not final_refused

    if final_accepted:
        is_unsafe = False
    elif final_refused:
        is_unsafe = True
        if not (has_sexual or has_violence or has_hate):
            has_sexual = True  # catégorie par défaut si verdict refuse mais lignes ambiguës
    else:
        is_unsafe = has_sexual or has_violence or has_hate

    cats: List[str] = []
    if has_sexual:
        cats.append("contenu_sexuel")
    if has_violence:
        cats.append("violence")
    if has_hate:
        cats.append("harassment")

    logger.info(f"📋 analyze-content final : safe={not is_unsafe} cats={cats}")

    return {
        "safe": not is_unsafe,
        "categories": cats,
        "confidence": 0.92 if _llm_ready() else 0.65,
        "reason": verdict_line[:300],
    }


@app.post("/describe-image")
async def describe_image(
    image: UploadFile = File(..., description="Image à décrire"),
    question: Optional[str] = Form("Décris cette image en détail.", description="Question ou instruction"),
):
    """Description générique détaillée d'une image."""
    _require_vlm()
    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    return {"description": _run_vision_prompt(raw_bytes, question or "Décris cette image en détail.")}


# ─────────────────────────────────────────────────────────────────────────────
# INTELLIGENCE VIDÉO — génération de contenu à la place de l'utilisateur
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/video/caption")
async def video_caption(
    image: UploadFile = File(..., description="Frame ou miniature vidéo"),
    title: Optional[str] = Form(None, description="Titre existant de la vidéo"),
    language: Optional[str] = Form("fr", description="Langue : fr / en"),
):
    """
    Génère automatiquement des sous-titres et captions depuis une frame/miniature.
    Remplace le travail manuel de création de légendes par l'utilisateur.
    """
    _require_vlm()
    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Image vide")

    lang = "en français" if language == "fr" else "in English"
    title_ctx = f" (Titre : '{title}')" if title else ""

    prompt = (
        f"Tu es un expert en création de contenu vidéo{title_ctx}.\n"
        f"Analyse cette image (frame ou miniature vidéo) et génère {lang} :\n"
        "1. Description courte et engageante de la scène (max 150 mots)\n"
        "2. Caption/légende pour réseaux sociaux (max 80 caractères)\n"
        "3. Alt text accessible\n"
        "4. 3 variantes de sous-titres : court (5s), moyen (10s), long (20s)\n\n"
        "Réponds UNIQUEMENT avec ce JSON :\n"
        '{"description": "...", "caption": "...", "alt_text": "...", '
        '"subtitles": {"5s": "...", "10s": "...", "20s": "..."}, '
        '"mood": "ambiance de la scène", "scene_type": "type de scène"}'
    )

    raw_output = _run_vision_prompt(raw_bytes, prompt)
    logger.info(f"📋 video/caption : {raw_output[:200]}")
    parsed = _parse_json_from_text(raw_output)

    if not parsed:
        short = raw_output[:80]
        parsed = {
            "description": raw_output[:300],
            "caption": short,
            "alt_text": raw_output[:120],
            "subtitles": {"5s": short[:40], "10s": short, "20s": raw_output[:150]},
            "mood": "inconnu",
            "scene_type": "inconnu",
        }

    return {**parsed, "language": language}


@app.post("/video/auto-tags")
async def video_auto_tags(
    image: UploadFile = File(..., description="Miniature ou frame vidéo"),
    title: Optional[str] = Form(None, description="Titre de la vidéo"),
    description: Optional[str] = Form(None, description="Description existante"),
    category: Optional[str] = Form(None, description="Catégorie de la vidéo"),
):
    """Génère automatiquement des tags SEO, hashtags et tags longue traîne pour une vidéo."""
    _require_vlm()
    raw_bytes = await image.read()

    # Étape 1 : SmolVLM décrit l'image
    vision_desc = _run_vision_prompt(
        raw_bytes,
        "Décris précisément ce que tu vois dans cette image : objets, personnes, "
        "couleurs, activités, ambiance, lieu. Sois factuel et détaillé."
    )
    logger.info(f"👁️  auto-tags vision : {vision_desc[:150]}")

    # Étape 2 : Mistral génère les tags ligne par ligne
    ctx_parts = []
    if title: ctx_parts.append(f"Titre : {title}")
    if description: ctx_parts.append(f"Description : {description[:200]}")
    if category: ctx_parts.append(f"Catégorie : {category}")
    ctx = "\n".join(ctx_parts) if ctx_parts else ""

    llm_prompt = (
        f"Tu es expert SEO YouTube.\n"
        f"Description visuelle de la miniature : {vision_desc}\n"
        f"{ctx}\n\n"
        "Génère exactement :\n"
        "TAGS: (10 tags séparés par des virgules, sans guillemets, sans crochets)\n"
        "HASHTAGS: (5 hashtags séparés par des virgules)\n"
        "LONGUE_TRAINE: (5 expressions de 2-3 mots séparées par des virgules)\n\n"
        "Exemple de format attendu :\n"
        "TAGS: cuisine, recette, gastronomie, chef, restaurant\n"
        "HASHTAGS: #cuisine, #recette, #food, #cooking, #gastronomie\n"
        "LONGUE_TRAINE: recette facile maison, plat traditionnel africain, cuisine saine rapide"
    )
    llm_out = _run_llm(llm_prompt, max_tokens=300, temperature=0.2)
    logger.info(f"📋 video/auto-tags Mistral : {llm_out[:200]}")

    # Parsing ligne par ligne
    def _extract_line(prefix: str) -> list:
        for line in llm_out.split("\n"):
            if line.upper().startswith(prefix.upper()):
                raw = re.sub(r"^[^:]+:\s*", "", line)
                return [t.strip().strip('"\' ') for t in raw.split(",") if t.strip()]
        return []

    tags_principaux = _extract_line("TAGS:") or _extract_line("TAGS")
    hashtags = _extract_line("HASHTAGS:") or _extract_line("HASHTAGS")
    longue_traine = _extract_line("LONGUE_TRAINE:") or _extract_line("LONGUE")

    # Fallback si Mistral n'a rien généré
    if not tags_principaux:
        words = [w.strip(".,!?#@\"'") for w in vision_desc.split() if len(w) > 3]
        tags_principaux = list(dict.fromkeys(words))[:10]
    if not hashtags:
        hashtags = [f"#{t.replace(' ', '')}" for t in tags_principaux[:5]]

    tags_all = list(dict.fromkeys(tags_principaux + longue_traine))
    return {
        "tags_principaux": tags_principaux,
        "hashtags": hashtags,
        "tags_longue_traine": longue_traine,
        "tags_all": tags_all,
    }


@app.post("/video/title")
async def video_title_suggestions(
    image: UploadFile = File(..., description="Miniature ou frame vidéo"),
    existing_title: Optional[str] = Form(None, description="Titre existant à améliorer"),
    style: Optional[str] = Form("engaging", description="Style : engaging / clickbait / informative / funny"),
    language: Optional[str] = Form("fr", description="Langue : fr / en"),
):
    """Propose 5 titres accrocheurs et optimisés YouTube pour une vidéo."""
    _require_vlm()
    raw_bytes = await image.read()

    # Étape 1 : SmolVLM décrit l'image
    vision_desc = _run_vision_prompt(
        raw_bytes,
        "Décris précisément ce que tu vois dans cette image en 2-3 phrases. "
        "Mentionne les personnes, actions, objets, lieu et atmosphère générale."
    )
    logger.info(f"👁️  title vision : {vision_desc[:150]}")

    # Étape 2 : Mistral génère les titres ligne par ligne
    style_desc = {
        "engaging": "engageants, qui donnent envie de cliquer",
        "clickbait": "percutants et intrigants (sans être mensongers)",
        "informative": "informatifs et descriptifs",
        "funny": "drôles et humoristiques",
    }.get(style or "engaging", "engageants")
    lang = "en français" if language == "fr" else "in English"
    existing_ctx = f"Titre existant à améliorer : {existing_title}\n" if existing_title else ""

    llm_prompt = (
        f"Tu es expert YouTube en création de titres accrocheurs.\n"
        f"Description de l'image : {vision_desc}\n"
        f"{existing_ctx}"
        f"Génère exactement 5 titres {style_desc} {lang}.\n"
        "Chaque titre doit être inférieur à 70 caractères et donner envie de cliquer.\n"
        "Écris UNIQUEMENT les 5 titres, un par ligne, sans numéros ni ponctuation au début.\n"
        "Ne mets pas de guillemets, pas de JSON, pas de commentaires."
    )
    llm_out = _run_llm(llm_prompt, max_tokens=250, temperature=0.4)
    logger.info(f"📋 video/title Mistral : {llm_out[:200]}")

    # Parsing : extraire les lignes non vides < 100 chars
    raw_lines = [l.strip() for l in llm_out.split("\n") if l.strip()]
    cleaned = []
    for l in raw_lines:
        l = re.sub(r'^(?:Titre|Title)\s*\d+\s*[:\.]\s*', '', l, flags=re.IGNORECASE)
        l = re.sub(r'^\d+[\.\):\-]\s*', '', l)
        l = l.strip('"\'-\u2022*')
        cleaned.append(l)
    titles = [l for l in cleaned if 5 < len(l) < 100 and not l.startswith('{') and not l.startswith('[')][:5]

    if not titles:
        titles = [vision_desc[:60]] if vision_desc else ["Vidéo incroyable"]

    best = titles[0]
    return {
        "titles": titles,
        "best_title": best,
        "reason": "Générés par Mistral Kibali 7B depuis description visuelle SmolVLM",
        "style": style,
        "language": language,
    }


@app.post("/video/description")
async def video_description_generator(
    image: UploadFile = File(..., description="Miniature ou frame vidéo"),
    title: str = Form(..., description="Titre de la vidéo"),
    existing_description: Optional[str] = Form(None, description="Description à enrichir"),
    language: Optional[str] = Form("fr", description="Langue : fr / en"),
    include_cta: Optional[bool] = Form(True, description="Inclure un appel à l'action"),
):
    """Rédige une description SEO complète et engageante pour une vidéo (à la place de l'utilisateur)."""
    _require_vlm()
    raw_bytes = await image.read()

    # Étape 1 : SmolVLM décrit l'image
    vision_desc = _run_vision_prompt(
        raw_bytes,
        "Décris précisément et objectivement ce que tu vois dans cette image en 3-4 phrases. "
        "Détaille les personnes, objets, couleurs, lieu, actions et ambiance."
    )
    logger.info(f"👁️  description vision : {vision_desc[:150]}")

    # Étape 2 : Mistral rédige la description en texte brut
    lang = "en français" if language == "fr" else "in English"
    existing_ctx = f"Description existante à améliorer : {existing_description[:300]}\n" if existing_description else ""
    cta = "Termine avec un appel à l'action naturel (like, abonnement, commentaire).\n" if include_cta else ""

    llm_prompt = (
        f"Tu es expert YouTube en rédaction de descriptions vidéo SEO.\n"
        f"Titre de la vidéo : {title}\n"
        f"Description visuelle de la miniature : {vision_desc}\n"
        f"{existing_ctx}"
        f"Rédige {lang} une description engageante et complète.\n"
        "Structure :\n"
        "- 2-3 phrases d'introduction accrocheuses\n"
        "- Description du contenu avec mots-clés SEO naturels\n"
        f"{cta}"
        "Écris UNIQUEMENT la description finale, sans titre, sans guillemets, sans JSON, "
        "sans commentaires. Commence directement la rédaction."
    )
    description_text = _run_llm(llm_prompt, max_tokens=500, temperature=0.3)
    logger.info(f"📋 video/description Mistral : {description_text[:200]}")

    # Nettoyer les artefacts potentiels
    description_text = description_text.strip().strip('"\'')
    if description_text.startswith("{"):
        # Mistral a quand même sorti du JSON — extraire le texte
        m = re.search(r'"description_full"\s*:\s*"([^"]+)"', description_text)
        description_text = m.group(1) if m else vision_desc

    short = " ".join(description_text.split()[:40])  # ~2 phrases
    # Extraire mots-clés approximatifs (mots > 4 chars uniques)
    keywords = list(dict.fromkeys(
        [w.strip('.,!?;:').lower() for w in description_text.split() if len(w) > 4]
    ))[:10]

    return {
        "description_full": description_text,
        "description_short": short,
        "keywords_used": keywords,
        "estimated_seo_score": 0.78 if _llm_ready() else 0.5,
        "language": language,
        "title": title,
    }


@app.post("/video/thumbnail-score")
async def video_thumbnail_score(
    image: UploadFile = File(..., description="Miniature vidéo à évaluer"),
    category: Optional[str] = Form(None, description="Catégorie de la vidéo"),
):
    """Évalue la qualité, l'attractivité et le potentiel de clic CTR d'une miniature YouTube."""
    _require_vlm()
    raw_bytes = await image.read()

    cat_ctx = f"Catégorie : '{category}'.\n" if category else ""

    prompt = (
        f"Tu es un expert YouTube en optimisation de miniatures (thumbnails).\n{cat_ctx}"
        "Évalue cette miniature selon les critères YouTube :\n"
        "1. Contraste et impact visuel des couleurs\n"
        "2. Lisibilité du texte (si présent)\n"
        "3. Expressions/visages et émotions (si présents)\n"
        "4. Composition et cadrage\n"
        "5. Taux de clic estimé (CTR)\n\n"
        "Réponds UNIQUEMENT avec ce JSON :\n"
        '{"score_global": 0-10, '
        '"scores": {"contraste": 0-10, "texte": 0-10, "emotions": 0-10, "composition": 0-10, "ctr_estime": 0-10}, '
        '"points_forts": ["..."], "points_faibles": ["..."], '
        '"recommandations": ["conseil1", "conseil2", "conseil3"], '
        '"verdict": "résumé en une phrase"}'
    )

    raw_output = _run_vision_prompt(raw_bytes, prompt)
    logger.info(f"📋 video/thumbnail-score : {raw_output[:200]}")
    parsed = _parse_json_from_text(raw_output)

    if not parsed:
        parsed = {
            "score_global": 5,
            "scores": {},
            "points_forts": [],
            "points_faibles": [],
            "recommandations": [raw_output[:200]],
            "verdict": raw_output[:100],
        }

    return parsed


@app.post("/video/moderation")
async def video_frame_moderation(
    image: UploadFile = File(..., description="Frame vidéo à modérer"),
    strict_mode: Optional[bool] = Form(False, description="Mode strict (seuil de tolérance bas)"),
):
    """Modère une frame vidéo avant publication — détecte tout contenu inapproprié."""
    _require_vlm()
    raw_bytes = await image.read()

    strict_ctx = "Applique des critères stricts, signale tout contenu ambigu.\n" if strict_mode else ""

    prompt = (
        f"Tu es un modérateur de contenu vidéo expert pour une plateforme grand public.\n{strict_ctx}"
        "Analyse cette frame pour détecter : violence, nudité/contenu sexuel, "
        "harcèlement, discours haineux, contenu dangereux/illégal, "
        "spam, logos/marques protégées.\n\n"
        "Réponds UNIQUEMENT avec ce JSON :\n"
        '{"approved": true/false, "categories_detectees": [], '
        '"severity": "none/low/medium/high/critical", "confidence": 0.0-1.0, '
        '"action_recommandee": "approve/review/reject", "reason": "explication détaillée"}'
    )

    raw_output = _run_vision_prompt(raw_bytes, prompt)
    logger.info(f"📋 video/moderation : {raw_output[:200]}")
    parsed = _parse_json_from_text(raw_output)

    return {
        "approved": bool(parsed.get("approved", True)),
        "categories_detectees": parsed.get("categories_detectees", []),
        "severity": str(parsed.get("severity", "none")),
        "confidence": float(parsed.get("confidence", 0.5)),
        "action_recommandee": str(parsed.get("action_recommandee", "review")),
        "reason": str(parsed.get("reason", raw_output[:300])),
        "strict_mode": strict_mode,
    }


@app.post("/video/moderate-full")
async def video_moderate_full(
    video_url: str = Form(..., description="URL Cloudinary de la vidéo"),
    title: str = Form("", description="Titre de la vidéo"),
    description: str = Form("", description="Description de la vidéo"),
    tags: str = Form("", description="Tags séparés par virgules"),
    frame_count: int = Form(6, description="Nombre de frames à analyser (3-10)"),
):
    """
    🎬 Modère une vidéo complète frame par frame avec SmolVLM — comme un humain.

    Pipeline :
    1. Extrait N frames depuis l'URL Cloudinary (so_0p, so_20p, so_40p…)
    2. SmolVLM analyse chaque frame visuellement
    3. Synthèse finale : verdict, score 0-100, tier, recommandations

    Retourne : approved, score, tier, recommendations[], title_suggestions[],
               description_improved, frames_analyzed, analysis_time_seconds
    """
    _require_vlm()

    start_time = time.time()
    frame_count = max(3, min(10, frame_count))

    # ── 1. Extraction des frames depuis Cloudinary ────────────────────────
    percentages = [int(i * 100 // max(frame_count - 1, 1)) for i in range(frame_count)]
    frame_analyses: List[Dict] = []
    frames_analyzed = 0

    if "cloudinary.com" in video_url:
        for pct in percentages:
            frame_url = _cloudinary_frame_url(video_url, pct)
            if not frame_url:
                continue
            img_bytes = _download_bytes(frame_url)
            if not img_bytes:
                logger.debug(f"⚠️ Frame {pct}% non téléchargée")
                continue

            frame_prompt = (
                f"Tu es modérateur strict pour une plateforme familiale (enfants inclus).\n"
                f"Image extraite à {pct}% d'une vidéo : '{title[:60]}'\n\n"
                "Décris en une phrase ce que tu vois précisément dans cette image.\n"
                "Puis réponds clairement : y a-t-il de la nudité, du contenu sexuel, "
                "de la violence, du sang ou du contenu choquant ?\n"
                "Dis OUI ou NON et explique ce que tu as observé exactement.\n"
                "Cette image est-elle sûre pour des enfants ?"
            )

            analysis = _run_vision_prompt(img_bytes, frame_prompt)
            frame_analyses.append({
                "position_percent": pct,
                "description": analysis[:500],
            })
            frames_analyzed += 1
            logger.info(f"🎞️  Frame {pct}% analysée ({frames_analyzed}/{frame_count})")

    tags_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    # ── 2. Synthèse Mistral Kibali = cerveau ─────────────────────────────
    # SmolVLM a décrit chaque frame (yeux). Mistral analyse et décide (cerveau).
    _sexual_kw = ("nudité", "nu ", "nue", "sexuel", "érotique", "pornograph", "obscène", "cul", "seins")
    _violence_kw = ("violence", "sang", "blessure", "mort", "arme", "agression")
    _hate_kw = ("haine", "racisme", "insulte", "harcèlement", "discrimination")

    frames_summary = "\n".join(
        f"Frame {i+1} à {fa['position_percent']}% : {fa['description'][:300]}"
        for i, fa in enumerate(frame_analyses)
    ) if frame_analyses else "Aucune frame disponible."

    # Défauts de sécurité pour éviter UnboundLocalError si le LLM renvoie inattendu
    final_refused = False

    synthesis_prompt = (
        f"Tu es directeur de modération senior pour une plateforme familiale (enfants et adultes).\n\n"
        f"CONTENU SOUMIS :\n"
        f"- Titre : \"{title[:100]}\"\n"
        f"- Description : \"{description[:300]}\"\n"
        f"- Tags : {', '.join(tags_list[:10]) or 'aucun'}\n\n"
        f"RAPPORT VISUEL ({frames_analyzed} frames analysées par SmolVLM) :\n"
        f"{frames_summary}\n\n"
        f"ANALYSE ET DÉCISION :\n"
        f"1. Y a-t-il de la nudité, du contenu sexuel ou érotique dans les frames ou les textes ? (OUI/NON)\n"
        f"2. Y a-t-il de la violence, du sang ou des scènes choquantes ? (OUI/NON)\n"
        f"3. Y a-t-il de la haine, des insultes ou du harcèlement ? (OUI/NON)\n"
        f"4. Le titre et la description sont-ils appropriés ? (OUI/NON)\n"
        f"5. VERDICT : APPROUVÉ ou REFUSÉ ?\n"
        f"6. Score de qualité de 0 à 100 (80+=excellent, 60-79=bon, 40-59=moyen, <40=refusé)\n"
        f"7. Deux recommandations concrètes pour améliorer ce contenu.\n"
        f"8. Un titre amélioré.\n\n"
        f"Réponds clairement ligne par ligne, sois strict et factuel."
    )

    try:
        raw_synthesis = _run_llm(synthesis_prompt, max_tokens=400, temperature=0.1)
        if raw_synthesis is None:
            raw_synthesis = ""
        raw_synthesis = str(raw_synthesis)
        logger.info(f"🧠 moderate-full Mistral : {raw_synthesis[:300]}")
    except Exception as exc:
        logger.exception("❌ Erreur lors de l'appel LLM pour moderate-full")
        raise HTTPException(status_code=500, detail=f"LLM synthesis failed: {exc}")

    # ── 3. Parsing de la réponse Mistral ─────────────────────────────────
    synth_lower = (raw_synthesis or "").lower()
    synth_lines = [l.strip() for l in (raw_synthesis or "").split("\n") if l.strip()]

    # Détection des problèmes depuis les réponses OUI/NON
    detected_cats: List[str] = []
    for l in synth_lines:
        ll = l.lower()
        if "oui" in ll and any(w in ll for w in ("sexuel", "nudité", "érotique", "pornograph")):
            detected_cats.append("contenu_sexuel")
        if "oui" in ll and any(w in ll for w in ("violence", "sang", "choquant")):
            detected_cats.append("violence")
        if "oui" in ll and any(w in ll for w in ("haine", "insulte", "harcèlement")):
            detected_cats.append("harassment")

    # Verdict brut depuis la synthèse Mistral
    final_refused = "refusé" in synth_lower or "refuse" in synth_lower

    # Fallback : scan direct des descriptions de frames
    # N'est appliqué QUE si Mistral a déjà exprimé un doute — évite les faux positifs
    # sur des contenus scientifiques/artistiques mal décrits par SmolVLM
    if final_refused or detected_cats:
        for fa in frame_analyses:
            desc = fa["description"].lower()
            if any(w in desc for w in _sexual_kw):
                detected_cats.append("contenu_sexuel")
            if any(w in desc for w in _violence_kw):
                detected_cats.append("violence")
    detected_cats = list(set(detected_cats))

    approved = not final_refused and len(detected_cats) == 0

    # Extraire le score — strip du numéro de question en début de ligne (ex: "6. Score : 82")
    score = 65
    for l in synth_lines:
        ll = l.lower()
        if "score" in ll or "qualité" in ll or "/100" in ll:
            cleaned = re.sub(r'^\d+[\.)\-]\s*', '', l)  # enlève "6. " ou "6) " en tête
            nums = re.findall(r'\b([0-9]{1,3})\b', cleaned)
            for n in nums:
                v = int(n)
                if 10 <= v <= 100:  # ignore les chiffres uniques (numéros de question)
                    score = v
                    break

    if detected_cats or final_refused:
        score = min(score, 35)
        approved = False

    # Extraire les recommandations et le titre suggéré
    recommendations = []
    title_suggestions = []
    for l in synth_lines:
        ll = l.lower()
        if any(w in ll for w in ("recommand", "conseil", "améliorer", "suggestion")) and len(l) > 15:
            recommendations.append(l)
        if "titre" in ll and len(l) > 10:
            title_suggestions.append(l)
    recommendations = recommendations[:3]
    title_suggestions = title_suggestions[:2]

    # ── 4. Normalisation des valeurs ──────────────────────────────────────
    tier_raw = (
        "viral" if score >= 80
        else "trending" if score >= 65
        else "standard" if score >= 45
        else "rejected"
    )
    if not approved:
        tier_raw = "rejected"
    # Cohérence : si le score donne rejected, approved doit être False
    if tier_raw == "rejected":
        approved = False

    analysis_time = round(time.time() - start_time, 1)
    logger.info(
        f"✅ moderate-full done: approved={approved} score={score} "
        f"tier={tier_raw} frames={frames_analyzed} time={analysis_time}s"
    )

    reason_str = f"Catégories problématiques détectées : {', '.join(detected_cats)}" if detected_cats else "Contenu conforme."

    return {
        "approved": approved,
        "score": score,
        "tier": tier_raw,
        "reason": reason_str,
        "categories_detectees": detected_cats,
        "recommendations": recommendations[:5],
        "title_suggestions": title_suggestions[:3],
        "description_improved": description[:600],
        "frame_analyses": frame_analyses,
        "frames_analyzed": frames_analyzed,
        "analysis_time_seconds": analysis_time,
        "model": "SmolVLM-256M-Instruct",
    }


# ─────────────────────────────────────────────────────────────────────────────
# RECOMMANDATIONS YOUTUBE-STYLE ULTRA-AVANCÉES
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/recommend/feed")
async def recommend_feed(
    userId: Optional[str] = Query(None, description="ID utilisateur pour personnalisation"),
    limit: int = Query(20, ge=1, le=100, description="Nombre de vidéos"),
    category: Optional[str] = Query(None, description="Filtrer par catégorie/tag"),
    exclude_watched: bool = Query(True, description="Exclure les vidéos déjà vues"),
):
    """
    Feed personnalisé YouTube-style ultra-avancé.

    Algorithme en 5 étapes :
    1. Récupère l'historique de visionnage de l'utilisateur (MongoDB)
    2. Calcule l'embedding moyen des vidéos regardées (= goût utilisateur)
    3. Cosine similarity entre le profil utilisateur et toutes les vidéos indexées
    4. Boost par algorithm_score + trending_rank + vélocité des vues
    5. Fallback sur les tendances si pas d'historique
    """
    _ensure_index_fresh()

    if not video_index:
        return {
            "videos": [], "total": 0, "personalized": False,
            "reason": "Index vide — aucune vidéo approuvée disponible",
        }

    watched_ids: set = set()
    user_emb: Optional[np.ndarray] = None

    # Récupérer historique utilisateur depuis MongoDB
    if userId and mongo_db is not None:
        try:
            user = mongo_db.users.find_one(
                {"_id": userId},
                {"watchHistory": 1, "preferences": 1},
            )
            if user:
                watched_ids = {str(w) for w in user.get("watchHistory", [])}
                # Construire le vecteur de goût à partir des vidéos regardées
                watched_embs = [
                    video_index[wid]["embedding"]
                    for wid in watched_ids
                    if wid in video_index
                ]
                if watched_embs and _minilm_ready():
                    user_emb = np.mean(watched_embs, axis=0)
                elif _minilm_ready():
                    # Fallback sur les préférences textuelles
                    pref_text = " ".join(user.get("preferences", {}).get("categories", []))
                    if pref_text:
                        user_emb = minilm_model.encode([pref_text])[0]
        except Exception as exc:
            logger.warning(f"⚠️ Historique utilisateur : {exc}")

    all_entries = list(video_index.values())

    # Filtrer par catégorie
    if category:
        all_entries = [
            v for v in all_entries
            if category.lower() in " ".join(v["meta"].get("tags", [])).lower()
            or category.lower() in v["meta"].get("title", "").lower()
        ]

    # Exclure les vidéos déjà vues
    if exclude_watched and watched_ids:
        all_entries = [v for v in all_entries if v["meta"]["id"] not in watched_ids]

    # Scoring
    if user_emb is not None:
        # Mode personnalisé : combinaison cosine similarity + métriques d'engagement
        scored = []
        for v in all_entries:
            sim = _cosine_sim(user_emb, v["embedding"])
            algo = min(v["meta"].get("algorithm_score", 0) / 100.0, 1.0)
            trend = min(v["meta"].get("trending_rank", 0) / 100.0, 1.0)
            views_norm = min(v["meta"].get("views", 0) / 50000.0, 1.0)
            # Pondération : similarité 50%, algo 30%, vues 10%, trend 10%
            score = sim * 0.5 + algo * 0.3 + views_norm * 0.1 + trend * 0.1
            scored.append((score, v["meta"]))
        scored.sort(key=lambda x: x[0], reverse=True)
        videos = [m for _, m in scored[:limit]]
        personalized = True
    else:
        # Fallback tendances : trier par score algorithme + vues
        all_entries.sort(
            key=lambda v: (
                min(v["meta"].get("algorithm_score", 0) / 100.0, 1.0) * 0.6
                + min(v["meta"].get("views", 0) / 50000.0, 1.0) * 0.4
            ),
            reverse=True,
        )
        videos = [v["meta"] for v in all_entries[:limit]]
        personalized = False

    return {
        "videos": videos,
        "total": len(videos),
        "personalized": personalized,
        "user_id": userId,
        "index_size": len(video_index),
        "algorithm": "cosine_similarity+engagement" if personalized else "trending_fallback",
    }


@app.post("/recommend/similar")
async def recommend_similar(
    image: Optional[UploadFile] = File(None, description="Frame ou miniature de vidéo de référence"),
    query: Optional[str] = Form(None, description="Texte de recherche (alternatif à l'image)"),
    limit: int = Form(10, description="Nombre de résultats"),
    exclude_id: Optional[str] = Form(None, description="ID de la vidéo actuelle à exclure"),
    min_similarity: float = Form(0.1, description="Score de similarité minimal (0.0-1.0)"),
):
    """
    Trouve des vidéos similaires via recherche vectorielle.

    Pipeline : image → SmolVLM décrit la scène → MiniLM encode → cosine similarity sur l'index.
    """
    _ensure_index_fresh()

    if not video_index:
        return {"similar_videos": [], "total": 0, "reason": "Index vide"}

    if not _minilm_ready():
        raise HTTPException(status_code=503, detail="MiniLM non disponible pour les recommandations")

    search_text = query or ""

    # SmolVLM analyse l'image pour enrichir la recherche sémantique
    if image and _vlm_ready():
        raw_bytes = await image.read()
        if raw_bytes:
            vision_desc = _run_vision_prompt(
                raw_bytes,
                "Décris cette scène vidéo en détail : thème, sujet, objets, personnes, ambiance, activités.",
            )
            search_text = f"{search_text} {vision_desc}".strip()

    if not search_text:
        raise HTTPException(status_code=400, detail="Fournir une image ou un texte de recherche")

    query_emb = minilm_model.encode([search_text])[0]

    scored = [
        (_cosine_sim(query_emb, v["embedding"]), v["meta"])
        for vid_id, v in video_index.items()
        if not (exclude_id and vid_id == exclude_id)
    ]
    scored.sort(key=lambda x: x[0], reverse=True)

    results = [
        {**meta, "similarity_score": round(score, 4)}
        for score, meta in scored[:limit]
        if score >= min_similarity
    ]

    return {
        "similar_videos": results,
        "total": len(results),
        "search_context": search_text[:200],
        "vision_enhanced": image is not None and _vlm_ready(),
    }


@app.post("/recommend/score")
async def compute_video_score(
    video_id: str = Form(..., description="ID MongoDB de la vidéo"),
    views: Optional[int] = Form(0, description="Nombre de vues"),
    likes: Optional[int] = Form(0, description="Nombre de likes"),
    shares: Optional[int] = Form(0, description="Nombre de partages"),
    comments: Optional[int] = Form(0, description="Nombre de commentaires"),
    age_days: Optional[int] = Form(1, description="Âge de la vidéo en jours"),
    boost_active: Optional[bool] = Form(False, description="Boost Topocoin actif"),
    boost_multiplier: Optional[float] = Form(1.0, description="Multiplicateur de boost"),
):
    """
    Calcule le score algorithme YouTube-style et met à jour MongoDB.

    Formule :
      engagement (40%) + fraîcheur (30%) + vélocité (20%) + boost (10%)
    """
    v = max(views or 0, 1)
    l = likes or 0
    s = shares or 0
    c = comments or 0
    age = max(age_days or 1, 1)

    # Engagement : (likes + shares×2 + comments) / vues
    engagement_rate = (l + s * 2 + c) / v
    engagement_score = min(engagement_rate * 100, 40)  # max 40 pts

    # Fraîcheur : décroît exponentiellement (-5%/jour)
    freshness_score = max(0.0, 30 * (0.95 ** age))  # max 30 pts

    # Vélocité : vues/jour (plafonné à 20 pts)
    velocity = v / age
    velocity_score = min(velocity / 1000.0 * 20, 20)  # max 20 pts

    # Boost Topocoin
    boost_score = min(10.0 * (boost_multiplier or 1.0), 10) if boost_active else 0.0  # max 10 pts

    algorithm_score = round(engagement_score + freshness_score + velocity_score + boost_score, 2)
    trending_rank = (
        1 if algorithm_score >= 80
        else 2 if algorithm_score >= 60
        else 3 if algorithm_score >= 40
        else 4
    )

    # Mettre à jour MongoDB
    updated_in_db = False
    if mongo_db is not None:
        try:
            from bson import ObjectId  # type: ignore
            result = mongo_db.videos.update_one(
                {"_id": ObjectId(video_id)},
                {"$set": {"algorithm_score": algorithm_score, "trending_rank": trending_rank}},
            )
            updated_in_db = result.modified_count > 0
            # Forcer un rebuild de l'index au prochain appel
            global index_built_at
            index_built_at = 0.0
        except Exception as exc:
            logger.warning(f"⚠️ Mise à jour score MongoDB : {exc}")

    return {
        "video_id": video_id,
        "algorithm_score": algorithm_score,
        "trending_rank": trending_rank,
        "breakdown": {
            "engagement_score": round(engagement_score, 2),
            "freshness_score": round(freshness_score, 2),
            "velocity_score": round(velocity_score, 2),
            "boost_score": round(boost_score, 2),
        },
        "metrics": {
            "engagement_rate": round(engagement_rate, 4),
            "views_per_day": round(velocity, 1),
        },
        "updated_in_db": updated_in_db,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Entrée principale (local dev)
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("VLM_PORT", 8005))
    uvicorn.run("vlm_api:app", host="0.0.0.0", port=port, reload=False, log_level="info")

