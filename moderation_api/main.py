"""
FastAPI Moderation API — SETRAF Center
Utilise sentence-transformers/all-MiniLM-L6-v2 (modèle local)
Plus robuste que l'algorithme YouTube : détection sémantique multi-classes
Port : 8001
"""

import os
import sys
import glob
import asyncio
from pathlib import Path
from typing import Optional, List
import numpy as np  # type: ignore[import]
from fastapi import FastAPI, HTTPException, BackgroundTasks  # type: ignore[import]
from fastapi.middleware.cors import CORSMiddleware  # type: ignore[import]
from pydantic import BaseModel  # type: ignore[import]
import uvicorn  # type: ignore[import]
from dotenv import load_dotenv  # type: ignore[import]

# ── Chargement .env depuis center-backend ──────────────────────────────────
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path)
else:
    load_dotenv()

# ── Résolution du modèle local ──────────────────────────────────────────────
def _find_model_path() -> str:
    """Trouve le chemin du snapshot local all-MiniLM-L6-v2.
    
    Priorité:
    1. Variable d'environnement MINILM_MODEL_PATH (Docker volume)
    2. Dossier frontend-center (développement local)
    3. Cache HuggingFace local
    4. Fallback : téléchargement HF online
    """
    # 1. Variable d'environnement explicite (Docker)
    env_path = os.getenv("MINILM_MODEL_PATH", "")
    if env_path and Path(env_path).exists():
        return env_path

    # 2. Chercher dans MODEL_CACHE_DIR ou frontend-center (développement local)
    possible_roots = [
        Path(os.getenv("MODEL_CACHE_DIR", "")),
        Path(__file__).parent.parent.parent / "frontend-center",
        Path.home() / ".cache" / "huggingface" / "hub",
    ]
    for root in possible_roots:
        if not root or not root.exists():
            continue
        snapshots = glob.glob(
            str(root / "models--sentence-transformers--all-MiniLM-L6-v2" / "snapshots" / "*")
        )
        if snapshots:
            return snapshots[0]
    # Fallback : nom HF (téléchargement online si absent)
    return "sentence-transformers/all-MiniLM-L6-v2"

MODEL_PATH = _find_model_path()
print(f"📦 Modèle chargé depuis : {MODEL_PATH}")

# ── Chargement du modèle (lazy, au 1er appel) ──────────────────────────────
_model = None
_model_lock = asyncio.Lock()

def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer  # type: ignore[import]
        _model = SentenceTransformer(MODEL_PATH)
        print("✅ Modèle sentence-transformers chargé")
    return _model


# ── Anchors sémantiques par catégorie ─────────────────────────────────────
TOXIC_ANCHORS = [
    "va te faire foutre espèce de déchet",
    "je vais te tuer sale idiot",
    "t'es qu'un sous-humain inutile",
    "ferme ta gueule connard de merde",
    "you should kill yourself loser",
    "die in a fire you piece of garbage",
    "I hate you so much, worthless scum",
]

SPAM_ANCHORS = [
    "clique ici pour gagner de l'argent rapidement",
    "offre limitée achetez maintenant livraison gratuite",
    "click here to win a free iPhone right now",
    "buy followers cheap guaranteed results promotion",
    "earn money from home work from home scam",
    "loterie gagnez des millions inscription gratuite",
]

HATE_ANCHORS = [
    "les étrangers doivent rentrer chez eux",
    "je déteste les gens de cette race",
    "cette religion devrait être interdite",
    "les femmes ne devraient pas travailler",
    "ethnic group inferior should be eliminated",
    "discriminate against minority group always",
]

SEXUAL_ANCHORS = [
    "vidéo sexuelle explicite adulte nue",
    "photos pornographiques adultes contenu explicite",
    "explicit sexual content nude adult material",
    "pornographic images adult only nsfw content",
]

QUALITY_ANCHORS = [
    "voici une analyse approfondie du sujet avec des détails",
    "je partage cette expérience enrichissante avec la communauté",
    "découvrez notre projet innovant et les résultats obtenus",
    "rapport complet avec données et conclusions argumentées",
    "informative educational content sharing knowledge with everyone",
    "professional quality content well explained detailed analysis",
]

_anchor_embeddings: dict = {}

def _ensure_anchors():
    """Pré-calcule les embeddings des anchors."""
    global _anchor_embeddings
    if _anchor_embeddings:
        return
    model = _get_model()
    _anchor_embeddings = {
        "toxic":   model.encode(TOXIC_ANCHORS,   normalize_embeddings=True),
        "spam":    model.encode(SPAM_ANCHORS,     normalize_embeddings=True),
        "hate":    model.encode(HATE_ANCHORS,     normalize_embeddings=True),
        "sexual":  model.encode(SEXUAL_ANCHORS,   normalize_embeddings=True),
        "quality": model.encode(QUALITY_ANCHORS,  normalize_embeddings=True),
    }
    print("✅ Anchor embeddings prêts")


def _cosine_max(embedding: np.ndarray, anchors: np.ndarray) -> float:
    """Retourne le score de similarité cosine max contre un groupe d'anchors."""
    scores = np.dot(anchors, embedding)  # anchors already normalized
    return float(np.max(scores))


def _moderate_text(text: str) -> dict:
    """Modère un texte. Retourne les scores 0-1 pour chaque catégorie."""
    model = _get_model()
    _ensure_anchors()

    emb = model.encode([text], normalize_embeddings=True)[0]

    toxic_score   = _cosine_max(emb, _anchor_embeddings["toxic"])
    spam_score    = _cosine_max(emb, _anchor_embeddings["spam"])
    hate_score    = _cosine_max(emb, _anchor_embeddings["hate"])
    sexual_score  = _cosine_max(emb, _anchor_embeddings["sexual"])
    quality_score = _cosine_max(emb, _anchor_embeddings["quality"])

    # Normalization — cosine similarity de phrase-transformers est [-1, 1]
    # On ramène à [0, 1] avec clip
    toxic_score   = float(np.clip(toxic_score,  0, 1))
    spam_score    = float(np.clip(spam_score,   0, 1))
    hate_score    = float(np.clip(hate_score,   0, 1))
    sexual_score  = float(np.clip(sexual_score, 0, 1))
    quality_score = float(np.clip(quality_score, 0, 1))

    # Score global de dangerosité
    danger_score = max(toxic_score, spam_score, hate_score, sexual_score)

    # Décision algorithmique
    DANGER_THRESHOLD = 0.45
    SPAM_THRESHOLD   = 0.42
    QUALITY_MIN      = 0.20

    approved  = danger_score < DANGER_THRESHOLD
    flags: List[str] = []
    if toxic_score   >= DANGER_THRESHOLD: flags.append("toxic")
    if spam_score    >= SPAM_THRESHOLD:   flags.append("spam")
    if hate_score    >= DANGER_THRESHOLD: flags.append("hate_speech")
    if sexual_score  >= DANGER_THRESHOLD: flags.append("sexual_content")

    # Score de promotion (algorithme SETRAF — plus robuste que YouTube)
    # Prend en compte : qualité sémantique, longueur, absence de spam, fraîcheur
    text_len_bonus = min(len(text) / 500, 1.0)  # max bonus à 500 chars
    promo_score = (
        quality_score * 0.45
        + text_len_bonus * 0.20
        + (1 - spam_score) * 0.25
        + (1 - danger_score) * 0.10
    )
    promo_score = float(np.clip(promo_score, 0, 1))

    # Tier de promotion
    if promo_score >= 0.75:
        promo_tier = "viral_candidate"
    elif promo_score >= 0.55:
        promo_tier = "high_quality"
    elif promo_score >= 0.35:
        promo_tier = "standard"
    else:
        promo_tier = "low_quality"

    return {
        "approved": approved,
        "scores": {
            "toxic":    round(toxic_score,  4),
            "spam":     round(spam_score,   4),
            "hate":     round(hate_score,   4),
            "sexual":   round(sexual_score, 4),
            "quality":  round(quality_score, 4),
            "danger":   round(danger_score,  4),
        },
        "flags":        flags,
        "promo_score":  round(promo_score, 4),
        "promo_tier":   promo_tier,
        "promotion_eligible": approved and promo_score >= 0.35,
    }


def _compute_similarity(text_a: str, text_b: str) -> float:
    """Calcule la similarité cosine entre deux textes (déduplication)."""
    model = _get_model()
    embs = model.encode([text_a, text_b], normalize_embeddings=True)
    return float(np.dot(embs[0], embs[1]))


# ── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(
    title="SETRAF Content Moderation API",
    description="Modération sémantique plus robuste que l'algorithme YouTube — powered by all-MiniLM-L6-v2",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Schémas ──────────────────────────────────────────────────────────────
class ModerateRequest(BaseModel):
    text: str
    author_id: Optional[str] = None
    content_type: Optional[str] = "post"  # post | comment | story | live | bio


class BatchModerateRequest(BaseModel):
    texts: List[str]
    content_type: Optional[str] = "post"


class SimilarityRequest(BaseModel):
    text_a: str
    text_b: str


class AlgorithmRequest(BaseModel):
    text: str
    author_followers: int = 0
    author_avg_engagement: float = 0.0
    media_count: int = 0
    has_video: bool = False
    has_image: bool = False
    boost_multiplier: float = 1.0    # payé avec Topocoin
    recency_hours: float = 1.0       # heures depuis publication


# ── Endpoints ──────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_PATH, "version": "2.0.0"}


@app.post("/moderate")
async def moderate(req: ModerateRequest):
    """Modère un texte. Retourne scores + flags + tier de promotion."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Texte vide")
    try:
        result = _moderate_text(req.text)
        result["author_id"] = req.author_id
        result["content_type"] = req.content_type
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur modèle : {str(e)}")


@app.post("/moderate/batch")
async def moderate_batch(req: BatchModerateRequest):
    """Modère plusieurs textes en une seule requête."""
    if not req.texts:
        raise HTTPException(status_code=400, detail="Liste vide")
    results = []
    for text in req.texts[:50]:  # max 50 textes
        if text.strip():
            results.append(_moderate_text(text))
        else:
            results.append({"approved": True, "flags": [], "promo_score": 0.3})
    return {"results": results, "count": len(results)}


@app.post("/similarity")
async def similarity(req: SimilarityRequest):
    """Calcule la similarité entre deux textes (déduplication de contenu)."""
    try:
        score = _compute_similarity(req.text_a, req.text_b)
        is_duplicate = score > 0.92
        return {
            "similarity": round(score, 4),
            "is_duplicate": is_duplicate,
            "label": "duplicate" if is_duplicate else ("similar" if score > 0.75 else "different"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/algorithm/score")
async def algorithm_score(req: AlgorithmRequest):
    """
    Algorithme de recommandation SETRAF.
    Score final = f(qualité, engagement, médias, fraîcheur, boost payé)
    Plus robuste que YouTube : pénalise le spam sémantique, récompense la qualité.
    """
    try:
        moderation = _moderate_text(req.text)
        if not moderation["approved"]:
            return {
                "score": 0.0,
                "tier": "blocked",
                "reason": moderation["flags"],
                "moderation": moderation,
            }

        promo_score = moderation["promo_score"]

        # Bonus engagement followers (logarithmique comme YT)
        import math
        follower_bonus = math.log1p(req.author_followers) / 20.0
        follower_bonus = min(follower_bonus, 0.15)

        # Bonus engagement moyen
        engagement_bonus = min(req.author_avg_engagement / 100.0, 0.15)

        # Bonus médias
        media_bonus = 0.0
        if req.has_video:   media_bonus += 0.12
        elif req.has_image: media_bonus += 0.07
        media_bonus += min(req.media_count * 0.02, 0.06)

        # Décroissance temporelle (exponentielle)
        decay = math.exp(-0.05 * req.recency_hours)

        # Score brut
        raw_score = (
            promo_score * 0.40
            + follower_bonus
            + engagement_bonus
            + media_bonus
        ) * decay

        # Multiplicateur boost Topocoin (payé)
        final_score = min(raw_score * req.boost_multiplier, 1.0)

        if final_score >= 0.75:   tier = "viral"
        elif final_score >= 0.55: tier = "trending"
        elif final_score >= 0.35: tier = "recommended"
        elif final_score >= 0.15: tier = "standard"
        else:                      tier = "hidden"

        return {
            "score":      round(final_score, 4),
            "raw_score":  round(raw_score,   4),
            "tier":       tier,
            "promo_score": promo_score,
            "decay":      round(decay, 4),
            "moderation": moderation,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    port = int(os.getenv("MODERATION_PORT", 8001))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
