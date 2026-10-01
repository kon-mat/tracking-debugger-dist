// panel/panel.js — widok. Cały stan przychodzi z service workera przez port; panel renderuje,
// filtruje, liczy ostrzeżenia diagnostyczne, oznacza etapy i zapisuje eksporty do pliku.
// Żadnych wywołań sieciowych — `chrome.downloads` zapisuje lokalny Blob, nic nie wychodzi na zewnątrz.
//
// Panel jest jednocześnie interfejsem dla człowieka i dla agenta:
//   - adres okna niesie wszystkie filtry (`?tab=&platforma=&typ=&szukaj=&etap=&prezentacja=&lang=`),
//     więc widok da się ustawić bez klikania;
//   - `window.__td` wystawia stan, filtry, etap, eksport i diagnostykę do `evaluate_script`.
(() => {
  'use strict';
  const K = self.TDKonfiguracja;
  const A = self.TDAnaliza;
  const E = self.TDEksport;

  const qs = new URLSearchParams(location.search);
  const paramKarty = qs.get('tab') || qs.get('karta');
  const tryb = qs.get('tryb') || (paramKarty ? 'okno' : 'bok');
  const prezentacja = qs.get('prezentacja') === '1' || qs.get('prezentacja') === 'true';
  const jezyk = String(qs.get('lang') || 'pl').toLowerCase() === 'en' ? 'en' : 'pl';
  let tabId = paramKarty ? Number(paramKarty) : null;

  let port = null;
  let S = null;
  let konfiguracja = K.normalizuj(null);
  let ustawienia = K.dlaHosta(konfiguracja, '');
  let klasyfikator = A.utworz(ustawienia);
  let hostKarty = '';
  let urlKarty = '';
  let sieroty = { razem: 0, hosty: {} };
  let wstrzymany = false;
  const oczekujace = [];
  const filtry = {
    platformy: new Set(String(qs.get('platforma') || '').split(',').map((x) => x.trim()).filter(Boolean)),
    typ: qs.get('typ') || '',
    szukaj: String(qs.get('szukaj') || '').trim().toLowerCase(),
    etap: qs.get('etap') || '',
    zrShopify: true,
    zrZgoda: true,
    zrDl: true,
  };
  // „Wszystko" jest domyślne: zdarzenia strony i żądania na jednej osi czasu. Wywołań fbq / ttq / uetq
  // sonda nie przechwytuje, więc np. Meta PageView istnieje tylko jako żądanie — osobno go nie widać.
  let aktywnaZakladka = 'wszystko';
  const LISTY = {
    wszystko: { ul: 'listaWszystko', pusto: 'pustoWszystko' },
    zdarzenia: { ul: 'listaZdarzen', pusto: 'pustoZdarzenia' },
    zadania: { ul: 'listaZadan', pusto: 'pustoZadania' },
  };
  const WERSJA = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return '?';
    }
  })();

  // ---------------------------------------------------------------- słownik (tryb prezentacji po angielsku)
  const T = {
    pl: {
      profilBrak: 'profil: brak (ustawienia globalne)',
      profil: (p) => 'profil: ' + p,
      sondaOk: (c) => 'sonda: OK ' + c,
      sondaBrak: 'sonda: BRAK MELDUNKU',
      sondaWLocie: (c) => 'sonda: dołączona w locie ' + c,
      shopify: (v) => 'Shopify: ' + v,
      tak: 'tak',
      nie: 'nie',
      iframy: (a, b, w) => "iframe'y pikseli z sondą: " + a + '/' + b + ' · workery: ' + w,
      protokol: (a, b) => 'protokół: ' + a + ' rozpoznane · ' + b + ' nie',
      subTak: 'subskrybent all_events: jest',
      subNie: 'subskrybent all_events: BRAK',
      inneHosty: (a, b, c) => 'inne hosty: ' + a + ' · pominięte: ' + b + ' · poza kartą: ' + c,
      przyciete: (n, l) => 'PRZYCIĘTO ' + n + ' pozycji (limit ' + l + ')',
      wiarygodneOd: (c) => 'dane wiarygodne od ' + c,
      wiarygodneBrak: 'DANE NIEWIARYGODNE',
      pozaZasiegiem: 'strona poza zasięgiem',
      sondaNieDotyczy: 'sonda: nie dotyczy',
      uwaga: 'UWAGA: ',
      ostroznie: 'Ostrożnie: ',
      info: 'Info: ',
      etapBrak: '(bez etapu)',
      brakDanych: '—',
    },
    en: {
      profilBrak: 'profile: none (global settings)',
      profil: (p) => 'profile: ' + p,
      sondaOk: (c) => 'probe: OK ' + c,
      sondaBrak: 'probe: NO CHECK-IN',
      sondaWLocie: (c) => 'probe: attached mid-document ' + c,
      shopify: (v) => 'Shopify: ' + v,
      tak: 'yes',
      nie: 'no',
      iframy: (a, b, w) => 'pixel iframes with probe: ' + a + '/' + b + ' · workers: ' + w,
      protokol: (a, b) => 'protocol: ' + a + ' decoded · ' + b + ' not',
      subTak: 'all_events subscriber: present',
      subNie: 'all_events subscriber: NONE',
      inneHosty: (a, b, c) => 'other hosts: ' + a + ' · skipped: ' + b + ' · outside tab: ' + c,
      przyciete: (n, l) => 'TRIMMED ' + n + ' items (limit ' + l + ')',
      wiarygodneOd: (c) => 'data reliable from ' + c,
      wiarygodneBrak: 'DATA NOT RELIABLE',
      pozaZasiegiem: 'page out of reach',
      sondaNieDotyczy: 'probe: not applicable',
      uwaga: 'WARNING: ',
      ostroznie: 'Caution: ',
      info: 'Info: ',
      etapBrak: '(no stage)',
      brakDanych: '—',
    },
  }[jezyk];


  // ---------------------------------------------------------------- treści ostrzeżeń (PL / EN)
  // Ostrzeżenia Diagnostyki niosą całą wartość dowodową zrzutu, więc muszą mieć wersję angielską.
  // Kod ostrzeżenia jest stały, tekst zależy od `?lang=`.
  const OSTRZ = {
    pl: {
      przyciecie: (d) =>
        'PRZYCIĘTO LISTĘ: usunięto ' + d.usuniete + ' najstarszych pozycji (limit ' + d.limit + '). Te pozycje NIE są już dostępne ' +
        'i nie będzie ich w eksporcie — okno czasowe w nagłówku eksportu zaczyna się później, niż zaczęła się sesja. ' +
        'Podnieś limit w Opcjach albo eksportuj częściej.',
      pikselBezSubskrypcji: (d) =>
        'Piksel ' + d.lista.join(', ') + ' zarejestrował się, ale NIE wywołał analytics.subscribe. Protokół nie dostarczy mu żadnego ' +
        'zdarzenia — zero przy tym pikselu opisuje piksel, nie widoczność narzędzia. (Typowe dla app pixela, który dociąga własną ' +
        'konfigurację albo czeka na zgodę.)',
      pikseleBezZdarzen: (d) =>
        d.ile + ' pikseli zarejestrowało się na tej stronie, ale NIE przechwycono ŻADNEGO zdarzenia (nawet page_viewed). ' +
        'Prawdopodobna zmiana formatu protokołu Shopify — licznik zdarzeń jest nieważny. Sprawdź ręcznie w DevTools → Network.',
      brakSubskrybenta: () =>
        'Żaden sandbox nie subskrybuje all_standard_events / all_events. Panel widzi tylko zdarzenia, które mają subskrybenta ' +
        'w sandboksie — zera przy ∅ w liczniku NIE dowodzą braku zdarzenia.',
      nierozpoznaneRpc: (d) =>
        'Nierozpoznane wiadomości protokołu sandboksów: ' + d.nieznane + ' (rozpoznane: ' + d.znane + '). ' +
        (d.nieznane > d.znane
          ? 'Większość ruchu jest nieczytelna — format protokołu Shopify mógł się zmienić, strumień zdarzeń jest niekompletny.'
          : 'Część ruchu sandboksów jest nieczytelna — zdarzenia mogą być niekompletne. Szczegóły per ramka poniżej.'),
      sandboksyBezSondy: (d) =>
        'Ramka główna widzi ' + d.iframe + " sandboksowych iframe'ów pikseli, a sonda zgłosiła się w " + d.zSonda +
        ". Zdarzenia dostarczane do pozostałych iframe'ów NIE są widoczne.",
      kandydatSgtm: (d) =>
        'Wykryto host, który wygląda na kontener serwerowy, a nie ma go w konfiguracji: ' + d.hosty.join(', ') +
        '. Dopóki go nie dodasz, jego żądania są opisywane ogólnie (albo trafiają do „Inne"), a pola takie jak event_id mogą nie być rozbite.',
      brakShopify: () =>
        'Na tej stronie nie wykryto managera web pixeli Shopify. Zakładki Zdarzenia (część Shopify) i Piksele pozostaną puste — ' +
        'to stan strony, nie awaria narzędzia. Żądania, zgoda i dataLayer działają normalnie.',
      sieroty: (d) =>
        'Żądania bez przypisanej karty (prerender / service worker strony / inne rozszerzenie): ' + d.razem +
        '. Nie ma ich na liście — hosty w Szczegółach.',
      obceHosty: (d) =>
        d.ile + ' obcych hostów spoza listy platform ma żądania w szufladzie „Inne" (Żądania → Hosty). ' +
        'Zanim uznasz, że jakieś narzędzie nie wysyła, sprawdź je tam.',
      restarty: (d) =>
        'Service worker rozszerzenia był usypiany i wznawiany (' + d.ile + '×). Stan odtworzono z pamięci sesji; ' +
        'przy wątpliwościach porównaj z Network.',
      zapisKompletnyOd: (d) => ' Zapis kompletny od ' + d.od + '.',
      przyciskOpcje: 'Otwórz Opcje',
      przyciskOdswiez: 'Odśwież kartę',
    },
    en: {
      przyciecie: (d) =>
        'LIST TRIMMED: ' + d.usuniete + ' oldest items were dropped (limit ' + d.limit + '). Those items are NO LONGER available ' +
        'and will not appear in the export — the capture window in the export header starts later than the session did. ' +
        'Raise the limit in Options or export more often.',
      pikselBezSubskrypcji: (d) =>
        'Pixel ' + d.lista.join(', ') + ' registered but never called analytics.subscribe. By protocol it cannot receive any event — ' +
        'a zero next to this pixel describes the pixel, not the visibility of this tool. (Typical for an app pixel that fetches its own ' +
        'configuration or waits for consent.)',
      pikseleBezZdarzen: (d) =>
        d.ile + ' pixels registered on this page, but NOT A SINGLE event was captured (not even page_viewed). ' +
        'Likely a change in the Shopify protocol format — the event counter is void. Verify manually in DevTools → Network.',
      brakSubskrybenta: () =>
        'No sandbox subscribes to all_standard_events / all_events. The panel only sees events that have a subscriber in a sandbox — ' +
        'zeros marked ∅ in the counter do NOT prove the event did not happen.',
      nierozpoznaneRpc: (d) =>
        'Undecoded sandbox protocol messages: ' + d.nieznane + ' (decoded: ' + d.znane + '). ' +
        (d.nieznane > d.znane
          ? 'Most of the traffic is unreadable — the Shopify protocol format may have changed and the event stream is incomplete.'
          : 'Part of the sandbox traffic is unreadable — events may be incomplete. Per-frame details below.'),
      sandboksyBezSondy: (d) =>
        'The main frame sees ' + d.iframe + ' sandboxed pixel iframes, but the probe checked in from only ' + d.zSonda +
        '. Events delivered to the remaining iframes are NOT visible.',
      kandydatSgtm: (d) =>
        'A host that looks like a server-side container was detected but is not in the configuration: ' + d.hosty.join(', ') +
        '. Until it is added, its requests are described generically (or land in "Other") and fields such as event_id may not be broken out.',
      brakShopify: () =>
        'No Shopify web pixels manager was detected on this page. The Events (Shopify part) and Pixels tabs will stay empty — ' +
        'that is the state of the page, not a tool failure. Requests, consent and dataLayer work normally.',
      sieroty: (d) =>
        'Requests with no owning tab (prerender / page service worker / another extension): ' + d.razem +
        '. They are not in the list — hosts are in Details.',
      obceHosty: (d) =>
        d.ile + ' third-party hosts outside the platform list have requests in the "Other" drawer (Requests → Hosts). ' +
        'Before concluding that some tool sends nothing, check them there.',
      restarty: (d) =>
        'The extension service worker was suspended and resumed (' + d.ile + '×). State was restored from session storage; ' +
        'if in doubt, compare with Network.',
      zapisKompletnyOd: (d) => ' Record complete from ' + d.od + '.',
      przyciskOpcje: 'Open Options',
      przyciskOdswiez: 'Reload tab',
    },
  }[jezyk];


  // Etykiety platform i ramek w trybie prezentacji po angielsku. Tłumaczymy tylko te, które są
  // opisem po polsku — nazwy własne (Meta, GA4, Clarity) zostają, bo to nazwy, nie etykiety.
  const PLATFORMY_EN = {
    sgtm: 'Server-side container',
    'google-tag': 'Google tag (loader)',
    cmp: 'CMP (consent)',
    'shopify-internal': 'Shopify (telemetry)',
    inne: 'Other (unrecognized)',
    wlasne: 'Site domain (XHR/fetch)',
  };
  const etykietaPlatformy = (id, domyslna) => (jezyk === 'en' && PLATFORMY_EN[id]) || domyslna;
  const RAMKI_EN = { 'ramka główna': 'main frame', 'poza ramką (worker / SW)': 'outside frame (worker / SW)' };
  const etykietaRamki = (n) => (jezyk === 'en' && RAMKI_EN[n]) || n || '';

  // Werdykt — jedno zdanie, ktore odpowiada na jedyne pytanie warte zadania na starcie:
  // czy zeru w liczniku zdarzen wolno dzisiaj wierzyc.
  const WERDYKT = {
    pl: {
      ok: (c) => ['✔', 'Zapis kompletny od ' + c + '.', 'Zeru w liczniku zdarzeń można wierzyć — to stan strony, nie ślepota narzędzia.'],
      'odzyskane-w-locie': (c) => ['▲', 'Dołączono do otwartej strony o ' + c + '.', 'Od tej godziny zapis jest kompletny, ale zdarzenia TEJ strony sprzed niej nie zostały zapisane. Odśwież kartę, jeśli potrzebujesz dokumentu od zera.'],
      'brak-sondy-w-dokumencie': () => ['✖', 'Nie widzę zdarzeń na tej stronie.', 'Odśwież kartę. Do tego czasu zero w liczniku NICZEGO nie dowodzi — żądania sieciowe są kompletne, zdarzenia web pixel nie.'],
      'sonda-sprzed-nawigacji': () => ['✖', 'Nie widzę zdarzeń w bieżącym dokumencie.', 'Odśwież kartę. Do tego czasu zero w liczniku NICZEGO nie dowodzi.'],
      'poza-zasiegiem': () => ['●', 'Strona systemowa — rozszerzenie nie ma tu wstępu.', 'Chrome blokuje skrypty na chrome://, stronach rozszerzeń i w Web Store. Odświeżanie nie pomoże. Żądania sieciowe są nadal liczone. Otwórz zwykłą stronę http(s).'],
      'poza-zasiegiem-plik': () => ['●', 'Adres file:// — potrzebna zgoda.', 'W chrome://extensions włącz przy tym rozszerzeniu „Zezwalaj na dostęp do adresów URL plików". Żądania sieciowe są liczone dalej.'],
      czekamy: () => ['…', 'Strona się ładuje.', 'Chwila — sonda jeszcze się nie zameldowała.'],
    },
    en: {
      ok: (c) => ['✔', 'Record complete from ' + c + '.', 'A zero in the event counter can be trusted — it describes the page, not a blind spot in the tool.'],
      'odzyskane-w-locie': (c) => ['▲', 'Attached to an already open page at ' + c + '.', 'The record is complete from that time, but events of THIS document from before it were never captured. Reload the tab if you need the document from the start.'],
      'brak-sondy-w-dokumencie': () => ['✖', 'I cannot see events on this page.', 'Reload the tab. Until then a zero in the counter proves NOTHING — network requests are complete, web pixel events are not.'],
      'sonda-sprzed-nawigacji': () => ['✖', 'I cannot see events in the current document.', 'Reload the tab. Until then a zero in the counter proves NOTHING.'],
      'poza-zasiegiem': () => ['●', 'System page — the extension is not allowed here.', 'Chrome blocks content scripts on chrome://, extension pages and the Web Store. Reloading will not help. Network requests are still counted. Open a regular http(s) page.'],
      'poza-zasiegiem-plik': () => ['●', 'file:// URL — permission needed.', 'Enable "Allow access to file URLs" for this extension in chrome://extensions. Network requests are still counted.'],
      czekamy: () => ['…', 'The page is loading.', 'Hold on — the probe has not checked in yet.'],
    },
  }[jezyk];

  const $ = (id) => document.getElementById(id);
  const el = (tag, klasa, tekst) => {
    const e = document.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst != null) e.textContent = String(tekst);
    return e;
  };
  const czas = (t) => {
    if (!t) return T.brakDanych;
    const d = new Date(t);
    return d.toLocaleTimeString('pl-PL', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };
  const znaczek = (klasa, tekst) => el('span', 'badge ' + klasa, tekst);
  const kv = (k, v) => {
    const s = el('span', 'kv');
    s.appendChild(el('b', null, k + '='));
    s.appendChild(document.createTextNode(skroc(v)));
    s.title = k + ' = ' + String(v);
    return s;
  };
  const skroc = (v, n) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const lim = n || 48;
    return s.length > lim ? s.slice(0, lim - 1) + '…' : s;
  };
  const klasaZgody = (v) => {
    const s = String(v).toLowerCase();
    if (s === 'granted' || s === 'yes' || s === 'true') return 'granted';
    if (s === 'denied' || s === 'no' || s === 'false') return 'denied';
    return 'unknown';
  };

  let toastEl = null;
  function toast(tekst) {
    if (!toastEl) {
      toastEl = el('div', 'toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = tekst;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  async function doSchowka(tekst) {
    try {
      await navigator.clipboard.writeText(tekst);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = tekst;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Skopiowano do schowka');
  }
  const doEksportu = (rekord) => {
    const o = Object.assign({}, rekord);
    delete o._s;
    return o;
  };

  // ---------------------------------------------------------------- połączenie
  function polacz() {
    try {
      port = chrome.runtime.connect({ name: 'td-panel' });
    } catch (e) {
      setTimeout(polacz, 1000);
      return;
    }
    port.onMessage.addListener(naWiadomosc);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(polacz, 500);
    });
    if (tabId != null) port.postMessage({ typ: 'subskrybuj', tabId });
  }

  function subskrybuj(id) {
    tabId = id;
    if (port) port.postMessage({ typ: 'subskrybuj', tabId });
    odswiezInfoKarty();
    aktualizujAdres();
  }

  function przeliczUstawienia() {
    ustawienia = K.dlaHosta(konfiguracja, hostKarty);
    klasyfikator = A.utworz(ustawienia);
  }

  async function odswiezInfoKarty() {
    if (tabId == null) return;
    try {
      const t = await chrome.tabs.get(tabId);
      urlKarty = t.url || '';
      $('infoKarty').textContent = '#' + tabId + ' · ' + (t.title || '') + ' · ' + urlKarty;
      $('infoKarty').title = urlKarty;
      try {
        hostKarty = new URL(urlKarty).hostname;
      } catch (e) {
        hostKarty = '';
      }
      przeliczUstawienia();
      renderujLiczniki();
      renderujDiag();
    } catch (e) {
      $('infoKarty').textContent = '#' + tabId + ' (karta niedostępna)';
    }
  }

  function naWiadomosc(w) {
    if (!w) return;
    if (w.typ === 'sieroty') {
      sieroty = w.sieroty || sieroty;
      renderujDiag();
      return;
    }
    if (w.typ === 'konfiguracja') {
      konfiguracja = K.normalizuj(w.konfiguracja);
      przeliczUstawienia();
      if (S) renderujWszystko();
      return;
    }
    if (w.tabId !== tabId) return;
    if (wstrzymany && w.typ !== 'stan') {
      oczekujace.push(w);
      return;
    }
    zastosuj(w);
  }

  function zastosuj(w) {
    switch (w.typ) {
      case 'stan':
        S = w.stan;
        if (w.sieroty) sieroty = w.sieroty;
        if (w.konfiguracja) {
          konfiguracja = K.normalizuj(w.konfiguracja);
          przeliczUstawienia();
        }
        renderujWszystko();
        break;
      case 'etap':
        if (!S) return;
        S.etap = w.etap;
        renderujEtap();
        break;
      case 'dodaj': {
        if (!S) return;
        const r = w.rekord;
        const lista = w.lista === 'zdarzenia' ? S.zdarzenia : S.zadania;
        lista.push(r);
        if (r.rodzaj === 'shopify') {
          S.liczniki.zdarzenia[r.nazwa] = (S.liczniki.zdarzenia[r.nazwa] || 0) + 1;
          S.diag.ostatnieZdarzenie = r.t;
          S.diag.shopify = true;
        }
        if (r.rodzaj === 'zadanie') S.liczniki.platformy[r.platform] = (S.liczniki.platformy[r.platform] || 0) + 1;
        if (r.rodzaj === 'datalayer') S.liczniki.dl[r.nazwa] = (S.liczniki.dl[r.nazwa] || 0) + 1;
        if (r.rodzaj === 'nawigacja') {
          S.diag.ostatniaNawigacja = r.t;
          S.diag.adresNawigacji = r.url;
        }
        dodajOpcjeTypu(r);
        dodajOpcjeEtapu(r);
        if (widoczny(r)) {
          wstawWiersz(w.lista, r);
          // Nawigacja jest w obu listach jako dwa rekordy — na osi „Wszystko" wystarczy jeden.
          if (!(w.lista === 'zadania' && r.rodzaj === 'nawigacja')) wstawWiersz('wszystko', r);
        }
        renderujLiczniki();
        odswiezLiczniki();
        if (r.rodzaj === 'shopify' || r.rodzaj === 'nawigacja') renderujDiag();
        break;
      }
      case 'aktualizacja': {
        if (!S) return;
        const lista = w.lista === 'zdarzenia' ? S.zdarzenia : S.zadania;
        const i = lista.findIndex((r) => r.uid === w.rekord.uid);
        if (i >= 0) lista[i] = w.rekord;
        for (const nazwa of [w.lista, 'wszystko']) {
          const ul = $(LISTY[nazwa].ul);
          const stary = ul.querySelector('[data-uid="' + CSS.escape(w.rekord.uid) + '"]');
          if (stary) {
            const bylOtwarty = !!stary.querySelector('.details');
            const swiezy = wiersz(w.rekord);
            if (bylOtwarty) przelaczSzczegoly(swiezy, w.rekord, true);
            stary.replaceWith(swiezy);
          } else if (widoczny(w.rekord)) {
            ul.insertBefore(wiersz(w.rekord), ul.firstChild);
          }
        }
        break;
      }
      case 'zgoda':
        if (!S) return;
        {
          const przed = ((S.zgoda && S.zgoda.historia) || []).length;
          S.zgoda = w.zgoda;
          // Zmiana zgody w trakcie pracy: mignij zwiniętą sekcją, nie rozwijaj jej.
          if (((S.zgoda && S.zgoda.historia) || []).length > przed) mignijSekcja('zgoda');
        }
        renderujZgode();
        break;
      case 'piksele':
        if (!S) return;
        S.piksele = w.piksele;
        renderujPiksele();
        renderujLiczniki();
        renderujDiag();
        break;
      case 'diag':
        if (!S) return;
        S.diag = w.diag;
        if (w.sieroty) sieroty = w.sieroty;
        renderujDiag();
        renderujHosty();
        break;
    }
  }

  // ---------------------------------------------------------------- adres okna (stabilny, z filtrami)
  // Każdy filtr z interfejsu ma odpowiednik w query stringu, więc widok da się złożyć z góry
  // i odtworzyć bez klikania. Zmiana filtru przepisuje adres w miejscu (bez wpisu w historii).
  function aktualizujAdres() {
    if (tryb !== 'okno') return;
    const p = new URLSearchParams();
    if (tabId != null) p.set('tab', String(tabId));
    if (filtry.platformy.size) p.set('platforma', Array.from(filtry.platformy).join(','));
    if (filtry.typ) p.set('typ', filtry.typ);
    if (filtry.szukaj) p.set('szukaj', filtry.szukaj);
    if (filtry.etap) p.set('etap', filtry.etap);
    if (prezentacja) p.set('prezentacja', '1');
    if (jezyk === 'en') p.set('lang', 'en');
    try {
      history.replaceState(null, '', location.pathname + '?' + p.toString());
    } catch (e) {}
  }

  // ---------------------------------------------------------------- filtry
  function tekstSzukania(r) {
    if (!r._s) {
      try {
        r._s = JSON.stringify(doEksportu(r)).toLowerCase();
      } catch (e) {
        r._s = '';
      }
    }
    return r._s;
  }

  function widoczny(r) {
    if (filtry.etap && (r.etap || '') !== filtry.etap) return false;
    if (r.rodzaj === 'nawigacja') return true;
    if (r.rodzaj === 'zadanie') {
      if (filtry.platformy.size && !filtry.platformy.has(r.platform)) return false;
    } else {
      if (r.rodzaj === 'shopify' && !filtry.zrShopify) return false;
      if (r.rodzaj === 'consent' && !filtry.zrZgoda) return false;
      if ((r.rodzaj === 'datalayer' || r.rodzaj === 'gtag-event' || r.rodzaj === 'publish') && !filtry.zrDl) return false;
    }
    if (filtry.typ) {
      const n = r.rodzaj === 'zadanie' ? r.nazwaZdarzenia : r.nazwa;
      if (n !== filtry.typ) return false;
    }
    if (filtry.szukaj && !tekstSzukania(r).includes(filtry.szukaj)) return false;
    return true;
  }

  const opcjeTypu = new Set();
  function dodajOpcjeTypu(r) {
    const n = r.rodzaj === 'zadanie' ? r.nazwaZdarzenia : r.rodzaj === 'nawigacja' ? null : r.nazwa;
    if (!n || opcjeTypu.has(n)) return;
    opcjeTypu.add(n);
    renderujOpcjeTypu();
  }
  function renderujOpcjeTypu() {
    const sel = $('filtrTypu');
    const biezaca = filtry.typ;
    while (sel.options.length > 1) sel.remove(1);
    for (const n of Array.from(opcjeTypu).sort()) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = opcjeTypu.has(biezaca) ? biezaca : '';
  }

  const opcjeEtapu = new Set();
  function dodajOpcjeEtapu(r) {
    if (!r || !r.etap || opcjeEtapu.has(r.etap)) return;
    opcjeEtapu.add(r.etap);
    renderujOpcjeEtapu();
  }
  function renderujOpcjeEtapu() {
    const sel = $('filtrEtapu');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    const wszystkie = A.ETAPY.filter((e) => opcjeEtapu.has(e)).concat(Array.from(opcjeEtapu).filter((e) => !A.ETAPY.includes(e)).sort());
    for (const n of wszystkie) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = opcjeEtapu.has(filtry.etap) ? filtry.etap : '';
  }

  function ustawSzukanie(tekst) {
    $('szukaj').value = tekst;
    filtry.szukaj = tekst.trim().toLowerCase();
    aktualizujAdres();
    renderujListy();
  }

  function odswiezWidok() {
    aktualizujAdres();
    renderujLiczniki();
    renderujOpcjeTypu();
    renderujOpcjeEtapu();
    renderujListy();
    renderujDiag();
  }

  // ---------------------------------------------------------------- etapy
  function renderujEtap() {
    const aktywny = (S && S.etap) || null;
    const box = $('etapyPrzyciski');
    box.replaceChildren();
    for (const e of A.ETAPY) {
      const chip = el('span', 'chip clickable' + (aktywny === e ? ' on' : ''), e);
      chip.title = 'Ustaw etap „' + e + '" — kolejne pozycje dostaną tę etykietę';
      chip.addEventListener('click', () => ustawEtap(e));
      box.appendChild(chip);
    }
    $('etapAktywny').textContent = aktywny ? 'aktywny: ' + aktywny : T.etapBrak;
    if ($('pnEtap')) $('pnEtap').textContent = aktywny || (filtry.etap || T.etapBrak);
    renderujSkrotEtapu();
  }

  function ustawEtap(nazwa) {
    if (port && tabId != null) port.postMessage({ typ: 'etap', tabId, etap: nazwa || null });
    if (S) S.etap = nazwa || null;
    renderujEtap();
    return nazwa || null;
  }

  // ---------------------------------------------------------------- eksport
  function metaEksportu(opcje) {
    const o = opcje || {};
    return {
      wersja: WERSJA,
      url: urlKarty,
      domena: hostKarty,
      host: hostKarty,
      tabId,
      profil: (S && S.diag && S.diag.profil) || null,
      etap: o.etap != null ? o.etap : filtry.etap || (S && S.etap) || null,
      redakcja: o.redakcja != null ? !!o.redakcja : !!$('redakcja').checked,
      // Język eksportu: jawny parametr wygrywa, inaczej ten sam co interfejs (?lang=).
      lang: o.lang || jezyk,
      format: o.format || 'json',
      klasyfikator,
      filtry: {
        platformy: Array.from(filtry.platformy),
        typ: filtry.typ,
        szukaj: filtry.szukaj,
        etap: o.etap != null ? o.etap : filtry.etap,
        zrShopify: filtry.zrShopify,
        zrZgoda: filtry.zrZgoda,
        zrDl: filtry.zrDl,
      },
      teraz: Date.now(),
    };
  }

  // Eksport respektuje filtry widoku; `etap` może dodatkowo zawęzić zbiór (eksport per etap).
  function widocznePozycje(etapWymuszony) {
    const pasuje = (r) => widoczny(r) && (etapWymuszony == null || (r.etap || '') === etapWymuszony);
    return {
      zdarzenia: (S.zdarzenia || []).filter(pasuje).map(doEksportu),
      zadania: (S.zadania || []).filter(pasuje).map(doEksportu),
    };
  }

  function zbudujEksport(opcje) {
    if (!S) return null;
    const o = opcje || {};
    const etapWymuszony = o.etap != null ? o.etap : null;
    return E.zbuduj({
      stan: S,
      widoczne: widocznePozycje(etapWymuszony),
      sieroty,
      meta: metaEksportu(o),
    });
  }

  async function zapiszPlik(plik) {
    const blob = new Blob([plik.tresc], { type: plik.mime + ';charset=utf-8' });
    const adres = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url: adres, filename: 'tracking-debugger/' + plik.nazwa, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(adres), 60000);
    }
    return plik.nazwa;
  }

  async function eksportujDoPliku(format, opcje) {
    if (!S) return toast('Brak stanu — poczekaj na połączenie');
    const plik = zbudujEksport(Object.assign({ format }, opcje || {}));
    try {
      await zapiszPlik(plik);
      $('statusEksportu').textContent = 'zapisano: ' + plik.nazwa;
      toast('Zapisano ' + plik.nazwa);
      return plik.nazwa;
    } catch (e) {
      $('statusEksportu').textContent = 'BŁĄD zapisu: ' + e.message;
      toast('Nie udało się zapisać pliku');
      return null;
    }
  }

  // Osobny plik na etap, we wszystkich trzech formatach.
  async function eksportujEtapy(opcje) {
    if (!S) return [];
    const obecne = new Set();
    for (const r of (S.zdarzenia || []).concat(S.zadania || [])) obecne.add(r.etap || '');
    const etapy = A.ETAPY.filter((e) => obecne.has(e)).concat(Array.from(obecne).filter((e) => e && !A.ETAPY.includes(e)));
    if (obecne.has('')) etapy.push('');
    const zapisane = [];
    for (const etap of etapy) {
      for (const format of ['json', 'md', 'csv']) {
        const plik = zbudujEksport(Object.assign({ format, etap }, opcje || {}));
        try {
          await zapiszPlik(plik);
          zapisane.push(plik.nazwa);
        } catch (e) {}
      }
    }
    $('statusEksportu').textContent = 'zapisano ' + zapisane.length + ' plików (' + etapy.length + ' etapów)';
    toast('Zapisano ' + zapisane.length + ' plików');
    return zapisane;
  }

  // ---------------------------------------------------------------- wiersze
  function wiersz(r) {
    if (r.rodzaj === 'nawigacja') {
      const li = el('li', 'nav-item', r.url);
      li.dataset.uid = r.uid;
      li.dataset.t = String(r.t);
      if (r.etap) li.dataset.etap = r.etap;
      li.title = new Date(r.t).toLocaleString('pl-PL') + ' · ' + (r.przejscie || '');
      return li;
    }
    const poziom = r.flagi && r.flagi.length ? (r.flagi.some((f) => f.poziom === 'error') ? 'error' : 'warn') : null;
    const li = el('li', 'item r-' + r.rodzaj + (poziom ? ' flaga-' + poziom : ''));
    li.dataset.uid = r.uid;
    li.dataset.t = String(r.t);
    if (r.etap) li.dataset.etap = r.etap;
    const head = el('div', 'head');
    li.appendChild(head);
    head.appendChild(el('span', 'time', czas(r.t)));
    if (r.etap) head.appendChild(el('span', 'chip etap', r.etap));

    if (r.rodzaj === 'shopify') {
      head.appendChild(znaczek('shopify', 'Shopify'));
      head.appendChild(el('span', 'name' + (r.typZdarzenia === 'custom' ? ' custom' : ''), r.nazwa));
      for (const [k, v] of Object.entries(r.podsumowanie || {})) head.appendChild(kv(k, v));
      head.appendChild(el('span', 'ramka', '→ piksele: ' + (r.dostarczoneDo ? r.dostarczoneDo.length : 0)));
      if (!r.id) head.appendChild(el('span', 'flaga error', 'brak event.id'));
    } else if (r.rodzaj === 'publish') {
      head.appendChild(znaczek('publish', 'publish'));
      head.appendChild(el('span', 'name custom', r.nazwa));
      head.appendChild(el('span', 'url', 'Shopify.analytics.publish() · ' + etykietaRamki(r.ramka)));
    } else if (r.rodzaj === 'consent') {
      head.appendChild(znaczek('consent', 'consent'));
      head.appendChild(el('span', 'name', 'gtag consent ' + r.komenda));
      for (const [k, v] of Object.entries(r.parametry || {})) head.appendChild(el('span', 'chip ' + klasaZgody(v), k + ': ' + skroc(v, 24)));
      head.appendChild(el('span', 'ramka', etykietaRamki(r.ramka)));
      if (r.odtworzone) head.appendChild(el('span', 'ramka', '(sprzed hooka)'));
    } else if (r.rodzaj === 'datalayer') {
      head.appendChild(znaczek('datalayer', 'dataLayer'));
      head.appendChild(el('span', 'name', r.nazwa));
      if (r.klucze && r.klucze.length) head.appendChild(el('span', 'url', r.klucze.join(', ')));
      head.appendChild(el('span', 'ramka', etykietaRamki(r.ramka)));
    } else if (r.rodzaj === 'gtag-event') {
      head.appendChild(znaczek('gtag-event', 'gtag event'));
      head.appendChild(el('span', 'name', r.nazwa));
      head.appendChild(el('span', 'ramka', etykietaRamki(r.ramka)));
    } else if (r.rodzaj === 'zadanie') {
      const etykieta = r.platform === 'inne' ? 'Inne' : r.platform === 'wlasne' ? 'Domena strony' : r.etykietaPlatformy;
      head.appendChild(znaczek(r.platform, etykietaPlatformy(r.platform, etykieta)));
      if (r.auto) head.appendChild(el('span', 'chip warn', 'wykryty'));
      const nm = el('span', 'name', r.nazwaZdarzenia || r.format || r.typ);
      if (r.ile > 1) nm.textContent += ' [' + r.nr + '/' + r.ile + ']';
      head.appendChild(nm);
      for (const f of r.flagi || []) head.appendChild(el('span', 'flaga ' + f.poziom, f.tekst));
      const pomijane = new Set(['event_name', 'page_location', 'items', 'referrer', 'title', 'l', 'mid', 'sid', 'vid', 'coo']);
      let pokazane = 0;
      for (const f of r.pola || []) {
        if (pomijane.has(f.nazwa) || pokazane >= 7) continue;
        head.appendChild(kv(f.nazwa, f.wartosc));
        pokazane++;
      }
      head.appendChild(el('span', 'ramka', r.metoda + ' · ' + r.typ + ' · ' + (r.ramka ? etykietaRamki(r.ramka.etykieta) : '')));
      head.appendChild(el('span', 'status' + (r.blad ? ' err' : ''), r.blad ? r.blad.replace('net::', '') : r.status != null ? String(r.status) : '…'));
      const u = el('span', 'url', r.host + r.sciezka);
      u.title = r.url;
      head.appendChild(u);
    }

    const kop = el('button', 'copy', 'JSON');
    kop.title = 'Kopiuj pozycję jako JSON';
    kop.addEventListener('click', (e) => {
      e.stopPropagation();
      doSchowka(JSON.stringify(doEksportu(r), null, 2));
    });
    head.appendChild(kop);
    head.addEventListener('click', () => przelaczSzczegoly(li, r));
    return li;
  }

  function tabela(wiersze) {
    const t = document.createElement('table');
    for (const [k, v] of wiersze) {
      if (v === undefined) continue;
      const tr = document.createElement('tr');
      tr.appendChild(el('td', null, k));
      tr.appendChild(el('td', null, typeof v === 'string' ? v : JSON.stringify(v)));
      t.appendChild(tr);
    }
    return t;
  }

  function etykietaPixela(klucz) {
    const p = S && S.piksele && S.piksele[klucz];
    const znana = (ustawienia.etykietyPikseli && ustawienia.etykietyPikseli[klucz]) || (p && p.nazwa);
    if (!p) return klucz + (znana ? ' (' + znana + ')' : '');
    return klucz + (znana ? ' (' + znana + ')' : '') + (p.typ ? ' · ' + p.typ + '/' + (p.srodowisko || '?') : '');
  }

  function przelaczSzczegoly(li, r, wymusOtwarcie) {
    const istniejace = li.querySelector('.details');
    if (istniejace && !wymusOtwarcie) {
      istniejace.remove();
      return;
    }
    if (istniejace) istniejace.remove();
    const d = el('div', 'details');
    if (r.rodzaj === 'shopify') {
      d.appendChild(
        tabela([
          ['event.id', r.id],
          ['event.name', r.nazwa],
          ['type', r.typZdarzenia],
          ['timestamp', r.timestamp],
          ['clientId', r.clientId],
          ['seq', r.seq],
          ['etap', r.etap || '—'],
          ['strona', r.adres],
        ])
      );
      if (r.podsumowanie && Object.keys(r.podsumowanie).length) {
        d.appendChild(el('h5', null, 'Pola kluczowe'));
        d.appendChild(tabela(Object.entries(r.podsumowanie)));
      }
      d.appendChild(el('h5', null, 'Dostarczono do pikseli (' + r.dostarczoneDo.length + ')'));
      d.appendChild(tabela(r.dostarczoneDo.map((k) => ['pixel', etykietaPixela(k)])));
      d.appendChild(el('h5', null, 'data (surowe)'));
      d.appendChild(el('pre', null, JSON.stringify(r.surowe && r.surowe.data !== undefined ? r.surowe.data : r.surowe, null, 2)));
    } else if (r.rodzaj === 'consent') {
      d.appendChild(tabela(Object.entries(r.parametry || {})));
      d.appendChild(tabela([['ramka', r.ramka], ['sprzed hooka', r.odtworzone ? 'tak (odtworzone z istniejącego dataLayer)' : 'nie']]));
    } else if (r.rodzaj === 'datalayer' || r.rodzaj === 'gtag-event' || r.rodzaj === 'publish') {
      d.appendChild(tabela([['ramka', r.ramka], ['etap', r.etap || '—']]));
      d.appendChild(el('pre', null, JSON.stringify(r.surowe, null, 2)));
    } else if (r.rodzaj === 'zadanie') {
      for (const f of r.flagi || []) d.appendChild(el('div', 'flaga ' + f.poziom, f.tekst));
      d.appendChild(
        tabela([
          ['platforma', r.etykietaPlatformy + ' (' + r.format + ')'],
          ['metoda / typ', r.metoda + ' / ' + r.typ],
          ['etap', r.etap || '—'],
          ['ramka', r.ramka ? r.ramka.etykieta + (r.ramka.href ? ' — ' + r.ramka.href : '') : ''],
          ['inicjator', r.inicjator],
          ['status', r.blad ? r.blad : r.status],
          ['body', r.rodzajBody || '(brak)'],
        ])
      );
      if (r.pola && r.pola.length) {
        d.appendChild(el('h5', null, 'Pola kluczowe (nazwa ← parametr)'));
        d.appendChild(tabela(r.pola.map((f) => [f.nazwa + ' ← ' + f.klucz, f.wartosc])));
      }
      const wszystkie = Object.entries(r.parametry || {});
      if (wszystkie.length) {
        d.appendChild(el('h5', null, 'Wszystkie parametry (' + wszystkie.length + ')'));
        d.appendChild(tabela(wszystkie));
      }
      if (r.tekstBody) {
        d.appendChild(el('h5', null, 'Body (surowe, do 16 kB)'));
        d.appendChild(el('pre', null, r.tekstBody));
      }
      if (r.platform === 'sgtm') {
        d.appendChild(el('div', 'granica', 'To jest wyłącznie odcinek przeglądarka → kontener serwerowy. Co ten kontener wysłał dalej (Meta CAPI, GA4 MP, Google Ads), sprawdź w logach kontenera.'));
      }
      if (r.platform === 'inne') {
        const g = el('div', 'granica', 'Host spoza listy rozpoznawanych platform. Jeśli to narzędzie pomiarowe, dodaj je w Opcjach — do tego czasu widzisz je tutaj z pełnym adresem i body. ');
        const b = el('button', 'small', 'Dodaj w Opcjach');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          chrome.runtime.openOptionsPage();
        });
        g.appendChild(b);
        d.appendChild(g);
      }
      d.appendChild(el('h5', null, 'Adres'));
      d.appendChild(el('pre', null, r.url));
    }
    li.appendChild(d);
  }

  // ---------------------------------------------------------------- render
  function zrodloListy(nazwa) {
    if (nazwa === 'zdarzenia') return S.zdarzenia;
    if (nazwa === 'zadania') return S.zadania;
    return S.zdarzenia.concat(S.zadania.filter((r) => r.rodzaj !== 'nawigacja'));
  }

  function wstawWiersz(nazwa, r) {
    const ul = $(LISTY[nazwa].ul);
    let przed = ul.firstChild;
    while (przed && Number(przed.dataset.t || 0) > r.t) przed = przed.nextSibling;
    ul.insertBefore(wiersz(r), przed);
    if (ul.children.length > (nazwa === 'wszystko' ? 3000 : 1500)) ul.removeChild(ul.lastChild);
    $(LISTY[nazwa].pusto).hidden = true;
  }

  function renderujListy() {
    renderujListe('wszystko');
    renderujListe('zdarzenia');
    renderujListe('zadania');
  }

  function renderujListe(nazwa) {
    if (!S) return;
    const zrodlo = zrodloListy(nazwa);
    const ul = $(LISTY[nazwa].ul);
    const frag = document.createDocumentFragment();
    let n = 0;
    const uporzadkowane = zrodlo.map((r, i) => ({ r, i })).sort((a, b) => b.r.t - a.r.t || b.i - a.i);
    for (const { r } of uporzadkowane) {
      if (!widoczny(r)) continue;
      frag.appendChild(wiersz(r));
      n++;
    }
    ul.replaceChildren(frag);
    $(LISTY[nazwa].pusto).hidden = n > 0;
  }

  function subskrybowaneNazwy() {
    const wszystkie = new Set();
    let dowolne = false;
    for (const p of Object.values((S && S.piksele) || {})) {
      for (const s of p.subskrypcje || []) {
        if (s === 'all_events' || s === 'all_standard_events') dowolne = true;
        wszystkie.add(s);
      }
    }
    return { dowolne, wszystkie };
  }

  function renderujLiczniki() {
    if (!S) return;
    const ce = $('licznikZdarzen');
    ce.replaceChildren();
    const liczby = S.liczniki.zdarzenia || {};
    const subs = subskrybowaneNazwy();
    const czyShopify = !!(S.diag && S.diag.shopify) || Object.keys(S.piksele || {}).length > 0;
    const nazwy = A.STANDARDOWE_ZDARZENIA.concat(Object.keys(liczby).filter((n) => !A.STANDARDOWE_ZDARZENIA.includes(n)).sort());
    for (const n of nazwy) {
      const c = liczby[n] || 0;
      const maSub = subs.dowolne || subs.wszystkie.has(n);
      const bezSub = czyShopify && !maSub && !c;
      const chip = el('span', 'chip clickable' + (c ? '' : ' zero') + (filtry.typ === n ? ' on' : '') + (bezSub ? ' nosub' : ''), n + ' ' + c + (bezSub ? ' ∅' : ''));
      chip.title = bezSub
        ? 'ŻADEN sandbox nie subskrybuje „' + n + '" — to zero nie dowodzi, że zdarzenie nie wystąpiło'
        : c
        ? 'kliknij, by filtrować po ' + n
        : 'jeszcze nie widziano: ' + n;
      chip.addEventListener('click', () => {
        filtry.typ = filtry.typ === n ? '' : n;
        $('filtrTypu').value = opcjeTypu.has(filtry.typ) ? filtry.typ : '';
        odswiezWidok();
      });
      ce.appendChild(chip);
    }
    const pf = $('filtryPlatform');
    pf.replaceChildren();
    for (const p of klasyfikator.listaPlatform(S.liczniki.platformy || {})) {
      const c = (S.liczniki.platformy || {})[p.id] || 0;
      const chip = el('span', 'chip clickable' + (c ? '' : ' zero') + (filtry.platformy.has(p.id) ? ' on' : ''), etykietaPlatformy(p.id, p.etykieta) + ' ' + c);
      chip.addEventListener('click', () => {
        if (filtry.platformy.has(p.id)) filtry.platformy.delete(p.id);
        else filtry.platformy.add(p.id);
        aktualizujAdres();
        renderujLiczniki();
        renderujListe('zadania');
        renderujListe('wszystko');
      });
      pf.appendChild(chip);
    }
    renderujSkrotLicznika(nazwy, liczby, subs, czyShopify);
  }

  function renderujHosty() {
    if (!S || !S.diag) return;
    const obce = Object.entries(S.diag.obceHosty || {}).sort((a, b) => b[1] - a[1]);
    const pominiete = Object.entries(S.diag.pominiete || {}).sort((a, b) => b[1] - a[1]);
    $('liczbaObcych').textContent = String(obce.length);
    $('liczbaPominietych').textContent = String(S.diag.pominieteRazem || 0);
    const u = $('hostyObce');
    u.replaceChildren();
    if (obce.length) u.appendChild(el('span', 'meta muted tiny', 'Inne (kliknij = filtr): '));
    for (const [host, n] of obce) {
      const chip = el('span', 'chip', host + ' ' + n);
      chip.title = 'pokaż żądania do ' + host;
      chip.addEventListener('click', () => {
        if (!filtry.platformy.has('inne')) {
          filtry.platformy.clear();
          filtry.platformy.add('inne');
          renderujLiczniki();
        }
        ustawSzukanie(host);
        ustawZakladke('zadania');
      });
      u.appendChild(chip);
    }
    const s = $('hostyPominiete');
    s.replaceChildren();
    if (pominiete.length) s.appendChild(el('span', 'meta tiny', 'Pominięte zasoby statyczne (tylko licznik, bez rekordów): '));
    for (const [host, n] of pominiete.slice(0, 40)) s.appendChild(el('span', 'chip zero', host + ' ' + n));
  }

  // ---------------------------------------------------------------- diagnostyka
  function zbierzStatystyki() {
    const d = (S && S.diag) || {};
    let nieznane = 0;
    let znane = 0;
    let iframeSandboksow = 0;
    let workery = 0;
    for (const f of Object.values(d.ramki || {})) {
      const st = (f && f.stats) || {};
      nieznane += (st.rpcNieznaneDo || 0) + (st.rpcNieznaneOd || 0);
      znane += (st.rpcZdarzenie || 0) + (st.rpcInit || 0) + (st.rpcSubskrypcja || 0) + (st.rpcApiZnane || 0) + (st.rpcZgoda || 0);
      if (f.rodzaj === 'top') {
        iframeSandboksow = st.iframeSandboksow || 0;
        workery = st.workeryPixeli || 0;
      }
    }
    return { nieznane, znane, iframeSandboksow, workery };
  }

  function policzOstrzezenia() {
    const out = [];
    if (!S || !S.diag) return out;
    const d = S.diag;
    const teraz = Date.now();
    const odNawigacji = d.ostatniaNawigacja ? teraz - d.ostatniaNawigacja : null;
    const piksele = Object.values(S.piksele || {});
    const pikseleTejStrony = piksele.filter((p) => d.ostatniaNawigacja && p.ostatnioWidziany && p.ostatnioWidziany >= d.ostatniaNawigacja - 1500);
    const { nieznane, znane, iframeSandboksow } = zbierzStatystyki();

    // ---- 1. Wiarygodność zapisu. To najważniejsze ostrzeżenie panelu i celowo NIE jest
    // zabramkowane obecnością nawigacji: dokument, do którego rozszerzenie nie zdążyło wejść,
    // nigdy nie zgłosi nawigacji, a właśnie wtedy cisza najbardziej udaje brak zdarzeń.
    const w = A.ocenWiarygodnosc(d, teraz, urlKarty);
    if (w.poza) {
      // Strona systemowa: to nie jest ani usterka narzedzia, ani ustalenie o witrynie.
      out.push({ kod: 'wiarygodnosc', poziom: 'info', tekst: A.opisPowodu(w.powod, jezyk) });
    } else if (w.powod === 'brak-sondy-w-dokumencie' || w.powod === 'sonda-sprzed-nawigacji') {
      out.push({ kod: 'wiarygodnosc', poziom: 'err', akcja: 'odswiez', tekst: A.opisPowodu(w.powod, jezyk) });
    } else if (w.powod === 'odzyskane-w-locie') {
      out.push({ kod: 'wiarygodnosc', poziom: 'warn', tekst: A.opisPowodu(w.powod, jezyk) + OSTRZ.zapisKompletnyOd({ od: czas(w.od) }) });
    }

    // ---- 2. Przycięcie listy. Czerwono, bo to znaczy, że część materiału już nie istnieje.
    if (d.usuniete > 0) {
      out.push({ kod: 'przyciecie', poziom: 'err', akcja: 'opcje', tekst: OSTRZ.przyciecie({ usuniete: d.usuniete, limit: d.limitPozycji || konfiguracja.globalne.limitPozycji }) });
    }

    // ---- 3. Piksele bez subskrypcji: zero przy nich jest faktem o pikselu, nie o naszej ślepocie.
    const op = A.ocenPiksele(S.piksele || {});
    if (op.bezSubskrypcji.length) out.push({ kod: 'pikselBezSubskrypcji', poziom: 'info', tekst: OSTRZ.pikselBezSubskrypcji({ lista: op.bezSubskrypcji }) });

    if (d.ostatniaNawigacja && odNawigacji > 6000 && pikseleTejStrony.length > 0 && !(d.ostatnieZdarzenie && d.ostatnieZdarzenie >= d.ostatniaNawigacja - 1500)) {
      out.push({ kod: 'pikseleBezZdarzen', poziom: 'err', tekst: OSTRZ.pikseleBezZdarzen({ ile: pikseleTejStrony.length }) });
    }
    if (piksele.length > 0 && !subskrybowaneNazwy().dowolne) out.push({ kod: 'brakSubskrybenta', poziom: 'warn', tekst: OSTRZ.brakSubskrybenta({}) });
    if (nieznane > 0) out.push({ kod: 'nierozpoznaneRpc', poziom: nieznane > znane ? 'err' : 'warn', tekst: OSTRZ.nierozpoznaneRpc({ nieznane, znane }) });

    const meldunkiPikseli = Object.values(d.meldunki || {}).filter((x) => x.rodzaj === 'custom-pixel' || x.rodzaj === 'app-pixel').length;
    if (d.ostatniaNawigacja && odNawigacji > 5000 && iframeSandboksow > meldunkiPikseli) {
      out.push({ kod: 'sandboksyBezSondy', poziom: 'warn', tekst: OSTRZ.sandboksyBezSondy({ iframe: iframeSandboksow, zSonda: meldunkiPikseli }) });
    }
    const kandydaci = Object.keys(d.kandydaci || {});
    if (kandydaci.length) out.push({ kod: 'kandydatSgtm', poziom: 'warn', akcja: 'opcje', tekst: OSTRZ.kandydatSgtm({ hosty: kandydaci }) });
    if (d.ostatniaNawigacja && odNawigacji > 6000 && d.shopify === false && piksele.length === 0) out.push({ kod: 'brakShopify', poziom: 'info', tekst: OSTRZ.brakShopify({}) });
    if (sieroty && sieroty.razem > 0) out.push({ kod: 'sieroty', poziom: 'info', tekst: OSTRZ.sieroty({ razem: sieroty.razem }) });
    const obce = Object.keys(d.obceHosty || {}).length;
    if (obce > 0) out.push({ kod: 'obceHosty', poziom: 'info', tekst: OSTRZ.obceHosty({ ile: obce }) });
    if (d.restartyWorkera > 0) out.push({ kod: 'restarty', poziom: 'info', tekst: OSTRZ.restarty({ ile: d.restartyWorkera }) });
    return out;
  }

  function renderujDiag() {
    if (!S || !S.diag) return;
    const d = S.diag;
    const chipy = $('chipyDiag');
    chipy.replaceChildren();
    const { nieznane, znane, iframeSandboksow, workery } = zbierzStatystyki();
    const piksele = Object.values(S.piksele || {});
    const czyShopify = d.shopify === true || piksele.length > 0;
    const w = A.ocenWiarygodnosc(d, Date.now(), urlKarty);

    const c0 = el('span', 'chip ' + (d.profil ? 'ok' : 'info'), d.profil ? T.profil(d.profil) : T.profilBrak);
    c0.title = 'Profil dopasowany po domenie karty. Konfigurujesz go w Opcjach.';
    c0.classList.add('clickable');
    c0.addEventListener('click', () => chrome.runtime.openOptionsPage());
    chipy.appendChild(c0);

    // Chip wiarygodności — pierwsza rzecz, którą widać na zrzucie dowodowym.
    const c1 = el(
      'span',
      'chip ' + w.poziom,
      w.powod === 'ok' ? T.sondaOk(czas(w.od)) : w.powod === 'odzyskane-w-locie' ? T.sondaWLocie(czas(w.od)) : w.poza ? T.sondaNieDotyczy : w.powod === 'czekamy' ? '…' : T.sondaBrak
    );
    c1.title = A.opisPowodu(w.powod, jezyk) + (d.adresNawigacji ? ' (' + d.adresNawigacji + ')' : '');
    chipy.appendChild(c1);

    const klasaW = w.wiarygodne ? 'ok' : w.poza || w.powod === 'czekamy' ? 'unknown' : 'err';
    const cW = el('span', 'chip ' + klasaW, w.wiarygodne ? T.wiarygodneOd(czas(w.od)) : w.poza ? T.pozaZasiegiem : w.powod === 'czekamy' ? '…' : T.wiarygodneBrak);
    cW.title = A.opisPowodu(w.powod, jezyk);
    cW.id = 'chipWiarygodnosc';
    chipy.appendChild(cW);

    const c2 = el('span', 'chip ' + (d.shopify === true ? 'ok' : d.shopify === false ? 'info' : 'unknown'), T.shopify(d.shopify === true ? T.tak : d.shopify === false ? T.nie : '?'));
    c2.title = 'Czy na stronie działa manager web pixeli Shopify. „Nie" oznacza, że zakładka Piksele zostanie pusta — to stan strony, nie awaria.';
    chipy.appendChild(c2);

    if (czyShopify) {
      const meldunkiPikseli = Object.values(d.meldunki || {}).filter((x) => x.rodzaj === 'custom-pixel' || x.rodzaj === 'app-pixel').length;
      const c3 = el('span', 'chip ' + (iframeSandboksow > meldunkiPikseli ? 'warn' : 'ok'), T.iframy(meldunkiPikseli, iframeSandboksow, workery));
      c3.title = "iframe'y sandboksów widoczne z ramki głównej vs meldunki sondy z ich wnętrza; workery = app pixele (STRICT)";
      chipy.appendChild(c3);

      const c4 = el('span', 'chip ' + (nieznane === 0 ? 'ok' : nieznane > znane ? 'err' : 'warn'), T.protokol(znane, nieznane));
      c4.title = 'Wiadomości protokołu remote-ui między managerem a sandboksami. Rosnące „nie" = zmiana formatu po stronie Shopify.';
      chipy.appendChild(c4);

      const subs = subskrybowaneNazwy();
      const c5 = el('span', 'chip ' + (subs.dowolne ? 'ok' : piksele.length ? 'warn' : 'unknown'), subs.dowolne ? T.subTak : T.subNie);
      c5.title = 'Czy jakikolwiek sandbox subskrybuje all_standard_events / all_events.';
      chipy.appendChild(c5);
    }

    // Przycięcie listy — czerwony chip, nie cichy licznik obok.
    if (d.usuniete > 0) {
      const cp = el('span', 'chip err', T.przyciete(d.usuniete, d.limitPozycji || konfiguracja.globalne.limitPozycji));
      cp.id = 'chipPrzyciecie';
      cp.title = 'Najstarsze pozycje zostały usunięte z pamięci i nie ma ich w eksporcie.';
      chipy.appendChild(cp);
    }

    const c6 = el('span', 'chip info', T.inneHosty(Object.keys(d.obceHosty || {}).length, d.pominieteRazem || 0, (sieroty && sieroty.razem) || 0));
    c6.title = 'Nic nie ginie po cichu: obce hosty → szuflada Inne; zasoby statyczne → licznik; żądania bez karty → licznik.';
    chipy.appendChild(c6);

    // Werdykt na samej gorze — pierwsza rzecz do przeczytania po otwarciu panelu.
    const wer = $('werdykt');
    const [znak, tytul, tresc] = (WERDYKT[w.powod] || WERDYKT.czekamy)(czas(w.od));
    wer.className = 'werdykt ' + (w.wiarygodne ? (w.powod === 'odzyskane-w-locie' ? 'warn' : 'ok') : w.poza || w.powod === 'czekamy' ? 'unknown' : 'err');
    wer.replaceChildren();
    wer.appendChild(el('span', 'w-znak', znak));
    const tekstWerdyktu = el('span');
    tekstWerdyktu.appendChild(el('span', 'w-tytul', tytul));
    tekstWerdyktu.appendChild(document.createTextNode(' ' + tresc));
    wer.appendChild(tekstWerdyktu);

    const ost = $('ostrzezenia');
    ost.replaceChildren();
    const wszystkieOstrz = policzOstrzezenia();
    const ukryte = ukryteNaDomenie();
    // Czerwonych (err) nie da się ukryć — dotyczą rzetelności zapisu.
    const widoczneOstrz = wszystkieOstrz.filter((x) => x.poziom === 'err' || !ukryte.has(x.kod));
    const schowane = wszystkieOstrz.length - widoczneOstrz.length;
    for (const x of widoczneOstrz) {
      const div = el('div', 'w ' + x.poziom);
      div.appendChild(el('b', null, x.poziom === 'err' ? T.uwaga : x.poziom === 'warn' ? T.ostroznie : T.info));
      div.appendChild(document.createTextNode(x.tekst));
      if (x.akcja === 'opcje') {
        const b = el('button', 'small', OSTRZ.przyciskOpcje);
        b.addEventListener('click', () => chrome.runtime.openOptionsPage());
        div.appendChild(b);
      }
      if (x.akcja === 'odswiez') {
        const b = el('button', 'small', OSTRZ.przyciskOdswiez);
        b.addEventListener('click', () => {
          if (tabId != null) chrome.tabs.reload(tabId);
        });
        div.appendChild(b);
      }
      if (x.poziom !== 'err' && hostKarty) {
        const b = el('button', 'small ukryj', jezyk === 'en' ? 'Hide on this domain' : 'Ukryj na tej domenie');
        b.title = 'Nie pokazuj tego komunikatu na ' + hostKarty + ' (przywrócisz go linkiem pod listą ostrzeżeń)';
        b.addEventListener('click', () => {
          ukryte.add(x.kod);
          zapiszUkryte(ukryte);
          renderujDiag();
        });
        div.appendChild(b);
      }
      ost.appendChild(div);
    }
    const u = $('ukryteOstrzezenia');
    u.replaceChildren();
    u.hidden = !schowane;
    if (schowane) {
      u.appendChild(document.createTextNode((jezyk === 'en' ? 'Hidden on this domain: ' : 'Ukryte na tej domenie: ') + schowane));
      const b = el('button', 'small', jezyk === 'en' ? 'Show' : 'Pokaż');
      b.addEventListener('click', () => {
        zapiszUkryte(new Set());
        renderujDiag();
      });
      u.appendChild(b);
    }
    renderujSkrotDiag(w, widoczneOstrz);
    rozwinPrzyNowymProblemie(widoczneOstrz);

    const det = $('szczegolyDiag');
    det.replaceChildren();
    const linia = (k, v) => {
      const r = el('div');
      r.appendChild(el('span', 'k', k + ': '));
      r.appendChild(document.createTextNode(v));
      det.appendChild(r);
    };
    linia('wiarygodność', w.powod + ' — ' + A.opisPowodu(w.powod, jezyk));
    linia('dane wiarygodne od', w.wiarygodne ? czas(w.od) : 'NIE USTALONO');
    linia('profil / host', (d.profil || 'brak') + ' / ' + (hostKarty || '?'));
    linia('kontenery serwerowe z konfiguracji', (ustawienia.serwerowe || []).join(', ') || 'brak — wpisz w Opcjach');
    linia('ostatnia nawigacja', d.ostatniaNawigacja ? czas(d.ostatniaNawigacja) + ' ' + (d.adresNawigacji || '') : '—');
    linia('karta obserwowana od', d.odkryteO ? czas(d.odkryteO) : '—');
    if (d.odzyskaneO) linia('sonda dostrzyknięta w locie', czas(d.odzyskaneO) + ' (' + (d.powodOdzyskania || '') + ')');
    const meldunki = Object.entries(d.meldunki || {});
    linia('meldunki sondy (ta strona)', meldunki.length ? meldunki.map(([k, v]) => k + ' @' + czas(v.t)).join(' · ') : '—');
    for (const [etykieta, f] of Object.entries(d.ramki || {})) linia('liczniki ' + etykieta, JSON.stringify(f.stats));
    if (Object.keys(d.kandydaci || {}).length) linia('wykryte kontenery serwerowe', JSON.stringify(d.kandydaci));
    if (sieroty && sieroty.razem) linia('poza kartą (hosty)', JSON.stringify(sieroty.hosty));
    if (Object.keys(d.sciezkiWlasne || {}).length) linia('domena strony (ścieżki)', JSON.stringify(d.sciezkiWlasne));
    linia('usunięte z widoku (limit)', String(d.usuniete || 0) + ' / limit ' + (d.limitPozycji || konfiguracja.globalne.limitPozycji));
    linia('restarty service workera', String(d.restartyWorkera || 0));

    renderujPrezentacje(w);
  }

  // ---------------------------------------------------------------- tryb prezentacji
  function renderujPrezentacje(w) {
    if (!prezentacja || !S) return;
    const rz = E.rzetelnosc(S, sieroty, Date.now());
    const pozycje = (S.zdarzenia || []).concat(S.zadania || []);
    let od = null;
    let doo = null;
    for (const r of pozycje) {
      if (!r.t) continue;
      if (od === null || r.t < od) od = r.t;
      if (doo === null || r.t > doo) doo = r.t;
    }
    $('pnWersja').textContent = 'v' + WERSJA;
    $('pnDomena').textContent = hostKarty || urlKarty || '—';
    $('pnOkno').textContent = (od ? E.czasZMs(od) : '—') + '  →  ' + (doo ? E.czasZMs(doo) : '—');
    $('pnEtap').textContent = filtry.etap || (S && S.etap) || T.etapBrak;
    const pnw = $('pnWiarygodne');
    pnw.textContent = w.wiarygodne ? E.czasZMs(w.od) + (w.powod === 'odzyskane-w-locie' ? (jezyk === 'en' ? '  (attached mid-document)' : '  (dołączono w locie)') : '') : (jezyk === 'en' ? 'NOT ESTABLISHED — ' : 'NIE USTALONO — ') + w.powod;
    pnw.className = w.wiarygodne ? 'ok' : 'err';
    const opisy =
      jezyk === 'en'
        ? ['dropped by limit', 'worker restarts', 'frames without probe', 'undecoded RPC', 'skipped static', 'requests outside tab']
        : ['usunięte przez limit', 'restarty workera', 'ramki bez sondy', 'nierozpoznane RPC', 'pominięte zasoby', 'żądania bez karty'];
    const wartosci = [rz.usuniete, rz.restartyWorkera, rz.ramkiBezSondy, rz.nierozpoznaneRpc, rz.pominieteZasoby, rz.zadaniaBezKarty];
    const box = $('pnRzetelnosc');
    box.replaceChildren();
    for (let i = 0; i < opisy.length; i++) {
      const zle = i === 0 ? wartosci[i] > 0 : i === 2 || i === 3 ? wartosci[i] > 0 : false;
      box.appendChild(el('span', 'pn-licznik' + (zle ? ' zly' : ''), opisy[i] + ': ' + wartosci[i]));
    }
    const f = [];
    if (filtry.platformy.size) f.push('platform=' + Array.from(filtry.platformy).join('+'));
    if (filtry.typ) f.push('type=' + filtry.typ);
    if (filtry.szukaj) f.push('search=' + filtry.szukaj);
    if (filtry.etap) f.push('stage=' + filtry.etap);
    $('pnFiltry').textContent = f.length ? f.join(' · ') : jezyk === 'en' ? 'none (everything)' : 'brak (wszystko)';
  }

  function renderujZgode() {
    if (!S) return;
    const c = S.zgoda || {};
    const g = $('zgodaGtag');
    g.replaceChildren();
    const gt = c.gtag || {};
    const podstawowe = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
    const klucze = podstawowe.concat(Object.keys(gt).filter((k) => !podstawowe.includes(k)));
    let jakiekolwiek = false;
    for (const k of klucze) {
      if (!(k in gt)) continue;
      jakiekolwiek = true;
      const chip = el('span', 'chip ' + klasaZgody(gt[k]), k + ': ' + gt[k]);
      const zr = (c.zrodlaGtag || {})[k];
      if (zr) chip.title = "gtag('consent','" + zr.komenda + "') · " + zr.ramka + ' · ' + czas(zr.t);
      g.appendChild(chip);
    }
    if (!jakiekolwiek) g.appendChild(el('span', 'chip unknown', 'gtag consent: brak komend'));

    const gc = $('zgodaGcs');
    gc.replaceChildren();
    if (c.gcs && c.gcs.wartosc) {
      const v = String(c.gcs.wartosc);
      const ad = v.charAt(2) === '1' ? 'granted' : v.charAt(2) === '0' ? 'denied' : '?';
      const an = v.charAt(3) === '1' ? 'granted' : v.charAt(3) === '0' ? 'denied' : '?';
      const chip = el('span', 'chip ' + (ad === 'granted' && an === 'granted' ? 'granted' : ad === 'denied' && an === 'denied' ? 'denied' : 'unknown'), 'gcs=' + v);
      chip.title = 'gcs: ad_storage=' + ad + ', analytics_storage=' + an + ' · ostatnio: ' + c.gcs.platforma + ' ' + c.gcs.url + ' · ' + czas(c.gcs.t) + (c.gcs.gcd ? ' · gcd=' + c.gcs.gcd : '');
      gc.appendChild(chip);
    } else {
      gc.appendChild(el('span', 'chip unknown', 'gcs: —'));
    }

    const sh = $('zgodaShopify');
    sh.replaceChildren();
    if (c.shopify && c.shopify.stan) {
      const vc = c.shopify.stan.visitorConsent || {};
      for (const k of ['analytics', 'marketing', 'preferences', 'sale_of_data']) {
        const v = vc[k] == null || vc[k] === '' ? '(brak decyzji)' : vc[k];
        const chip = el('span', 'chip ' + klasaZgody(vc[k]), 'shopify ' + k + ': ' + v);
        chip.title = 'Shopify.customerPrivacy.currentVisitorConsent() · ' + c.shopify.zrodlo + ' · ' + czas(c.shopify.t);
        sh.appendChild(chip);
      }
      for (const k of ['analyticsProcessingAllowed', 'marketingAllowed', 'saleOfDataAllowed', 'shouldShowBanner', 'analyticsAllowed']) {
        if (k in c.shopify.stan) sh.appendChild(el('span', 'chip ' + (k === 'shouldShowBanner' ? 'unknown' : klasaZgody(c.shopify.stan[k])), k + ': ' + c.shopify.stan[k]));
      }
    } else {
      sh.appendChild(el('span', 'chip unknown', 'Shopify.customerPrivacy: brak odczytu'));
    }

    const cm = $('zgodaCmp');
    cm.replaceChildren();
    if (c.cmp && c.cmp.stan) {
      const st = c.cmp.stan;
      cm.appendChild(el('span', 'chip info', 'CMP: ' + (c.cmp.cmp || '?')));
      for (const k of Object.keys(st).slice(0, 6)) {
        cm.appendChild(el('span', 'chip ' + klasaZgody(st[k]), k + ': ' + skroc(st[k], 24)));
      }
    }

    const historia = c.historia || [];
    $('btnHistoriaZgody').textContent = 'Historia (' + historia.length + ')';
    const ol = $('historiaZgody');
    ol.replaceChildren();
    for (let i = historia.length - 1; i >= 0; i--) {
      const x = historia[i];
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(czas(x.t) + ' · ' + x.rodzaj + ' · '));
      li.appendChild(el('span', 'src', x.zrodlo + (x.ramka ? ' · ' + x.ramka : '') + (x.odtworzone ? ' · (sprzed hooka)' : '') + ' → '));
      li.appendChild(document.createTextNode(JSON.stringify(x.wartosci)));
      ol.appendChild(li);
    }
    renderujSkrotZgody(c);
  }

  function renderujPiksele() {
    if (!S) return;
    const box = $('piksele');
    box.replaceChildren();
    const lista = Object.values(S.piksele || {}).sort((a, b) => String(a.typ).localeCompare(String(b.typ)) || String(a.id).localeCompare(String(b.id)));
    $('pustoPiksele').hidden = lista.length > 0;
    $('licznikZakladkiPikseli').textContent = String(lista.length);
    for (const p of lista) {
      const d = el('div', 'pixel');
      d.dataset.pixel = String(p.id);
      const head = el('div', 'head');
      head.appendChild(el('span', 'id', p.id));
      const znana = (ustawienia.etykietyPikseli && ustawienia.etykietyPikseli[p.id]) || p.nazwa;
      if (znana) head.appendChild(el('span', null, znana));
      if (p.typ) head.appendChild(znaczek(p.typ === 'CUSTOM' ? 'sgtm' : 'google-tag', p.typ + ' / ' + (p.srodowisko || '?')));
      head.appendChild(el('span', 'meta', (p.gospodarz === 'worker' ? 'worker' : p.gospodarz === 'iframe' ? 'iframe' : '') + ' · zdarzeń: ' + (p.zdarzeniaOdebrane || 0) + ' · rejestracji: ' + (p.rejestracje || 0)));
      d.appendChild(head);
      const meta = [];
      if (p.apiClientId != null) meta.push('apiClientId=' + p.apiClientId);
      if (p.dataSharingState) meta.push('dataSharing=' + p.dataSharingState);
      if (p.privacyPurposes) meta.push('privacyPurposes=' + JSON.stringify(p.privacyPurposes));
      if (p.scriptVersion) meta.push('scriptVersion=' + p.scriptVersion);
      if (meta.length) d.appendChild(el('div', 'meta', meta.join(' · ')));
      const subs = el('div', 'subs chips');
      if (p.subskrypcje && p.subskrypcje.length) {
        subs.appendChild(el('span', 'meta', 'analytics.subscribe: '));
        for (const s of p.subskrypcje) subs.appendChild(el('span', 'chip', s));
      } else {
        subs.appendChild(el('span', 'meta err', 'analytics.subscribe: BRAK — ten piksel nie może dostać żadnego zdarzenia (albo subskrybował przed wejściem sondy)'));
      }
      d.appendChild(subs);
      if (p.konfiguracja || (p.wywolaniaApi && p.wywolaniaApi.length)) {
        const det = document.createElement('details');
        det.appendChild(el('summary', null, 'konfiguracja / wywołania API sandboksa (' + ((p.wywolaniaApi && p.wywolaniaApi.length) || 0) + ')'));
        if (p.konfiguracja) det.appendChild(el('pre', null, p.konfiguracja));
        if (p.wywolaniaApi && p.wywolaniaApi.length) det.appendChild(el('pre', null, p.wywolaniaApi.map((a) => czas(a.t) + ' ' + a.api + '(' + a.arg + ')').join('\n')));
        d.appendChild(det);
      }
      box.appendChild(d);
    }
  }

  // ---------------------------------------------------------------- sekcje zwijane i ich skróty
  // Zwinięta sekcja zostawia jedną linię ze skrótem stanu, więc nic nie znika z oczu.
  // Stan zwinięcia i ostrzeżenia ukryte per domena żyją w localStorage (tylko wygoda widoku —
  // brak pamięci = wszystko działa, tylko bez zapamiętania).
  const pamiec = {
    czytaj(klucz, domyslna) {
      try {
        const v = localStorage.getItem('td.' + klucz);
        return v == null ? domyslna : JSON.parse(v);
      } catch (e) {
        return domyslna;
      }
    },
    zapisz(klucz, wartosc) {
      try {
        localStorage.setItem('td.' + klucz, JSON.stringify(wartosc));
      } catch (e) {}
    },
  };
  const sekcje = () => Array.from(document.querySelectorAll('.sekcja'));
  const zwinieteDomyslnie = { etap: true, diag: true, zgoda: true, licznik: true };

  function ustawZwiniecie(sekcja, zwin, bezZapisu) {
    sekcja.classList.toggle('zwinieta', zwin);
    const b = sekcja.querySelector('.sek-przelacz');
    if (b) b.setAttribute('aria-expanded', String(!zwin));
    if (!bezZapisu) {
      const stan = pamiec.czytaj('zwiniete', {});
      stan[sekcja.dataset.sekcja] = zwin;
      pamiec.zapisz('zwiniete', stan);
    }
    odswiezTrybPracy();
  }

  function odswiezTrybPracy() {
    const wszystkieZwiniete = sekcje().every((s) => s.classList.contains('zwinieta'));
    $('btnTrybPracy').classList.toggle('active', wszystkieZwiniete);
  }

  function mignijSekcja(nazwa) {
    const s = document.querySelector('.sekcja[data-sekcja="' + nazwa + '"]');
    if (!s || !s.classList.contains('zwinieta')) return;
    s.classList.remove('nowe');
    void s.offsetWidth;
    s.classList.add('nowe');
  }

  function ukryteNaDomenie() {
    return new Set(pamiec.czytaj('ukryte.' + (hostKarty || '?'), []));
  }
  function zapiszUkryte(zbior) {
    pamiec.zapisz('ukryte.' + (hostKarty || '?'), Array.from(zbior));
  }

  // Diagnostyka rozwija się sama tylko przy NOWYM problemie (err / warn), którego w tym panelu
  // jeszcze nie pokazano. Znane problemy nie wracają przy każdym odświeżeniu — kod, nie tekst,
  // bo tekst niesie zmienne liczby.
  // Pokazane problemy pamiętamy per domena — to samo ostrzeżenie przy kolejnym otwarciu panelu
  // zostaje w skrócie (⚠ 1), ale nie rozwija sekcji drugi raz.
  function rozwinPrzyNowymProblemie(lista) {
    if (!hostKarty) return; // bez hosta pamięć trafiłaby pod zły klucz
    const pokazaneProblemy = new Set(pamiec.czytaj('pokazane.' + hostKarty, []));
    let nowy = false;
    for (const x of lista) {
      if (x.poziom !== 'err' && x.poziom !== 'warn') continue;
      const klucz = x.poziom + '|' + x.kod;
      if (pokazaneProblemy.has(klucz)) continue;
      pokazaneProblemy.add(klucz);
      nowy = true;
    }
    if (nowy) pamiec.zapisz('pokazane.' + hostKarty, Array.from(pokazaneProblemy));
    const s = $('pasekDiag');
    if (nowy && s.classList.contains('zwinieta')) {
      ustawZwiniecie(s, false, true);
      s.classList.remove('nowe');
      void s.offsetWidth;
      s.classList.add('nowe');
    }
  }

  const chipSkrotu = (klasa, tekst, tytul) => {
    const c = el('span', 'chip ' + klasa, tekst);
    if (tytul) c.title = tytul;
    return c;
  };

  function renderujSkrotEtapu() {
    const box = $('skrotEtapu');
    box.replaceChildren();
    const aktywny = (S && S.etap) || null;
    box.appendChild(aktywny ? chipSkrotu('etap', aktywny, 'aktywny etap') : chipSkrotu('unknown', T.etapBrak));
    for (const [format, etykieta] of [['json', 'JSON'], ['md', 'MD'], ['csv', 'CSV']]) {
      const b = el('button', 'small', etykieta);
      b.title = 'Eksport ' + etykieta + ' (jak w rozwiniętej sekcji)';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        eksportujDoPliku(format);
      });
      box.appendChild(b);
    }
  }

  const SKROT_WERDYKTU = {
    pl: { ok: (c) => '✔ kompletny od ' + c, 'odzyskane-w-locie': (c) => '▲ w locie od ' + c, 'brak-sondy-w-dokumencie': () => '✖ nie widzę zdarzeń', 'sonda-sprzed-nawigacji': () => '✖ nie widzę zdarzeń', 'poza-zasiegiem': () => '● strona systemowa', 'poza-zasiegiem-plik': () => '● file:// bez zgody', czekamy: () => '… ładowanie' },
    en: { ok: (c) => '✔ complete from ' + c, 'odzyskane-w-locie': (c) => '▲ attached at ' + c, 'brak-sondy-w-dokumencie': () => '✖ events not visible', 'sonda-sprzed-nawigacji': () => '✖ events not visible', 'poza-zasiegiem': () => '● system page', 'poza-zasiegiem-plik': () => '● file:// no access', czekamy: () => '… loading' },
  }[jezyk];

  function renderujSkrotDiag(w, lista) {
    const box = $('skrotDiag');
    box.replaceChildren();
    const klasa = w.wiarygodne ? (w.powod === 'odzyskane-w-locie' ? 'warn' : 'ok') : w.poza || w.powod === 'czekamy' ? 'unknown' : 'err';
    const krotko = (SKROT_WERDYKTU[w.powod] || SKROT_WERDYKTU.czekamy)(czas(w.od).slice(0, 8));
    box.appendChild(chipSkrotu(klasa, krotko, A.opisPowodu(w.powod, jezyk)));
    const ile = { err: 0, warn: 0, info: 0 };
    for (const x of lista) ile[x.poziom] = (ile[x.poziom] || 0) + 1;
    if (ile.err) box.appendChild(chipSkrotu('err', '✖ ' + ile.err, 'ostrzeżenia krytyczne'));
    if (ile.warn) box.appendChild(chipSkrotu('warn', '⚠ ' + ile.warn, 'ostrzeżenia'));
    if (ile.info) box.appendChild(chipSkrotu('info', 'ℹ ' + ile.info, 'informacje'));
    if (S && S.diag && S.diag.usuniete > 0) box.appendChild(chipSkrotu('err', T.przyciete(S.diag.usuniete, S.diag.limitPozycji || konfiguracja.globalne.limitPozycji)));
  }

  function renderujSkrotZgody(c) {
    const box = $('skrotZgody');
    box.replaceChildren();
    const gt = c.gtag || {};
    const wartosci = Object.values(gt).map(klasaZgody);
    if (!wartosci.length) box.appendChild(chipSkrotu('unknown', 'gtag: —'));
    else {
      const g = wartosci.filter((v) => v === 'granted').length;
      const d = wartosci.filter((v) => v === 'denied').length;
      const reszta = wartosci.length - g - d;
      const tekst = [g ? g + ' × granted' : '', d ? d + ' × denied' : '', reszta ? reszta + ' × ?' : ''].filter(Boolean).join(' · ');
      box.appendChild(chipSkrotu(d && !g ? 'denied' : d ? 'warn' : 'granted', tekst, Object.entries(gt).map(([k, v]) => k + '=' + v).join(', ')));
    }
    if (c.gcs && c.gcs.wartosc) {
      const v = String(c.gcs.wartosc);
      box.appendChild(chipSkrotu(v === 'G111' ? 'granted' : v === 'G100' ? 'denied' : 'unknown', v, 'gcs z ostatniego hitu Google'));
    }
    if (c.shopify && c.shopify.stan) {
      const st = c.shopify.stan;
      const vc = st.visitorConsent || {};
      const decyzje = ['analytics', 'marketing', 'preferences', 'sale_of_data'].filter((k) => vc[k] != null && vc[k] !== '');
      if (decyzje.length) {
        box.appendChild(chipSkrotu('info', 'Shopify: ' + decyzje.map((k) => k + '=' + vc[k]).join(' · ')));
      } else if ('analyticsProcessingAllowed' in st || 'marketingAllowed' in st) {
        const a = klasaZgody(st.analyticsProcessingAllowed);
        const m = klasaZgody(st.marketingAllowed);
        box.appendChild(chipSkrotu(a === 'granted' && m === 'granted' ? 'granted' : a === 'denied' && m === 'denied' ? 'denied' : 'unknown', 'Shopify: analytics ' + (a === 'granted' ? '✓' : a === 'denied' ? '✗' : '?') + ' · marketing ' + (m === 'granted' ? '✓' : m === 'denied' ? '✗' : '?'), 'brak decyzji odwiedzającego; wartości …Allowed'));
      } else box.appendChild(chipSkrotu('unknown', 'Shopify: brak decyzji'));
    }
    if (c.cmp && c.cmp.cmp) box.appendChild(chipSkrotu('info', 'CMP: ' + c.cmp.cmp));
    const h = (c.historia || []).length;
    if (h) box.appendChild(chipSkrotu('unknown', (jezyk === 'en' ? 'changes: ' : 'zmian: ') + h));
  }

  function renderujSkrotLicznika(nazwy, liczby, subs, czyShopify) {
    const box = $('skrotLicznika');
    box.replaceChildren();
    let zera = 0;
    let bezSub = 0;
    for (const n of nazwy) {
      const c = liczby[n] || 0;
      if (c) box.appendChild(chipSkrotu('', n + ' ' + c));
      else {
        zera++;
        if (czyShopify && !(subs.dowolne || subs.wszystkie.has(n))) bezSub++;
      }
    }
    if (zera) box.appendChild(chipSkrotu('zero', zera + ' × 0'));
    if (bezSub) box.appendChild(chipSkrotu('nosub', '∅ ' + bezSub, 'zdarzenia bez subskrybenta — ich zero nic nie dowodzi'));
  }

  function odswiezLiczniki() {
    if (!S) return;
    $('licznikZakladkiZdarzen').textContent = String(S.zdarzenia.filter((r) => r.rodzaj !== 'nawigacja').length);
    $('licznikZakladkiZadan').textContent = String(S.zadania.filter((r) => r.rodzaj !== 'nawigacja').length);
    $('licznikZakladkiWszystko').textContent = String(S.zdarzenia.concat(S.zadania).filter((r) => r.rodzaj !== 'nawigacja').length);
  }

  function renderujWszystko() {
    if (!S) return;
    if (!S.diag) S.diag = {};
    opcjeTypu.clear();
    opcjeEtapu.clear();
    for (const r of S.zdarzenia) {
      dodajOpcjeTypu(r);
      dodajOpcjeEtapu(r);
    }
    for (const r of S.zadania) {
      dodajOpcjeTypu(r);
      dodajOpcjeEtapu(r);
    }
    renderujOpcjeTypu();
    renderujOpcjeEtapu();
    renderujEtap();
    renderujLiczniki();
    renderujZgode();
    renderujPiksele();
    renderujListy();
    renderujHosty();
    renderujDiag();
    odswiezLiczniki();
  }

  // ---------------------------------------------------------------- UI
  function ustawZakladke(nazwa) {
    aktywnaZakladka = nazwa;
    for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('active', b.dataset.zakladka === nazwa);
    $('panelWszystko').hidden = nazwa !== 'wszystko';
    $('panelZdarzen').hidden = nazwa !== 'zdarzenia';
    $('panelZadan').hidden = nazwa !== 'zadania';
    $('panelPikseli').hidden = nazwa !== 'piksele';
  }
  for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => ustawZakladke(b.dataset.zakladka));

  $('filtrTypu').addEventListener('change', (e) => {
    filtry.typ = e.target.value;
    odswiezWidok();
  });
  $('filtrEtapu').addEventListener('change', (e) => {
    filtry.etap = e.target.value;
    odswiezWidok();
  });
  let timerSzukania = null;
  $('szukaj').addEventListener('input', (e) => {
    clearTimeout(timerSzukania);
    timerSzukania = setTimeout(() => {
      filtry.szukaj = e.target.value.trim().toLowerCase();
      aktualizujAdres();
      renderujListy();
    }, 150);
  });
  for (const [id, klucz] of [['zrShopify', 'zrShopify'], ['zrZgoda', 'zrZgoda'], ['zrDl', 'zrDl']]) {
    $(id).addEventListener('change', (e) => {
      filtry[klucz] = e.target.checked;
      renderujListe('zdarzenia');
      renderujListe('wszystko');
    });
  }
  function opiszPauze() {
    const lbl = $('btnPauza').querySelector('.lbl');
    const tekst = wstrzymany ? 'Wznów (' + oczekujace.length + ')' : 'Pauza';
    if (lbl) lbl.textContent = tekst;
    $('btnPauza').title = wstrzymany ? tekst + ' — widok wstrzymany, zbieranie trwa' : 'Wstrzymaj odświeżanie widoku (zbieranie trwa dalej)';
  }

  // Sekcje: stan z pamięci (domyślnie zwinięte), klik w nagłówek przełącza, „Tryb pracy" zwija
  // wszystko naraz albo — gdy już wszystko zwinięte — rozwija.
  {
    const zapamietane = pamiec.czytaj('zwiniete', {});
    for (const s of sekcje()) {
      const nazwa = s.dataset.sekcja;
      ustawZwiniecie(s, nazwa in zapamietane ? !!zapamietane[nazwa] : !!zwinieteDomyslnie[nazwa], true);
      s.querySelector('.sek-glowa').addEventListener('click', (e) => {
        if (prezentacja) return;
        if (e.target.closest('button') && !e.target.closest('.sek-przelacz')) return;
        ustawZwiniecie(s, !s.classList.contains('zwinieta'));
      });
      s.addEventListener('animationend', () => s.classList.remove('nowe'));
    }
    $('btnTrybPracy').addEventListener('click', () => {
      const zwin = !sekcje().every((s) => s.classList.contains('zwinieta'));
      for (const s of sekcje()) ustawZwiniecie(s, zwin);
    });
    // Wąski panel: rząd platform przewija się w poziomie kółkiem myszy.
    $('filtryPlatform').addEventListener(
      'wheel',
      (e) => {
        const box = e.currentTarget;
        if (box.scrollWidth <= box.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        box.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false }
    );
  }

  $('btnHistoriaZgody').addEventListener('click', () => {
    $('historiaZgody').hidden = !$('historiaZgody').hidden;
  });
  $('btnSzczegolyDiag').addEventListener('click', () => {
    $('szczegolyDiag').hidden = !$('szczegolyDiag').hidden;
  });
  $('btnOpcje').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnPauza').addEventListener('click', () => {
    wstrzymany = !wstrzymany;
    opiszPauze();
    $('btnPauza').classList.toggle('active', wstrzymany);
    if (!wstrzymany) while (oczekujace.length) zastosuj(oczekujace.shift());
  });
  setInterval(() => {
    if (wstrzymany) opiszPauze();
    if (S && !wstrzymany) renderujDiag(); // warunki czasowe (brak meldunku po N sekundach)
  }, 2000);
  $('btnWyczysc').addEventListener('click', () => {
    if (port && tabId != null) port.postMessage({ typ: 'wyczysc', tabId });
  });
  $('btnKopiuj').addEventListener('click', () => {
    if (!S) return;
    const zrodlo = aktywnaZakladka === 'piksele' ? Object.values(S.piksele) : zrodloListy(aktywnaZakladka);
    const out = aktywnaZakladka === 'piksele' ? zrodlo : zrodlo.filter((r) => r.rodzaj !== 'nawigacja' && widoczny(r)).map(doEksportu);
    doSchowka(JSON.stringify(out, null, 2));
  });
  $('btnOkno').addEventListener('click', () => {
    if (tabId == null) return;
    chrome.windows.create({ url: chrome.runtime.getURL('panel/panel.html?tryb=okno&tab=' + tabId), type: 'popup', width: 1200, height: 900 });
  });
  $('btnEtapUstaw').addEventListener('click', () => ustawEtap($('etapWlasny').value.trim() || null));
  $('etapWlasny').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ustawEtap($('etapWlasny').value.trim() || null);
  });
  $('btnEtapWyczysc').addEventListener('click', () => ustawEtap(null));
  $('btnEksportJson').addEventListener('click', () => eksportujDoPliku('json'));
  $('btnEksportMd').addEventListener('click', () => eksportujDoPliku('md'));
  $('btnEksportCsv').addEventListener('click', () => eksportujDoPliku('csv'));
  $('btnEksportEtapy').addEventListener('click', () => eksportujEtapy());

  // ---------------------------------------------------------------- API dla agenta
  // Czytające i sterujące widokiem. Żadna z tych funkcji nie wysyła niczego do sieci.
  window.__td = {
    wersja: WERSJA,
    etapy: A.ETAPY,
    // true, gdy panel jest podłączony do workera I MA stan — agent czeka na to zamiast zgadywać.
    gotowe: () => !!(port && S && S.diag && tabId != null),
    stan: () => {
      const plik = zbudujEksport({ format: 'json', redakcja: false });
      return plik ? JSON.parse(plik.tresc) : null;
    },
    diagnostyka: () => (S ? E.rzetelnosc(S, sieroty, Date.now()) : null),
    filtr: (f) => {
      const o = f || {};
      if ('platforma' in o) {
        filtry.platformy = new Set(
          (Array.isArray(o.platforma) ? o.platforma : String(o.platforma || '').split(',')).map((x) => String(x).trim()).filter(Boolean)
        );
      }
      if ('typ' in o) {
        filtry.typ = o.typ ? String(o.typ) : '';
        $('filtrTypu').value = opcjeTypu.has(filtry.typ) ? filtry.typ : '';
      }
      if ('szukaj' in o) {
        filtry.szukaj = String(o.szukaj || '').trim().toLowerCase();
        $('szukaj').value = o.szukaj || '';
      }
      if ('etap' in o) {
        filtry.etap = o.etap ? String(o.etap) : '';
        $('filtrEtapu').value = opcjeEtapu.has(filtry.etap) ? filtry.etap : '';
      }
      if ('zakladka' in o) ustawZakladke(String(o.zakladka));
      odswiezWidok();
      return { platforma: Array.from(filtry.platformy), typ: filtry.typ, szukaj: filtry.szukaj, etap: filtry.etap, adres: location.href };
    },
    etap: (nazwa) => ustawEtap(nazwa === undefined ? null : nazwa),
    // Zwraca TREŚĆ eksportu jako string — agent zapisuje ją sam, bez pobierania pliku przez CDP.
    eksport: (o) => {
      const plik = zbudujEksport(Object.assign({ format: 'json' }, o || {}));
      return plik ? plik.tresc : null;
    },
    nazwaPliku: (o) => {
      const plik = zbudujEksport(Object.assign({ format: 'json' }, o || {}));
      return plik ? plik.nazwa : null;
    },
    // Zapis do pliku przez chrome.downloads (jak przyciski w panelu).
    zapisz: (o) => eksportujDoPliku((o && o.format) || 'json', o || {}),
    zapiszEtapy: (o) => eksportujEtapy(o || {}),
  };

  // ---------------------------------------------------------------- start
  function zastosujTrybPrezentacji() {
    if (prezentacja) {
      document.body.classList.add('prezentacja');
      $('naglowekPrezentacji').hidden = false;
    }
    if (jezyk === 'en') {
      document.body.classList.add('lang-en');
      for (const e of document.querySelectorAll('[data-en]')) e.textContent = e.dataset.en;
      const zakladki = { wszystko: 'All', zdarzenia: 'Events', zadania: 'Requests', piksele: 'Pixels' };
      for (const b of document.querySelectorAll('nav.tabs button')) {
        const licznik = b.querySelector('.cnt');
        b.textContent = zakladki[b.dataset.zakladka] + ' ';
        if (licznik) b.appendChild(licznik);
      }
      $('pustoWszystko').textContent = 'No events or requests captured.';
      $('pustoZdarzenia').textContent = 'No events captured.';
      $('pustoZadania').textContent = 'No requests for this tab.';
      $('pustoPiksele').textContent = 'No registered web pixels.';
    }
  }

  async function startBok() {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t) subskrybuj(t.id);
    } catch (e) {}
    chrome.tabs.onActivated.addListener(({ tabId: id, windowId }) => {
      chrome.windows.getCurrent().then((w) => {
        if (w.id === windowId) subskrybuj(id);
      });
    });
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (id === tabId && (info.title || info.url)) odswiezInfoKarty();
    });
  }

  async function startOkno() {
    const sel = $('wyborKarty');
    sel.hidden = false;
    const odswiez = async () => {
      const wszystkie = await chrome.tabs.query({});
      sel.replaceChildren();
      for (const t of wszystkie) {
        if (!/^https?:/.test(t.url || '')) continue;
        const o = document.createElement('option');
        o.value = String(t.id);
        o.textContent = '#' + t.id + ' ' + (t.title || t.url || '').slice(0, 60);
        sel.appendChild(o);
      }
      if (tabId != null) sel.value = String(tabId);
    };
    await odswiez();
    sel.addEventListener('change', () => subskrybuj(Number(sel.value)));
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (info.title || info.url) odswiez();
      if (id === tabId) odswiezInfoKarty();
    });
    chrome.tabs.onRemoved.addListener(odswiez);
    if (tabId == null && sel.options.length) subskrybuj(Number(sel.options[0].value));
    else odswiezInfoKarty();
  }

  zastosujTrybPrezentacji();
  $('szukaj').value = qs.get('szukaj') || '';
  K.wczytaj().then((cfg) => {
    konfiguracja = cfg;
    przeliczUstawienia();
    if (S) renderujWszystko();
  });
  polacz();
  if (tryb === 'okno') startOkno();
  else startBok();
})();
