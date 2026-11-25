from django.core.management.base import BaseCommand

from ledger.models import DailySale
from ledger.transcribe import transcribe_sale


class Command(BaseCommand):
    help = "Transcribe voice sales that are pending or failed. Run from cron / a worker every minute."

    def handle(self, *a, **k):
        n = 0
        for s in DailySale.objects.filter(source="voice", status__in=["pending_transcription", "transcription_failed"]):
            self.stdout.write(f"{s.client_id}: {transcribe_sale(s)}")
            n += 1
        self.stdout.write(f"{n} processed")
