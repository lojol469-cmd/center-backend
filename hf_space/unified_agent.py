"""
UnifiedAgent — SmolVLM-256M-Instruct (HuggingFace Hub)
=======================================================
Charge HuggingFaceTB/SmolVLM-256M-Instruct depuis le Hub.
Quantisation 4-bit NF4 si GPU disponible, sinon float32 CPU.
Compatible Hugging Face Spaces (ZeroGPU ou CPU gratuit).
"""

import logging
import os

logger = logging.getLogger("unified_agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct"


class ToolStatus:
    def __init__(self, is_ready: bool):
        self.is_ready = is_ready


class UnifiedAgent:
    """
    Agent IA SmolVLM-256M-Instruct — chargement depuis HuggingFace Hub.
    Quantisation 4-bit NF4 sur GPU, float32 CPU en fallback.
    """

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
            "detection": ToolStatus(False),
        }
        self.processor = None
        self.model = None
        self._device = "cpu"
        self._model_id = model_path or os.environ.get("SMOLVLM_MODEL_ID", MODEL_ID)

        if not enable_llm:
            logger.warning("⚠️ UnifiedAgent : enable_llm=False → mode stub.")
            return

        self._load_model()

    # ─────────────────────────────────────────────────────────────────────────

    def _load_model(self):
        try:
            import torch
            # transformers 5.x: AutoModelForImageTextToText (ex-Vision2Seq)
            try:
                from transformers import AutoModelForImageTextToText as _VisionModel
            except ImportError:
                from transformers import AutoModelForVision2Seq as _VisionModel
            from transformers import AutoProcessor, BitsAndBytesConfig

            cuda_ok = torch.cuda.is_available()
            device_name = torch.cuda.get_device_name(0) if cuda_ok else "CPU"
            logger.info(f"🖥️ CUDA: {cuda_ok}  ({device_name})")

            logger.info(f"⬇️ Chargement du processor : {self._model_id}")
            self.processor = AutoProcessor.from_pretrained(self._model_id)
            logger.info("✅ Processor SmolVLM chargé")

            if cuda_ok:
                quant_cfg = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_use_double_quant=True,
                )
                self.model = _VisionModel.from_pretrained(
                    self._model_id,
                    quantization_config=quant_cfg,
                    device_map="auto",
                    torch_dtype=torch.float16,
                )
                self._device = "cuda"
                logger.info("✅ SmolVLM-256M chargé 4-bit NF4 GPU")
            else:
                logger.warning("⚠️ Pas de GPU — chargement CPU float32")
                self.model = _VisionModel.from_pretrained(
                    self._model_id,
                    device_map="cpu",
                    torch_dtype=torch.float32,
                )
                self._device = "cpu"
                logger.info("✅ SmolVLM-256M chargé float32 CPU")

            self.tools["vision"].is_ready = True
            self.tools["llm"].is_ready = True
            logger.info("🚀 SmolVLM-256M-Instruct prêt")

        except Exception as exc:
            logger.error(f"❌ Erreur chargement SmolVLM : {exc}")
            self.processor = None
            self.model = None

    # ─────────────────────────────────────────────────────────────────────────

    def _generate_text(
        self,
        prompt: str,
        images=None,
        max_new_tokens: int = 500,
        temperature: float = 0.7,
    ) -> str:
        import torch

        if self.model is None or self.processor is None:
            return "Modèle SmolVLM non disponible."

        content = []
        if images:
            for _ in images:
                content.append({"type": "image"})
        content.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content}]

        text_prompt = self.processor.apply_chat_template(
            messages, add_generation_prompt=True
        )
        inputs = self.processor(
            text=text_prompt,
            images=images if images else None,
            return_tensors="pt",
            padding=True,
        )

        if self._device == "cuda":
            inputs = {k: v.to("cuda") for k, v in inputs.items()}

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

        input_len = inputs["input_ids"].shape[1]
        new_tokens = generated_ids[:, input_len:]
        result = self.processor.batch_decode(new_tokens, skip_special_tokens=True)
        return result[0].strip() if result else ""

    # ─────────────────────────────────────────────────────────────────────────
    # API publique
    # ─────────────────────────────────────────────────────────────────────────

    def generate(self, prompt: str, max_tokens: int = 300, temperature: float = 0.7, **kwargs) -> str:
        if not self.tools["llm"].is_ready:
            return "Modèle IA SmolVLM non disponible."
        return self._generate_text(prompt=prompt, max_new_tokens=max_tokens, temperature=temperature)

    def process_image(self, image_path: str, question: str = "Analyse cette image en détail.", detect_objects: bool = False, **kwargs) -> dict:
        if not self.tools["vision"].is_ready:
            return {"error": "Vision non disponible", "tools_used": ["Mode Basique"]}
        try:
            from PIL import Image
            image = Image.open(image_path).convert("RGB")
            description = self._generate_text(prompt=question, images=[image], max_new_tokens=500, temperature=0.3)
            synthesis = self._generate_text(
                prompt="En une seule phrase concise, résume ce que montre cette image.",
                images=[image], max_new_tokens=80, temperature=0.2,
            )
            image.close()
            return {
                "vision":     {"description": description},
                "detection":  None,
                "synthesis":  synthesis,
                "tools_used": ["SmolVLM-256M"],
            }
        except Exception as exc:
            logger.error(f"❌ process_image : {exc}")
            return {"error": str(exc), "vision": {"description": ""}, "detection": None, "synthesis": "", "tools_used": []}

    def chat(self, message: str, with_voice: bool = False, context: dict = None, history: list = None, **kwargs) -> dict:
        ctx = context or {}
        response = self.generate(message, max_tokens=ctx.get("max_tokens", 300), temperature=ctx.get("temperature", 0.7))
        return {"response": response}

    def describe_image(self, image, **kwargs) -> str:
        try:
            import tempfile, os
            from PIL import Image as PilImage
            if isinstance(image, str):
                result = self.process_image(image, **kwargs)
            else:
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                    image.save(tmp.name)
                    result = self.process_image(tmp.name, **kwargs)
                    os.unlink(tmp.name)
            return result.get("vision", {}).get("description", "")
        except Exception as exc:
            logger.error(f"❌ describe_image : {exc}")
            return ""

    def detect_objects(self, image, **kwargs) -> list:
        return []

    def speak(self, text: str, **kwargs) -> bytes:
        return b""
