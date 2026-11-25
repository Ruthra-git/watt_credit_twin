import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-change-me")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.staticfiles", "ledger"]
MIDDLEWARE = ["django.middleware.security.SecurityMiddleware", "django.middleware.common.CommonMiddleware"]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
MEDIA_ROOT = os.environ.get("WC_MEDIA_ROOT", str(BASE_DIR / "media"))
DATA_UPLOAD_MAX_MEMORY_SIZE = 8 * 1024 * 1024  # a batch of voice notes

# Transcription: sarvam | indic | vosk | none
WC_TRANSCRIBER = os.environ.get("WC_TRANSCRIBER", "none")
SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")
SARVAM_MODEL = os.environ.get("SARVAM_MODEL", "saaras:v3")  # Sarvam lists saaras:v4 as the current default
INDIC_URL = os.environ.get("INDIC_URL", "")
VOSK_MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", "")
TRANSCRIBE_INLINE = os.environ.get("WC_TRANSCRIBE_INLINE", "0") == "1"
LLM_AMOUNT_EXTRACTOR = os.environ.get("WC_LLM_AMOUNT_EXTRACTOR", "")
SARVAM_DAILY_MINUTES = float(os.environ.get("WC_SARVAM_DAILY_MINUTES", "5"))  # spend guard: 5 min is about Rs 2.5 a day
