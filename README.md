# Tracking Debugger

Rozszerzenie do Chrome, które w jednym panelu pokazuje to, czego w DevTools szuka się po omacku: zdarzenia web pixel Shopify, zamknięte w sandboksowanych iframe'ach i workerach, oraz wychodzące żądania pomiarowe (kontener serwerowy, Meta, GA4, Google Ads, Microsoft, Clarity, TikTok i inne), z parametrami rozbitymi na czytelne pola.

Równie ważne jest to, że narzędzie mówi wprost, kiedy czegoś nie widzi. Zero w liczniku ma znaczyć „tego nie było”, a nie „nie potrafiłem tego przechwycić”, dlatego każdy zapis niesie godzinę, od której dane są wiarygodne, i nazwaną przyczynę, jeśli nie są. Zapis da się wyeksportować do pliku w trzech formatach, z etykietami etapów zakupu i trybem redakcji.

Działa na dowolnej stronie, nie tylko na Shopify. Bez konfiguracji pokazuje wszystko, co widzi, a dane zostają lokalnie i nie opuszczają przeglądarki.

## Instalacja

Rozszerzenia nie ma w Chrome Web Store, instaluje się je lokalnie jako rozpakowane.

1. Pobierz to repozytorium. Najwygodniej przez git, bo aktualizacja to potem jedno `git pull`:
   ```bash
   git clone https://github.com/kon-mat/tracking-debugger-dist.git
   ```
   Bez gita: **Code → Download ZIP** i rozpakuj.
2. Otwórz `chrome://extensions`.
3. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
4. Kliknij **Załaduj rozpakowane** i wskaż folder z tym repozytorium, ten z plikiem `manifest.json` w środku.
5. Przypnij ikonę: układanka na pasku Chrome, potem pinezka przy Tracking Debugger.
6. Odśwież karty, które chcesz badać. Sonda wchodzi do strony przy jej ładowaniu.

Po instalacji nie przenoś folderu i nie zmieniaj jego nazwy, bo Chrome zapamiętuje ścieżkę, a nie zawartość. Przy starcie przeglądarka może zapytać, czy wyłączyć rozszerzenia w trybie dewelopera. To normalne przy rozszerzeniach rozpakowanych, a **Anuluj** zostawia je włączone.

## Aktualizacja

1. W folderze repozytorium uruchom `git pull` (przy ZIP-ie pobierz nowe archiwum i podmień zawartość folderu).
2. W `chrome://extensions` kliknij odświeżanie (↻) przy Tracking Debugger.

Po przeładowaniu rozszerzenie samo dostrzykuje sondę do otwartych kart i oznacza je w Diagnostyce jako dołączone w locie. Zdarzenia z tych stron sprzed tej chwili przepadły i panel mówi to wprost. Żeby mieć zapis od zera, odśwież badaną kartę.

## Jak używać

Kliknięcie ikony otwiera panel boczny, który podpina się do aktywnej karty i przełącza razem z nią. Przycisk **Okno** otwiera panel w osobnym oknie na pełną szerokość, z listą kart do wyboru u góry. **Pauza** zatrzymuje odświeżanie widoku, ale zbieranie danych trwa dalej. **Wyczyść** kasuje dane bieżącej karty, **Kopiuj widoczne** kopiuje JSON pozycji widocznych po filtrach, a **Opcje** otwierają konfigurację. Kliknięcie wiersza rozwija szczegóły: pola kluczowe, wszystkie parametry, body, adres i listę pikseli, do których dotarło zdarzenie.

### Co pokazuje panel

Sekcje nad listą zwijają się do jednej linii ze skrótem stanu, więc nawet zwinięte mówią, co się w nich dzieje. Kliknięcie nagłówka rozwija sekcję, a **Tryb pracy** zwija wszystkie naraz.

| Sekcja | Zawartość |
|---|---|
| Diagnostyka | Stan samego narzędzia: czy sonda działa, czy protokół sandboksów jest czytelny, czy to w ogóle Shopify. Pod spodem ostrzeżenia, gdy panel może czegoś nie widzieć |
| Zgoda teraz | Wartości `ad_storage`, `analytics_storage`, `ad_user_data` i `ad_personalization` z komend `gtag('consent', …)`, ostatni `gcs` z żądań Google, stan `Shopify.customerPrivacy` i CMP. **Historia** pokazuje każdą zmianę z czasem i ramką źródłową |
| Licznik zdarzeń | 14 standardowych zdarzeń web pixel; zero jest wyszarzone, więc od razu widać, czego brakuje. Znak **∅** oznacza, że nikt nie subskrybuje tego zdarzenia, i wtedy zero niczego nie dowodzi |
| Wszystko | Zdarzenia strony i żądania do platform na jednej osi czasu: push do `dataLayer` i obok hity, które z niego poszły |
| Zdarzenia | Co strona mówi: zdarzenia web pixel, komendy consent, pushe `dataLayer`, `gtag('event')` i `Shopify.analytics.publish`, z podaniem ramki |
| Żądania | Każde żądanie karty z celem, nazwą zdarzenia, metodą, ramką źródłową i statusem HTTP albo błędem. Body POST jest parsowane, a paczki hitów rozbijane na osobne wiersze |
| Piksele | Zarejestrowane sandboksy: identyfikator, typ APP/CUSTOM, środowisko STRICT/LAX, `privacyPurposes` i lista `analytics.subscribe(...)` |

Wywołań `fbq()`, `ttq()` i `uetq()` sonda nie przechwytuje, więc na przykład Meta PageView jest widoczne tylko jako żądanie.

Każde żądanie trafia do jednej z czterech szuflad. **Rozpoznane** to platformy z listy wbudowanej oraz Twój kontener serwerowy i własne narzędzia z konfiguracji. **Inne** to obcy host spoza listy, z pełnym rekordem; tu znajdziesz narzędzie, o którym nie wiedziałeś. **Domena strony** zbiera dynamiczne żądania do domeny badanej strony, na przykład `/cart/add.js`. **Pominięte** to zasoby statyczne (CSS, fonty, obrazy, skrypty motywu), liczone per host bez zapisywania rekordów.

Czerwona flaga **BRAK event_id** oznacza żądanie Meta z `Purchase`, `InitiateCheckout`, `AddToCart`, `ViewContent` albo `AddPaymentInfo` bez `eid`, czyli bez możliwości deduplikacji z CAPI. Pomarańczowa flaga wskazuje hit e-commerce do kontenera serwerowego bez `event_id` albo `purchase` bez `transaction_id`.

## Werdykt: czy zeru w liczniku wolno wierzyć

Na samej górze Diagnostyki stoi jedno zdanie i od niego warto zaczynać.

| Werdykt | Co robić |
|---|---|
| zielony, **Zapis kompletny od hh:mm:ss** | Pracuj normalnie, zero w liczniku opisuje stronę, nie narzędzie |
| pomarańczowy, **Dołączono do otwartej strony o hh:mm:ss** | Od tej godziny zapis jest kompletny, wcześniejsze zdarzenia tej strony nie istnieją. Odśwież kartę, jeśli potrzebujesz zapisu od zera |
| czerwony, **Nie widzę zdarzeń na tej stronie** | Odśwież kartę. Do tego czasu zero w liczniku niczego nie dowodzi |
| szary, **Strona systemowa** | `chrome://`, strona rozszerzenia, Web Store. Chrome nie wpuszcza tu skryptów i odświeżanie nic nie da |

Zanim stwierdzisz, że czegoś nie było, sprawdź kolejno: werdykt jest zielony, a szukana chwila wypada po podanej w nim godzinie; Diagnostyka jest cała zielona (sonda działa, każdy sandbox ma sondę, zero nierozpoznanych wiadomości, subskrybent zdarzeń jest, nic nie zostało przycięte); szukane zdarzenie nie ma znaku ∅ w liczniku; w szufladzie **Inne** nie ma hosta, który mógłby być szukanym narzędziem; pominięte zasoby statyczne nie kryją niczego istotnego; licznik żądań poza kartą wynosi zero albo nie kryje tego, czego szukasz. Ostateczne potwierdzenie to nadal DevTools → Network bez filtra, a narzędzie tylko skraca drogę do niego.

## Etapy i eksport

Pasek **Etap** ustawia etykietę, którą dostają kolejne zapisywane pozycje: `home`, `product`, `add-to-cart`, `checkout`, `payment`, `thank-you`, `post-purchase` albo własna nazwa wpisana obok. Po etapie można filtrować, a przycisk **Po jednym pliku na etap** zapisuje osobny plik na każdy etap.

Przyciski **JSON**, **Markdown** i **CSV** w sekcji **Etap i eksport** (zwinięta sekcja pokazuje skróty JSON, MD, CSV) zapisują plik do podkatalogu `tracking-debugger/` w folderze pobierania, pod nazwą `td-<domena>-<RRRR-MM-DD-HHMM>-<etap>.<ext>`. JSON zawiera pełny stan, Markdown jest czytelny dla człowieka i pogrupowany po etapach, CSV to same żądania pomiarowe, jeden wiersz na hit.

Każdy eksport zaczyna się nagłówkiem z adresem, oknem czasowym, etapem, profilem i aktywnymi filtrami, a pod nim idą liczniki rzetelności: od kiedy dane są wiarygodne, ile pozycji wypadło przez limit, ile ramek nie miało sondy, ile wiadomości protokołu było nieczytelnych. Bez tych liczb odbiorca nie odróżni „nie było” od „nie zobaczyłem”.

**Tryb redakcji** jest domyślnie włączony i maskuje widocznie, przez `***`, adresy e-mail, numery telefonów, tokeny, `client_id`, `_fbp`, `_fbc`, `_ga` i hosty spoza badanej domeny i znanych platform. Eksport z etykietami po angielsku daje panel otwarty pod adresem `chrome-extension://pjbhddgcbdlcagoabhinblmfhfkglghg/panel/panel.html?lang=en` (identyfikator rozszerzenia jest stały, taki sam w każdej instalacji).

## Konfiguracja i profile

Konfiguracja jest w **Opcjach**. Na nowym projekcie warto ustawić cztery rzeczy:

| Ustawienie | Po co |
|---|---|
| Kontener serwerowy (sGTM) | Żądania do własnej domeny pomiarowej dostają etykietę i rozbicie parametrów zamiast lądować w „Inne” |
| Własne narzędzia pomiarowe | Host, nazwa i format, żeby narzędzie spoza listy wbudowanej było opisane po ludzku |
| Etykiety pikseli | Identyfikator pixela Shopify zamieniony na nazwę z panelu sklepu (Ustawienia → Zdarzenia klienta) |
| Hosty do pominięcia | Wyciszenie szumu, który na pewno nie jest pomiarem |

Profil wiąże te ustawienia z domenami projektu i włącza się sam, gdy wejdziesz na jedną z nich. Ustawienia globalne obowiązują wszędzie i dokładają się do profilu, więc jedna instalacja obsługuje wszystkie projekty. Gdy narzędzie zobaczy na domenie strony ścieżkę typową dla kontenera serwerowego (`/g/collect`, `/gtm.js`, `/gtag/js`, `/data`), podpowie ten host w Opcjach do zapisania w profilu.

Profile przenosi się przyciskami **Eksportuj do pliku** i **Importuj z pliku**. Import dokłada profile do istniejących, niczego nie kasuje. Plik wygląda tak:

```json
{
  "profile": {
    "nazwa-projektu": {
      "domeny": ["sklep.pl", "sklep-partner.pl"],
      "serwerowe": ["dane.sklep.pl"],
      "platformy": [
        { "etykieta": "Narzedzie afiliacyjne", "hosty": ["*.afiliacja.example"], "format": "generic" }
      ],
      "etykietyPikseli": { "123456789": "Custom pixel: GTM + zgoda" },
      "statyczneHosty": []
    }
  }
}
```

Domena `sklep.pl` obejmuje też subdomeny, `*.sklep.pl` tylko subdomeny, a `=sklep.pl` dokładnie ten host.

## Czego z zasady nie pokaże

1. **Ruchu server-to-server.** Widać tylko odcinek przeglądarka → serwer. Tego, co kontener serwerowy wysłał dalej do Meta CAPI, GA4 MP czy Google Ads, przeglądarka nie widzi; właściwe miejsce to logi kontenera albo jego tryb podglądu. To samo dotyczy webhooków sklepu.
2. **Subskrypcji natywnych kanałów Shopify** (Facebook & Instagram, Google & YouTube). Chodzą jako skrypty w ramce głównej, nie przez sandbox, więc nie pojawiają się w zakładce Piksele. Ich żądania widać normalnie.
3. **Przypisania żądań z workerów do konkretnego pixela.** Chrome przypisuje je ramce głównej. Żądania z iframe'ów custom pixeli są podpisane poprawnie.
4. **Zdarzeń sprzed wstrzyknięcia sondy** do strony. Panel zgłasza to w werdykcie.
5. **Treści binarnych body**. Rekord i tak powstaje, z adnotacją `binary`.

## Uprawnienia i dane

Rozszerzenie prosi o szerokie uprawnienia (podgląd żądań sieciowych, wstrzykiwanie skryptów, karty, panel boczny, pobieranie plików), bo musi widzieć ruch ze wszystkich ramek i workerów na dowolnej stronie i zapisywać eksporty. Sonda działa na każdej stronie http(s) od początku ładowania i wyłącznie obserwuje: nie modyfikuje stron, nie wstrzykuje tagów i nie wysyła danych na zewnątrz. Stan jest trzymany per karta i znika po zamknięciu przeglądarki.

## Wymagania

Chrome 119 lub nowszy.

---

To repozytorium zawiera wyłącznie gotowe rozszerzenie i aktualizuje się automatycznie. Zmiany wprowadzone bezpośrednio tutaj zostaną nadpisane przy następnej aktualizacji.
