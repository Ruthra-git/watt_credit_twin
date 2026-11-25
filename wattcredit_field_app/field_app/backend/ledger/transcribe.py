"""Server-side Tamil transcription. Pick a provider with WC_TRANSCRIBER:
  sarvam  - Sarvam AI speech-to-text REST API (hosted in India). Needs SARVAM_API_KEY.
  indic   - your own AI4Bharat IndicConformer service (INDIC_URL). The request/response
            contract below is OURS: wrap the model in a small server that honours it.
  vosk    - offline fallback, local vosk Tamil model (VOSK_MODEL_PATH) + ffmpeg.
  none    - store audio only; transcribe later.
Network providers use only the standard library so the backend needs no extra packages.
"""
import io
import json
import os
import subprocess
import tempfile
import urllib.request
import uuid

from django.conf import settings

from .amounts import extract_rupees

EXT = {"webm": "webm", "ogg": "ogg", "opus": "ogg", "wav": "wav", "mp4": "mp4", "mpeg": "mp3"}


def _ext(mime: str) -> str:
    m = (mime or "").lower()
    for k, v in EXT.items():
        if k in m:
            return v
    return "webm"


def _multipart(fields: dict, file_field: str, filename: str, content: bytes, ctype: str):
    boundary = uuid.uuid4().hex
    buf = io.BytesIO()
    for k, v in fields.items():
        buf.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    buf.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
              f'Content-Type: {ctype}\r\n\r\n'.encode())
    buf.write(content)
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


class Sarvam:
    name = "sarvam"
    URL = "https://api.sarvam.ai/speech-to-text"

    def transcribe(self, audio: bytes, mime: str) -> str:
        key = settings.SARVAM_API_KEY
        if not key:
            raise RuntimeError("SARVAM_API_KEY is not set")
        body, ctype = _multipart(
            {"model": settings.SARVAM_MODEL, "mode": "transcribe", "language_code": "ta-IN"},
            "file", f"note.{_ext(mime)}", audio, mime or "audio/webm")
        req = urllib.request.Request(self.URL, data=body, method="POST",
                                     headers={"api-subscription-key": key, "Content-Type": ctype})
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)["transcript"]


class IndicConformer:
    """POST multipart {audio, language=ta} to INDIC_URL, expect JSON {"text": "..."}."""
    name = "indic"

    def transcribe(self, audio: bytes, mime: str) -> str:
        if not settings.INDIC_URL:
            raise RuntimeError("INDIC_URL is not set")
        body, ctype = _multipart({"language": "ta"}, "audio", f"note.{_ext(mime)}", audio, mime or "audio/webm")
        req = urllib.request.Request(settings.INDIC_URL, data=body, method="POST", headers={"Content-Type": ctype})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)["text"]


class Vosk:
    name = "vosk"
    _model = None

    def transcribe(self, audio: bytes, mime: str) -> str:
        from vosk import KaldiRecognizer, Model  # optional dependency
        if not settings.VOSK_MODEL_PATH:
            raise RuntimeError("VOSK_MODEL_PATH is not set")
        if Vosk._model is None:
            Vosk._model = Model(settings.VOSK_MODEL_PATH)
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in." + _ext(mime))
            with open(src, "wb") as f:
                f.write(audio)
            pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
                                 capture_output=True, check=True).stdout
        rec = KaldiRecognizer(Vosk._model, 16000)
        rec.AcceptWaveform(pcm)
        return json.loads(rec.FinalResult()).get("text", "")


PROVIDERS = {"sarvam": Sarvam, "indic": IndicConformer, "vosk": Vosk}


def get_provider():
    cls = PROVIDERS.get(settings.WC_TRANSCRIBER)
    return cls() if cls else None


def llm_amount(text: str):
    """Optional second opinion. Set settings.LLM_AMOUNT_EXTRACTOR to a dotted path of a
    function f(text) -> int|None to use an LLM when the regex parser is unsure."""
    path = getattr(settings, "LLM_AMOUNT_EXTRACTOR", "")
    if not path:
        return None
    mod, fn = path.rsplit(".", 1)
    return getattr(__import__(mod, fromlist=[fn]), fn)(text)


def _sarvam_minutes_today() -> float:
    from datetime import timedelta

    from django.db.models import Sum
    from django.utils import timezone

    from .models import DailySale
    since = timezone.now() - timedelta(hours=24)
    ms = DailySale.objects.filter(provider="sarvam", received_at__gte=since).aggregate(s=Sum("audio_ms"))["s"] or 0
    return ms / 60000


def transcribe_sale(sale) -> str:
    """Transcribe one DailySale that has audio. Updates and saves it. Returns status."""
    prov = get_provider()
    if prov is None:
        return sale.status
    if prov.name == "sarvam" and _sarvam_minutes_today() >= settings.SARVAM_DAILY_MINUTES:
        # Spend guard: stop calling the paid API once today's allowance is used. The audio stays stored.
        sale.status, sale.error = "pending_transcription", "daily Sarvam limit reached: will retry tomorrow or set amount by hand"
        sale.save()
        return sale.status
    try:
        with open(sale.audio_path, "rb") as f:
            text = prov.transcribe(f.read(), sale.audio_mime)
    except Exception as e:  # network, auth, model errors: keep the audio, retry later
        sale.status, sale.error = "transcription_failed", f"{prov.name}: {e}"[:300]
        sale.save()
        return sale.status
    res = extract_rupees(text)
    amount = res["amount"]
    if res["confidence"] != "high":
        try:
            alt = llm_amount(text)
            if alt:
                amount, res["confidence"] = int(alt), "llm"
        except Exception:
            pass
    sale.transcript, sale.provider, sale.error = text, prov.name, ""
    if amount is not None and res["confidence"] in ("high", "llm"):
        sale.amount_paise, sale.status = amount * 100, "transcribed"
    else:
        sale.amount_paise, sale.status = None, "needs_review"
    sale.save()
    return sale.status
