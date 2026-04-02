"""
UnifiedAgent — SmolVLM-256M-Instruct (4-bit NF4, CUDA 13.1 / cu130)
=====================================================================
Charge HuggingFaceTB/SmolVLM-256M-Instruct en quantisation 4-bit NF4
sur GPU CUDA (cu130). Fallback automatique CPU float32 si pas de GPU.

Interface compatible avec chat_agent_api.py :
  self.tools = {
      "vision":    ToolStatus(is_ready=True/False),
      "llm":       ToolStatus(is_ready=True/False),
      "detection": ToolStatus(is_ready=False),  # YOLO non intégré
  }
  process_image(image_path, question, detect_objects) -> dict
  chat(message, with_voice, context) -> dict
  generate(prompt, **kwargs) -> str
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger("unified_agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

class ToolStatus:
    """Objet minimal simulant un outil avec attribut is_ready."""
    def __init__(self, is_ready: bool):
        self.is_ready = is_ready


def _find_model_snapshot(base_dir: str) -> str:
    """Retourne le chemin exact du snapshot HuggingFace (snapshots/<hash>/)."""
    snapshots_dir = Path(base_dir) / "snapshots"
    if snapshots_dir.is_dir():
        snapshots = sorted(snapshots_dir.iterdir())
        if snapshots:
            logger.info(f"📂 Snapshot trouvé : {snapshots[-1]}")
            return str(snapshots[-1])
    return base_dir


# ─────────────────────────────────────────────────────────────────────────────
# Agent principal
# ─────────────────────────────────────────────────────────────────────────────

class UnifiedAgent:
    """
    Agent IA basé sur SmolVLM-256M-Instruct chargé en 4-bit NF4.

    Paramètres (tous optionnels, compatibles avec l'ancien stub) :
        model_path       – Chemin vers le dossier HuggingFace du modèle
        enable_llm       – Si False, le modèle n'est pas chargé (mode stub)
        enable_vision    – Ignoré (SmolVLM est vision + texte par design)
        enable_detection – Ignoré (YOLO non intégré)
        enable_voice     – Ignoré (TTS non intégré)
    """

    MODEL_ENV = "SMOLVLM_MODEL_PATH"
    DEFAULT_MODEL_PATH = "/models/smolvlm"

    def __init__(
        self,
        model_path: str = None,
        enable_voice: bool = False,
        enable_vision: bool = True,
        enable_detection: bool = False,
        enable_llm: bool = True,
        **kwargs,
    ):
        self.tools = {
            "vision":    ToolStatus(False),
            "llm":       ToolStatus(False),
            "detection": ToolStatus(False),  # YOLO non implémenté
        }
        self.processor = None
        self.model = None
        self._device = "cpu"

        if not enable_llm:
            logger.warning("⚠️ UnifiedAgent : enable_llm=False → mode stub sans chargement modèle.")
            return

        # Résoudre le chemin
        raw_path = (
            model_path
            or os.environ.get(self.MODEL_ENV)
            or self.DEFAULT_MODEL_PATH
        )
        resolved_path = _find_model_snapshot(raw_path)
        logger.info(f"🔍 Chemin SmolVLM résolu : {resolved_path}")
        self._load_model(resolved_path)

    # ─────────────────────────────────────────────────────────────────────────
    # Chargement du modèle
    # ─────────────────────────────────────────────────────────────────────────

    def _load_model(self, model_path: str):
        try:
            import torch
            # AutoModelForVision2Seq was renamed to AutoModelForImageTextToText in transformers 5.x
            try:
                from transformers import AutoModelForImageTextToText as _VisionModel
            except ImportError:
                from transformers import AutoModelForVision2Seq as _VisionModel
            from transformers import AutoProcessor, BitsAndBytesConfig

            cuda_ok = torch.cuda.is_available()
            device_name = torch.cuda.get_device_name(0) if cuda_ok else "CPU"
            logger.info(f"🖥️ CUDA disponible : {cuda_ok}  ({device_name})")

            # Charger le processor
            self.processor = AutoProcessor.from_pretrained(
                model_path,
                local_files_only=True,
            )
            logger.info("✅ Processeur SmolVLM chargé")

            if cuda_ok:
                # Quantisation 4-bit NF4 sur GPU (CUDA 13.1 / cu130)
                quant_cfg = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_use_double_quant=True,
                )
                self.model = _VisionModel.from_pretrained(
                    model_path,
                    quantization_config=quant_cfg,
                    device_map="auto",
                    torch_dtype=torch.float16,
                    local_files_only=True,
                )
                self._device = "cuda"
                logger.info("✅ SmolVLM-256M chargé en 4-bit NF4 sur GPU CUDA")
            else:
                # Fallback CPU float32
                logger.warning("⚠️ Pas de GPU CUDA — chargement SmolVLM en float32 sur CPU (lent)")
                self.model = _VisionModel.from_pretrained(
                    model_path,
                    device_map="cpu",
                    torch_dtype=torch.float32,
                    local_files_only=True,
                )
                self._device = "cpu"
                logger.info("✅ SmolVLM-256M chargé en float32 sur CPU")

            self.tools["vision"].is_ready = True
            self.tools["llm"].is_ready = True
            logger.info("🚀 SmolVLM-256M-Instruct prêt (vision + texte)")

        except Exception as exc:
            logger.error(f"❌ Erreur chargement SmolVLM : {exc}")
            self.processor = None
            self.model = None

    # ─────────────────────────────────────────────────────────────────────────
    # Génération interne bas-niveau
    # ─────────────────────────────────────────────────────────────────────────

    def _generate_text(
        self,
        prompt: str,
        images=None,           # list[PIL.Image] ou None
        max_new_tokens: int = 500,
        temperature: float = 0.7,
    ) -> str:
        """Appel bas-niveau au modèle SmolVLM."""
        import torch

        if self.model is None or self.processor is None:
            return "Modèle SmolVLM non disponible."

        # Construire le payload messages
        content = []
        if images:
            for _ in images:
                content.append({"type": "image"})
        content.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content}]

        # Tokeniser
        text_prompt = self.processor.apply_chat_template(
            messages, add_generation_prompt=True
        )
        inputs = self.processor(
            text=text_prompt,
            images=images if images else None,
            return_tensors="pt",
            padding=True,
        )

        # Déplacer vers GPU si disponible
        if self._device == "cuda":
            inputs = {k: v.to("cuda") for k, v in inputs.items()}

        # Générer
        with torch.no_grad():
            generated_ids = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=temperature > 0,
                temperature=temperature if temperature > 0 else None,
                pad_token_id=(
                    self.processor.tokenizer.pad_token_id
                    or self.processor.tokenizer.eos_token_id
                    or 0
                ),
            )

        # Décoder uniquement les nouveaux tokens
        input_len = inputs["input_ids"].shape[1]
        new_tokens = generated_ids[:, input_len:]
        result = self.processor.batch_decode(new_tokens, skip_special_tokens=True)
        return result[0].strip() if result else ""

    # ─────────────────────────────────────────────────────────────────────────
    # API publique — compatibilité chat_agent_api.py
    # ─────────────────────────────────────────────────────────────────────────

    def generate(self, prompt: str, max_tokens: int = 300, temperature: float = 0.7, **kwargs) -> str:
        """Génération texte pur (sans image)."""
        if not self.tools["llm"].is_ready:
            return "Modèle IA SmolVLM non disponible."
        return self._generate_text(
            prompt=prompt,
            max_new_tokens=max_tokens,
            temperature=temperature,
        )

    def process_image(
        self,
        image_path: str,
        question: str = "Analyse cette image en détail avec tous les objets visibles.",
        detect_objects: bool = False,
        **kwargs,
    ) -> dict:
        """
        Analyse une image avec SmolVLM-256M.

        Retourne :
          {
            "vision":     {"description": str},
            "detection":  None,
            "synthesis":  str,
            "tools_used": [str],
          }
        """
        if not self.tools["vision"].is_ready:
            return {"error": "Vision non disponible", "tools_used": ["Mode Basique"]}

        try:
            from PIL import Image

            image = Image.open(image_path).convert("RGB")

            # Description détaillée
            description = self._generate_text(
                prompt=question,
                images=[image],
                max_new_tokens=500,
                temperature=0.3,
            )

            # Synthèse en une phrase
            synthesis = self._generate_text(
                prompt="En une seule phrase concise, résume ce que montre cette image.",
                images=[image],
                max_new_tokens=80,
                temperature=0.2,
            )

            image.close()

            return {
                "vision":     {"description": description},
                "detection":  None,
                "synthesis":  synthesis,
                "tools_used": ["SmolVLM-256M-4bit"],
            }

        except Exception as exc:
            logger.error(f"❌ process_image : {exc}")
            return {
                "error": str(exc),
                "vision": {"description": ""},
                "detection": None,
                "synthesis": "",
                "tools_used": ["SmolVLM-256M-4bit (erreur)"],
            }

    def chat(
        self,
        message: str,
        with_voice: bool = False,
        context: dict = None,
        history: list = None,
        **kwargs,
    ) -> dict:
        """
        Génère une réponse textuelle.
        Retourne : {"response": str}
        """
        ctx = context or {}
        max_tokens = ctx.get("max_tokens", 300)
        temperature = ctx.get("temperature", 0.7)

        response = self.generate(message, max_tokens=max_tokens, temperature=temperature)
        return {"response": response}

    def describe_image(self, image, **kwargs) -> str:
        """Alias pour compatibilité — accepte PIL.Image ou chemin fichier."""
        try:
            from PIL import Image as PilImage
            if isinstance(image, str):
                result = self.process_image(image, **kwargs)
            else:
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                    image.save(tmp.name)
                    result = self.process_image(tmp.name, **kwargs)
                    os.unlink(tmp.name)
            return result.get("vision", {}).get("description", "")
        except Exception as exc:
            logger.error(f"❌ describe_image : {exc}")
            return ""

    def detect_objects(self, image, **kwargs) -> list:
        """YOLO non intégré — retourne liste vide."""
        return []

    def speak(self, text: str, **kwargs) -> bytes:
        """TTS non intégré — retourne bytes vides."""
        return b""
