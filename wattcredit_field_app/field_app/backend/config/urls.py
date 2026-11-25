from django.urls import include, path

from ledger import views

urlpatterns = [path("", views.index), path("api/", include("ledger.urls"))]
