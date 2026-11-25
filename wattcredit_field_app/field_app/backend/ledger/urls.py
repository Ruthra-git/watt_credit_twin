from django.urls import path

from . import views

urlpatterns = [
    path("sync/", views.sync),
    path("ledger/", views.ledger),
    path("sales/<str:client_id>/confirm/", views.sale_confirm),
    path("sales/<str:client_id>/transcribe/", views.sale_transcribe),
    path("dev/register/", views.dev_register),
]
