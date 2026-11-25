import base64
import binascii
import json
import os

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.http import FileResponse, Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from . import evidence
from .models import DailySale, IngestRecord, Officer, Plug, ShiftBlock, TamperAlert
from .transcribe import transcribe_sale

MAX_AUDIO = 2 * 1024 * 1024


def index(request):
    return FileResponse(open(os.path.join(settings.BASE_DIR, "templates", "index.html"), "rb"), content_type="text/html")


def _auth(request):
    """Signed-request check. Returns (officer, None) or (None, JsonResponse)."""
    oid, ts, sig = (request.headers.get(h, "") for h in ("X-Officer-Id", "X-Timestamp", "X-Signature"))
    off = Officer.objects.filter(pk=oid).first()
    if off is None or not evidence.verify_request(off.public_jwk, oid, ts, request.body, sig):
        return None, JsonResponse({"error": "bad credential"}, status=401)
    return off, None


def _final(cid, status, reason=""):
    IngestRecord.objects.create(client_id=cid, status=status, reason=reason[:300])
    return {"id": cid, "status": status, "why": reason}


def _ingest_block(cid, p, off):
    plug = Plug.objects.select_for_update().filter(pk=p.get("plugId")).first()
    if plug is None:
        return _final(cid, "rejected", "unknown plug")
    seq = p.get("seq")
    if not isinstance(seq, int):
        return _final(cid, "rejected", "malformed block: seq")
    if seq <= plug.last_seq:
        return _final(cid, "duplicate")
    if seq != plug.last_seq + 1:
        return {"id": cid, "status": "gap", "why": f"server is waiting for block {plug.last_seq + 1}"}
    ok, why = evidence.check_block(p, plug.last_hash, plug.public_jwk)
    if not ok:
        return _final(cid, "rejected", why)
    ShiftBlock.objects.create(
        plug=plug, seq=seq, t_start=p["tStart"], t_end=p["tEnd"], work_min=p["workMin"], idle_min=p["idleMin"],
        other_min=p["otherMin"], credited_mwh=p["creditedMwh"], vrms_dv=p["vrmsDv"], irms_ca=p["irmsCa"],
        trips=p["trips"], prev_hash=p["prevHash"], hash=p["hash"], sig=p["sig"], submitted_by=off.officer_id)
    plug.last_seq, plug.last_hash = seq, p["hash"]
    plug.save()
    return _final(cid, "accepted")


def _ingest_sale(cid, p, off):
    src = p.get("source")
    if src not in ("keypad", "voice") or not p.get("entrepreneurId") or not isinstance(p.get("at"), int):
        return _final(cid, "rejected", "invalid sale")
    sale = DailySale(client_id=cid, entrepreneur_id=p["entrepreneurId"], plug_id=p.get("plugId", ""), at_ms=p["at"],
                     source=src, submitted_by=off.officer_id)
    if src == "keypad":
        amt = p.get("amountPaise")
        if not isinstance(amt, int) or amt < 0 or amt > 10_000_000:
            return _final(cid, "rejected", "invalid amount")
        sale.amount_paise, sale.status = amt, "confirmed"
    else:
        a = p.get("audio") or {}
        try:
            raw = base64.b64decode(a.get("b64", ""), validate=True)
        except (binascii.Error, ValueError):
            return _final(cid, "rejected", "audio is not valid base64")
        if not raw or len(raw) > MAX_AUDIO:
            return _final(cid, "rejected", "audio missing or over 2 MB")
        os.makedirs(os.path.join(settings.MEDIA_ROOT, "voice"), exist_ok=True)
        safe = "".join(c for c in cid if c.isalnum() or c in "-_")[:64]
        sale.audio_path = os.path.join(settings.MEDIA_ROOT, "voice", safe + ".bin")
        with open(sale.audio_path, "wb") as f:
            f.write(raw)
        sale.audio_mime, sale.audio_ms, sale.status = str(a.get("mime", ""))[:60], int(a.get("ms") or 0), "pending_transcription"
    sale.save()
    r = _final(cid, "accepted")
    if src == "voice" and settings.TRANSCRIBE_INLINE:
        transcribe_sale(sale)
    return r


def _ingest_alert(cid, p, off):
    TamperAlert.objects.create(plug_id=str(p.get("plugId", ""))[:40], seq=int(p.get("seq") or 0),
                               reason=str(p.get("reason", ""))[:300], submitted_by=off.officer_id)
    return _final(cid, "accepted")


HANDLERS = {"telemetry_block": _ingest_block, "daily_sale": _ingest_sale, "tamper_alert": _ingest_alert}


@csrf_exempt
def sync(request):
    if request.method != "POST":
        return JsonResponse({"error": "POST only"}, status=405)
    off, err = _auth(request)
    if err:
        return err
    try:
        recs = json.loads(request.body)["records"]
    except (ValueError, KeyError, TypeError):
        return JsonResponse({"error": "bad body"}, status=400)
    results = []
    for r in recs:  # in order: block N+1 must follow block N inside one batch
        cid = str(r.get("id", ""))[:80]
        h = HANDLERS.get(r.get("type"))
        if not cid or h is None:
            results.append({"id": cid, "status": "rejected", "why": "unknown record"})
            continue
        prior = IngestRecord.objects.filter(pk=cid).first()
        if prior:
            results.append({"id": cid, "status": "duplicate" if prior.status in ("accepted", "duplicate") else prior.status,
                            "why": prior.reason})
            continue
        with transaction.atomic():
            results.append(h(cid, r.get("payload") or {}, off))
    return JsonResponse({"results": results})


def ledger(request):
    off, err = _auth(request)
    if err:
        return err
    plugs = [{"plugId": p.plug_id, "entrepreneurId": p.entrepreneur_id, "blocks": p.last_seq, "chainHead": p.last_hash,
              "workMin": p.blocks.aggregate(s=Sum("work_min"))["s"] or 0,
              "creditedMwh": p.blocks.aggregate(s=Sum("credited_mwh"))["s"] or 0} for p in Plug.objects.order_by("plug_id")]
    sales = [{"id": s.client_id, "entrepreneurId": s.entrepreneur_id, "source": s.source, "status": s.status,
              "amountPaise": s.amount_paise, "transcript": s.transcript, "provider": s.provider, "error": s.error,
              "at": s.at_ms} for s in DailySale.objects.order_by("-at_ms")[:100]]
    alerts = list(TamperAlert.objects.order_by("-id").values("plug_id", "seq", "reason")[:30])
    return JsonResponse({"plugs": plugs, "sales": sales, "alerts": alerts})


@csrf_exempt
def sale_confirm(request, client_id):
    """Officer confirms or corrects an amount that needs review."""
    off, err = _auth(request)
    if err:
        return err
    sale = DailySale.objects.filter(pk=client_id).first()
    if sale is None:
        raise Http404
    try:
        amt = int(json.loads(request.body)["amountPaise"])
    except (ValueError, KeyError, TypeError):
        return JsonResponse({"error": "amountPaise required"}, status=400)
    if amt < 0 or amt > 10_000_000:
        return JsonResponse({"error": "amount out of range"}, status=400)
    sale.amount_paise, sale.status = amt, "confirmed"
    sale.save()
    return JsonResponse({"ok": True})


@csrf_exempt
def sale_transcribe(request, client_id):
    off, err = _auth(request)
    if err:
        return err
    sale = DailySale.objects.filter(pk=client_id).first()
    if sale is None or sale.source != "voice":
        raise Http404
    return JsonResponse({"status": transcribe_sale(sale)})


@csrf_exempt
def dev_register(request):
    """DEBUG only: register the demo officer key and simulated plug keys."""
    if not settings.DEBUG or request.method != "POST":
        raise Http404
    d = json.loads(request.body)
    o = d["officer"]
    Officer.objects.update_or_create(officer_id=o["id"], defaults={"name": o.get("name", ""), "public_jwk": o["pub"]})
    for p in d["plugs"]:
        Plug.objects.update_or_create(plug_id=p["id"], defaults={"entrepreneur_id": p.get("entrepreneurId", ""),
                                                                  "public_jwk": p["pub"]})
    return JsonResponse({"ok": True})
