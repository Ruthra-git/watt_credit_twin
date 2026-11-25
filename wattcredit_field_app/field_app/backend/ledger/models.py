from django.db import models

from .evidence import ZERO_HASH


class Officer(models.Model):
    """A device credential (the officer's stored token): public half of an ECDSA P-256 key."""
    officer_id = models.CharField(max_length=40, primary_key=True)
    name = models.CharField(max_length=120, blank=True)
    public_jwk = models.JSONField()


class Plug(models.Model):
    plug_id = models.CharField(max_length=40, primary_key=True)
    entrepreneur_id = models.CharField(max_length=40, blank=True)
    public_jwk = models.JSONField()
    last_seq = models.PositiveIntegerField(default=0)
    last_hash = models.CharField(max_length=64, default=ZERO_HASH)


class ShiftBlock(models.Model):
    plug = models.ForeignKey(Plug, on_delete=models.CASCADE, related_name="blocks")
    seq = models.PositiveIntegerField()
    t_start = models.BigIntegerField()
    t_end = models.BigIntegerField()
    work_min = models.PositiveIntegerField()
    idle_min = models.PositiveIntegerField()
    other_min = models.PositiveIntegerField()
    credited_mwh = models.PositiveIntegerField()
    vrms_dv = models.PositiveIntegerField()
    irms_ca = models.PositiveIntegerField()
    trips = models.PositiveIntegerField()
    prev_hash = models.CharField(max_length=64)
    hash = models.CharField(max_length=64)
    sig = models.CharField(max_length=128)
    submitted_by = models.CharField(max_length=40)
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("plug", "seq")
        ordering = ["plug_id", "seq"]


class DailySale(models.Model):
    STATUS = [("confirmed", "confirmed"), ("pending_transcription", "pending_transcription"),
              ("transcribed", "transcribed"), ("needs_review", "needs_review"),
              ("transcription_failed", "transcription_failed")]
    client_id = models.CharField(max_length=64, primary_key=True)
    entrepreneur_id = models.CharField(max_length=40)
    plug_id = models.CharField(max_length=40, blank=True)
    at_ms = models.BigIntegerField()
    source = models.CharField(max_length=10)  # keypad | voice
    amount_paise = models.BigIntegerField(null=True, blank=True)
    status = models.CharField(max_length=24, choices=STATUS)
    audio_path = models.CharField(max_length=300, blank=True)
    audio_mime = models.CharField(max_length=60, blank=True)
    audio_ms = models.PositiveIntegerField(default=0)
    transcript = models.TextField(blank=True)
    provider = models.CharField(max_length=20, blank=True)
    error = models.CharField(max_length=300, blank=True)
    submitted_by = models.CharField(max_length=40)
    received_at = models.DateTimeField(auto_now_add=True)


class TamperAlert(models.Model):
    plug_id = models.CharField(max_length=40)
    seq = models.PositiveIntegerField()
    reason = models.CharField(max_length=300)
    submitted_by = models.CharField(max_length=40)
    received_at = models.DateTimeField(auto_now_add=True)


class IngestRecord(models.Model):
    """Idempotency log: one row per client record id that reached a final state."""
    client_id = models.CharField(max_length=80, primary_key=True)
    status = models.CharField(max_length=12)
    reason = models.CharField(max_length=300, blank=True)
    received_at = models.DateTimeField(auto_now_add=True)
