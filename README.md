# Fiszki — hiszpański

Lokalna aplikacja przeglądarkowa do nauki hiszpańskiego. Nie potrzebuje konta, backendu ani połączenia z Internetem. SQLite działa w przeglądarce przez sql.js/WebAssembly; Alpine.js i sql.js są dołączone w katalogu `vendor`.

## Uruchomienie

Otwórz `index.html` w aktualnym Chrome lub Edge. Aplikacja najpierw przygotuje SQLite; następnie wybierz **Utwórz bazę** lub otwórz istniejący plik SQLite.

Jeśli przeglądarka przy otwieraniu przez `file://` nie udostępnia bezpośredniego zapisu do plików, aplikacja pozwala otworzyć bazę przez standardowy wybór pliku oraz pobrać jej snapshot SQLite. W tym trybie zmiany są tylko w pamięci do pobrania kopii — aplikacja pokazuje ten stan i nie obiecuje automatycznego zapisu. Przy obsługiwanym File System Access API wybierz lub utwórz plik, aby zapisywać bezpośrednio na dysku. Uchwyt ostatniej bazy, nie dane fiszek, może być zapamiętany w IndexedDB.

Wszystkie skrypty i pliki uruchomieniowe są lokalne. Głosowa wymowa zależy od Web Speech API i zainstalowanego głosu `es-ES`.

## Import i eksport

- CSV używa nagłówków `Rank`, `Word`, `IPA`, `Part of speech`, `Gender`, `Meaning`, `Example`, `Example translation`, `IPA sentence`, `Category` i `Image URL`. Wymagane są `Word` i `Meaning`; separator to przecinek, kodowanie UTF-8, a pola są cytowane zgodnie ze standardem CSV.
- Import akceptuje pliki do 5 MB, maksymalnie 2000 wierszy CSV lub 5000 kart JSON. Niepoprawne rekordy są raportowane i nie są zapisywane.
- JSON pełnej kopii ma format:

  ```json
  {
    "format": "fiszki-hiszpanski",
    "version": 1,
    "exported_at": "ISO-8601",
    "categories": [],
    "cards": [],
    "progress": [],
    "review_logs": []
  }
  ```

  Zwykły eksport zawiera kategorie i karty; pełna kopia zawiera dodatkowo postępy oraz historię odpowiedzi.
- Import pełnej kopii łączy fiszki po treści, nie ufa obcym identyfikatorom SQLite i nie nadpisuje postępów już istniejących kart. Postęp i historia z kopii są odtwarzane tylko dla nowych fiszek.

## Lokalne zależności

- Alpine.js 3.14.9 — `vendor/alpine.min.js` (licencja MIT: `vendor/ALPINE-LICENSE.md`)
- sql.js 1.13.0 — `vendor/sql-wasm.js` i `vendor/sql-wasm.wasm` (licencja MIT: `vendor/SQLJS-LICENSE`)
