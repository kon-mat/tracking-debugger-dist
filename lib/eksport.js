// lib/eksport.js — zapis materialu dowodowego do pliku. Ladowane przez panel (<script>) i testy.
//
// Trzy formaty z jednego stanu: JSON (pelny, maszynowy), Markdown (czytelny dla czlowieka),
// CSV (same zadania pomiarowe, jeden wiersz na hit — do arkusza).
//
// Kazdy eksport niesie ten sam naglowek i te same LICZNIKI RZETELNOSCI. To nie jest ozdoba:
// odbiorca, ktory dostaje sam wykaz zdarzen, nie ma jak odroznic „tego nie bylo" od
// „tego nie zobaczylem". Naglowek mowi wprost, od ktorej sekundy zapis jest kompletny,
// ile pozycji wypadlo przez limit, ile ramek nie mialo sondy i ile wiadomosci protokolu
// bylo nieczytelnych. Bez tego material dowodowy nie jest materialem dowodowym.
//
// Nic tu nie wychodzi do sieci — funkcje zwracaja tekst, zapisem zajmuje sie panel.
self.TDEksport = (() => {
  'use strict';

  const A = self.TDAnaliza;

  // ------------------------------------------------------------------ czas
  const dwa = (n) => String(n).padStart(2, '0');
  function stempel(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + dwa(d.getMonth() + 1) + '-' + dwa(d.getDate()) + '-' + dwa(d.getHours()) + dwa(d.getMinutes());
  }
  function czasLokalny(t) {
    if (!t) return '—';
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + dwa(d.getMonth() + 1) + '-' + dwa(d.getDate()) + ' ' + dwa(d.getHours()) + ':' + dwa(d.getMinutes()) + ':' + dwa(d.getSeconds())
    );
  }
  function czasZMs(t) {
    if (!t) return '—';
    return czasLokalny(t) + '.' + String(new Date(t).getMilliseconds()).padStart(3, '0');
  }


  // ------------------------------------------------------------------ etykiety (PL / EN)
  // Eksport Markdown/CSV bywa zalacznikiem dla klienta, wiec musi dac sie wydac po angielsku.
  // Dane (nazwy zdarzen, hosty, parametry) zostaja bez zmian — tlumaczymy wylacznie etykiety.
  const ETYKIETY = {
    pl: {
      tytul: 'Tracking Debugger — zapis sesji pomiarowej',
      wygenerowano: 'Wygenerowano',
      wersja: 'Wersja rozszerzenia',
      strona: 'Badana strona',
      domena: 'Domena',
      karta: 'Identyfikator karty',
      oknoZapisu: 'Okno czasowe zapisu',
      oknoEksportu: 'Okno czasowe tego eksportu',
      etap: 'Etap',
      calaSesja: '(cała sesja)',
      profil: 'Profil konfiguracji',
      globalne: '(ustawienia globalne)',
      filtry: 'Aktywne filtry',
      pominieto: 'Pominięto przez filtry',
      pominietoOpis: (g) => g.razem + ' pozycji (zdarzenia: ' + g.zdarzenia + ', żądania: ' + g.zadania + ')',
      redakcja: 'Tryb redakcji',
      redakcjaWl: 'WŁĄCZONY — dane osobowe i tokeny zamaskowane przez ',
      redakcjaWyl: 'wyłączony (zapis surowy)',
      naglowekRzetelnosci: 'Rzetelność zapisu — przeczytaj przed wnioskami',
      wiarygodnyOd: 'Zapis wiarygodny od ',
      niewiarygodny: 'UWAGA — zapis NIE jest kompletny.',
      odKiedy: 'Od kiedy dane są wiarygodne',
      nieustalono: 'NIE USTALONO — patrz ostrzeżenie wyżej',
      przyczyna: 'Przyczyna',
      usuniete: 'Usunięte przez limit listy',
      usunieteUwaga: '  [!] LISTA BYŁA PRZYCINANA — najstarsze pozycje nie są już dostępne',
      limit: 'Limit pozycji',
      restarty: 'Restarty service workera',
      ramkiBezSondy: 'Ramki (sandboksy) bez sondy',
      zWidocznych: ' z ',
      widocznych: ' widocznych',
      nierozpoznane: 'Nierozpoznane wiadomości RPC',
      rozpoznane: ' (rozpoznane: ',
      pominieteZasoby: 'Pominięte zasoby statyczne',
      tylkoLicznik: ' (tylko licznik, bez rekordów)',
      obceHosty: 'Obce hosty w szufladzie Inne',
      bezKarty: 'Żądania bez przypisanej karty',
      pikseleBezSub: 'Piksele bez analytics.subscribe',
      pikseleBezSubOpis: ' — protokół NIE dostarczy im żadnego zdarzenia',
      pikseleCiche: 'Piksele z subskrypcją, ale bez zdarzeń',
      brak: 'brak',
      naglowekGranicy: 'Granica widoczności',
      granica1: 'Zapis obejmuje wyłącznie odcinek **przeglądarka → serwer**. To, co kontener serwerowy wysłał dalej',
      granica2: '(Meta CAPI, GA4 Measurement Protocol, Google Ads), nie jest widoczne w przeglądarce i nie ma go w tym pliku.',
      etapNaglowek: 'Etap: ',
      zdarzenia: 'Zdarzenia',
      zadania: 'Żądania pomiarowe',
      brakKursywa: '_brak_',
      bezEtapu: '(bez etapu)',
      nawigacja: 'nawigacja → ',
      doPikseli: ' → pikseli: ',
      polePole: 'Pole',
      poleWartosc: 'Wartość',
      kolumny: ['czas', 'etap', 'platforma', 'etykieta_platformy', 'metoda', 'typ_zasobu', 'host', 'sciezka', 'nazwa_zdarzenia', 'event_id', 'transaction_id', 'value', 'currency', 'gcs', 'client_id', 'pixel_id', 'status', 'ramka', 'flagi', 'adres'],
      brakFiltrow: 'brak (wszystko)',
      wylaczoneRodzaje: 'wyłączone rodzaje: ',
      prefiksyFiltrow: { platforma: 'platformy', typ: 'typ', szukaj: 'szukaj', etap: 'etap' },
      csv: { narzedzie: 'narzedzie', wygenerowano: 'wygenerowano', strona: 'badana_strona', domena: 'domena', karta: 'karta', okno: 'okno_czasowe_zapisu', etap: 'etap', profil: 'profil', filtry: 'filtry', pominieto: 'pominieto_przez_filtry', redakcja: 'tryb_redakcji', wiarygodne: 'dane_wiarygodne_od', nieustalono: 'NIE USTALONO', wl: 'wlaczony', wyl: 'wylaczony', calosc: '(cala sesja)', globalne: '(globalne)', rzUsuniete: 'rzetelnosc_usuniete', rzRestarty: 'rzetelnosc_restarty_workera', rzRamki: 'rzetelnosc_ramki_bez_sondy', rzRpc: 'rzetelnosc_nierozpoznane_rpc', rzZasoby: 'rzetelnosc_pominiete_zasoby', rzBezKarty: 'rzetelnosc_zadania_bez_karty' },
    },
    en: {
      tytul: 'Tracking Debugger — measurement session record',
      wygenerowano: 'Generated',
      wersja: 'Extension version',
      strona: 'Site under test',
      domena: 'Domain',
      karta: 'Tab identifier',
      oknoZapisu: 'Capture window',
      oknoEksportu: 'Window of this export',
      etap: 'Stage',
      calaSesja: '(whole session)',
      profil: 'Configuration profile',
      globalne: '(global settings)',
      filtry: 'Active filters',
      pominieto: 'Skipped by filters',
      pominietoOpis: (g) => g.razem + ' items (events: ' + g.zdarzenia + ', requests: ' + g.zadania + ')',
      redakcja: 'Redaction mode',
      redakcjaWl: 'ON — personal data and tokens masked with ',
      redakcjaWyl: 'off (raw record)',
      naglowekRzetelnosci: 'Record reliability — read before drawing conclusions',
      wiarygodnyOd: 'Record reliable from ',
      niewiarygodny: 'WARNING — the record is NOT complete.',
      odKiedy: 'Data reliable from',
      nieustalono: 'NOT ESTABLISHED — see the warning above',
      przyczyna: 'Cause',
      usuniete: 'Dropped by list limit',
      usunieteUwaga: '  [!] THE LIST WAS TRIMMED — the oldest items are no longer available',
      limit: 'Item limit',
      restarty: 'Service worker restarts',
      ramkiBezSondy: 'Frames (sandboxes) without probe',
      zWidocznych: ' of ',
      widocznych: ' visible',
      nierozpoznane: 'Undecoded RPC messages',
      rozpoznane: ' (decoded: ',
      pominieteZasoby: 'Skipped static resources',
      tylkoLicznik: ' (counter only, no records)',
      obceHosty: 'Third-party hosts in the Other drawer',
      bezKarty: 'Requests with no owning tab',
      pikseleBezSub: 'Pixels without analytics.subscribe',
      pikseleBezSubOpis: ' — by protocol they receive NO events at all',
      pikseleCiche: 'Pixels with a subscription but no events',
      brak: 'none',
      naglowekGranicy: 'Boundary of visibility',
      granica1: 'This record covers the **browser → server** leg only. What the server-side container forwarded onward',
      granica2: '(Meta CAPI, GA4 Measurement Protocol, Google Ads) is not visible in the browser and is not in this file.',
      etapNaglowek: 'Stage: ',
      zdarzenia: 'Events',
      zadania: 'Measurement requests',
      brakKursywa: '_none_',
      bezEtapu: '(no stage)',
      nawigacja: 'navigation → ',
      doPikseli: ' → pixels: ',
      polePole: 'Field',
      poleWartosc: 'Value',
      kolumny: ['time', 'stage', 'platform', 'platform_label', 'method', 'resource_type', 'host', 'path', 'event_name', 'event_id', 'transaction_id', 'value', 'currency', 'gcs', 'client_id', 'pixel_id', 'status', 'frame', 'flags', 'url'],
      brakFiltrow: 'none (everything)',
      wylaczoneRodzaje: 'excluded kinds: ',
      prefiksyFiltrow: { platforma: 'platform', typ: 'type', szukaj: 'search', etap: 'stage' },
      csv: { narzedzie: 'tool', wygenerowano: 'generated', strona: 'site_under_test', domena: 'domain', karta: 'tab', okno: 'capture_window', etap: 'stage', profil: 'profile', filtry: 'filters', pominieto: 'skipped_by_filters', redakcja: 'redaction_mode', wiarygodne: 'data_reliable_from', nieustalono: 'NOT ESTABLISHED', wl: 'on', wyl: 'off', calosc: '(whole session)', globalne: '(global)', rzUsuniete: 'reliability_dropped_by_limit', rzRestarty: 'reliability_worker_restarts', rzRamki: 'reliability_frames_without_probe', rzRpc: 'reliability_undecoded_rpc', rzZasoby: 'reliability_skipped_static', rzBezKarty: 'reliability_requests_outside_tab' },
    },
  };

  const etykiety = (meta) => (String((meta && meta.lang) || 'pl').toLowerCase() === 'en' ? ETYKIETY.en : ETYKIETY.pl);

  // ------------------------------------------------------------------ redakcja
  // Maskowanie ma byc WIDOCZNE. Ciche usuniecie pola sprawia, ze odbiorca nie wie,
  // ze cos tam bylo — a to zmienia wnioski. Wszedzie zostaje `***`.
  const MASKA = '***';

  // Nazwy parametrow, ktore niosa dane osobowe albo identyfikatory uzytkownika.
  const KLUCZE_WRAZLIWE =
    /(^|[._\[-])(em|ph|fn|ln|em_?hash|e?mail|phone|tel|client_?id|cid|user_?id|uid|external_?id|fbp|fbc|_fbp|_fbc|_ga|_gid|_gcl_[a-z]+|ga_?client|sid|session_?id|token|access_?token|id_?token|auth|authorization|password|api_?key|secret|signature|hmac|checkout_?token|cart_?token|customer_?id|address\d?|zip|postal|birth)($|[._\]-])/i;

  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // Telefon musi WYGLADAC na telefon. Sam ciag 9+ cyfr to na tej scenie zwykle identyfikator
  // pixela, konwersji albo znacznik czasu — maskowanie takich wartosci kosztowaloby wartosc dowodowa
  // (odbiorca nie wiedzialby, o ktory piksel chodzi), a nie chronilo niczego, czego nie chroni juz
  // maskowanie po nazwie pola (`ph`, `phone`, `tel`, `ud[ph]`). Dlatego wzorzec jest waski:
  //   - prefiks miedzynarodowy `+48501234567`, albo
  //   - grupy po 2-3 cyfry rozdzielone spacja / kropka / mysinikiem, lacznie 9-12 cyfr.
  // Grupa 4-cyfrowa (rok) i dwukropek (godzina) wykluczaja dopasowanie, wiec daty i czasy zostaja.
  const RE_TELEFON_SEP = /(?<![\w.:+-])\d{2,3}(?:[ .-]\d{2,3}){2,4}(?![\w.:-])/g;
  const RE_TELEFON_MIEDZYNARODOWY = /(?<![\w.])\+\d[\d .-]{8,16}\d(?![\w.])/g;
  const RE_HOST = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;
  const RE_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;

  // kontekst: { domena, znanyHost(host)->bool }
  function redagujTekst(s, kontekst) {
    let out = String(s);
    out = out.replace(RE_EMAIL, MASKA + '@' + MASKA);
    out = out.replace(RE_HOST, (host) => {
      const h = host.toLowerCase();
      if (kontekst.wlasny(h)) return host;
      if (kontekst.znanyHost(h)) return host;
      return MASKA + '.' + h.split('.').pop();
    });
    out = out.replace(RE_TELEFON_MIEDZYNARODOWY, (m) => (m.replace(/\D/g, '').length >= 9 ? MASKA : m));
    out = out.replace(RE_TELEFON_SEP, (m) => {
      const cyfry = m.replace(/\D/g, '').length;
      return cyfry >= 9 && cyfry <= 12 ? MASKA : m;
    });
    out = out.replace(RE_TOKEN, (m) => (/^[A-Za-z0-9_-]+$/.test(m) && m.length >= 24 ? m.slice(0, 4) + MASKA : m));
    return out;
  }

  function redagujWartosc(klucz, wartosc, kontekst) {
    if (wartosc === null || wartosc === undefined) return wartosc;
    if (klucz && KLUCZE_WRAZLIWE.test(String(klucz))) return MASKA;
    if (typeof wartosc === 'string') return redagujTekst(wartosc, kontekst);
    if (typeof wartosc === 'number' || typeof wartosc === 'boolean') return wartosc;
    return redagujGleboko(wartosc, kontekst, 0);
  }

  function redagujGleboko(v, kontekst, glebokosc) {
    if (glebokosc > 8 || v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => redagujGleboko(x, kontekst, glebokosc + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = redagujWartosc(k, v[k], kontekst);
      return out;
    }
    if (typeof v === 'string') return redagujTekst(v, kontekst);
    return v;
  }

  // Kontekst redakcji budowany z ustawien karty: wlasna domena zostaje, znane platformy zostaja,
  // reszta hostow idzie pod maske (odbiorca nie ma dostawac listy narzedzi, ktore go nie dotycza).
  function kontekstRedakcji(meta) {
    const domena = String(meta.domena || '').toLowerCase();
    const klasyfikator = meta.klasyfikator || null;
    const pamiec = new Map();
    return {
      wlasny: (h) => !!domena && (h === domena || h.endsWith('.' + domena) || domena.endsWith('.' + h)),
      znanyHost: (h) => {
        if (pamiec.has(h)) return pamiec.get(h);
        let znany = false;
        try {
          znany = !!(klasyfikator && klasyfikator.klasyfikuj('https://' + h + '/collect', meta.host || '', 'GET'));
        } catch (e) {}
        pamiec.set(h, znany);
        return znany;
      },
    };
  }

  // ------------------------------------------------------------------ liczniki rzetelnosci
  function rzetelnosc(stan, sieroty, teraz) {
    const d = (stan && stan.diag) || {};
    let nieznaneDo = 0;
    let nieznaneOd = 0;
    let spozaRpc = 0;
    let rozpoznane = 0;
    let sandboksow = 0;
    for (const f of Object.values(d.ramki || {})) {
      const st = (f && f.stats) || {};
      nieznaneDo += st.rpcNieznaneDo || 0;
      nieznaneOd += st.rpcNieznaneOd || 0;
      spozaRpc += st.wiadomosciSpozaRpc || 0;
      rozpoznane += (st.rpcZdarzenie || 0) + (st.rpcInit || 0) + (st.rpcSubskrypcja || 0) + (st.rpcApiZnane || 0) + (st.rpcZgoda || 0);
      if (f.rodzaj === 'top') sandboksow = st.iframeSandboksow || 0;
    }
    const zSonda = Object.values(d.meldunki || {}).filter((x) => x.rodzaj === 'custom-pixel' || x.rodzaj === 'app-pixel').length;
    return {
      usuniete: d.usuniete || 0,
      przycieteListy: (d.usuniete || 0) > 0,
      limitPozycji: d.limitPozycji || null,
      restartyWorkera: d.restartyWorkera || 0,
      ramkiBezSondy: Math.max(0, sandboksow - zSonda),
      sandboksowWidocznych: sandboksow,
      sandboksowZSonda: zSonda,
      nierozpoznaneRpc: nieznaneDo + nieznaneOd + spozaRpc,
      nierozpoznaneRpcSzczegoly: { doSandboksa: nieznaneDo, odSandboksa: nieznaneOd, spozaProtokolu: spozaRpc, rozpoznane },
      pominieteZasoby: d.pominieteRazem || 0,
      obceHosty: Object.keys(d.obceHosty || {}).length,
      zadaniaBezKarty: (sieroty && sieroty.razem) || 0,
      wiarygodnosc: A.ocenWiarygodnosc(d, teraz || Date.now()),
      piksele: A.ocenPiksele((stan && stan.piksele) || {}),
    };
  }

  // ------------------------------------------------------------------ naglowek
  function oknoCzasowe(pozycje) {
    let od = null;
    let doo = null;
    for (const r of pozycje) {
      if (!r || !r.t) continue;
      if (od === null || r.t < od) od = r.t;
      if (doo === null || r.t > doo) doo = r.t;
    }
    return { od, do: doo };
  }

  function opisFiltrow(f, L) {
    if (!f) return { opis: L.brakFiltrow, pola: {} };
    const czesci = [];
    const P = L.prefiksyFiltrow;
    if (f.platformy && f.platformy.length) czesci.push(P.platforma + '=' + f.platformy.join('+'));
    if (f.typ) czesci.push(P.typ + '=' + f.typ);
    if (f.szukaj) czesci.push(P.szukaj + '="' + f.szukaj + '"');
    if (f.etap) czesci.push(P.etap + '=' + f.etap);
    const wyl = [];
    if (f.zrShopify === false) wyl.push('Shopify');
    if (f.zrZgoda === false) wyl.push('consent');
    if (f.zrDl === false) wyl.push('dataLayer/gtag/publish');
    if (wyl.length) czesci.push(L.wylaczoneRodzaje + wyl.join(', '));
    return {
      opis: czesci.length ? czesci.join(' · ') : L.brakFiltrow,
      pola: { platformy: f.platformy || [], typ: f.typ || null, szukaj: f.szukaj || null, etap: f.etap || null, wylaczoneRodzaje: wyl },
    };
  }

  function naglowek(dane) {
    const { stan, widoczne, meta, sieroty } = dane;
    const teraz = meta.teraz || Date.now();
    const wszystkie = (stan.zdarzenia || []).concat(stan.zadania || []);
    const okno = oknoCzasowe(wszystkie);
    const oknoWidoczne = oknoCzasowe((widoczne.zdarzenia || []).concat(widoczne.zadania || []));
    const filtry = opisFiltrow(meta.filtry, etykiety(meta));
    const pominietoZdarzen = (stan.zdarzenia || []).length - (widoczne.zdarzenia || []).length;
    const pominietoZadan = (stan.zadania || []).length - (widoczne.zadania || []).length;
    return {
      narzedzie: 'Tracking Debugger',
      wersjaRozszerzenia: meta.wersja || '?',
      wygenerowano: new Date(teraz).toISOString(),
      wygenerowanoLokalnie: czasLokalny(teraz),
      badanaStrona: meta.url || null,
      domena: meta.domena || null,
      identyfikatorKarty: meta.tabId != null ? String(meta.tabId) : null,
      profil: meta.profil || null,
      etap: meta.etap || null,
      trybRedakcji: !!meta.redakcja,
      oknoCzasoweZapisu: { od: czasZMs(okno.od), do: czasZMs(okno.do), odMs: okno.od, doMs: okno.do },
      oknoCzasoweEksportu: { od: czasZMs(oknoWidoczne.od), do: czasZMs(oknoWidoczne.do) },
      filtry: filtry.pola,
      filtryOpis: filtry.opis,
      pominietoPrzezFiltry: { zdarzenia: pominietoZdarzen, zadania: pominietoZadan, razem: pominietoZdarzen + pominietoZadan },
      pozycjeWEksporcie: { zdarzenia: (widoczne.zdarzenia || []).length, zadania: (widoczne.zadania || []).length },
      rzetelnosc: rzetelnosc(stan, sieroty, teraz),
    };
  }

  // ------------------------------------------------------------------ nazwa pliku
  function nazwaPliku(meta, rozszerzenie) {
    const domena = String(meta.domena || 'strona')
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const etap = String(meta.etap || 'calosc')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'calosc';
    return 'td-' + (domena || 'strona') + '-' + stempel(meta.teraz || Date.now()) + '-' + etap + '.' + rozszerzenie;
  }

  // ------------------------------------------------------------------ oczyszczanie rekordow
  function bezPomocniczych(r) {
    const o = Object.assign({}, r);
    delete o._s;
    return o;
  }

  // ------------------------------------------------------------------ JSON
  function doJson(dane) {
    const g = naglowek(dane);
    const k = kontekstRedakcji(dane.meta);
    const przez = (r) => (dane.meta.redakcja ? redagujGleboko(bezPomocniczych(r), k, 0) : bezPomocniczych(r));
    const tresc = {
      naglowek: g,
      zdarzenia: (dane.widoczne.zdarzenia || []).map(przez),
      zadania: (dane.widoczne.zadania || []).map(przez),
      piksele: dane.meta.redakcja ? redagujGleboko(dane.stan.piksele || {}, k, 0) : dane.stan.piksele || {},
      zgoda: dane.meta.redakcja ? redagujGleboko(dane.stan.zgoda || {}, k, 0) : dane.stan.zgoda || {},
      diagnostyka: dane.meta.redakcja ? redagujGleboko(dane.stan.diag || {}, k, 0) : dane.stan.diag || {},
    };
    return { nazwa: nazwaPliku(dane.meta, 'json'), mime: 'application/json', tresc: JSON.stringify(tresc, null, 2) };
  }

  // ------------------------------------------------------------------ Markdown
  function mdTabela(wiersze, L) {
    const linie = ['| ' + L.polePole + ' | ' + L.poleWartosc + ' |', '| --- | --- |'];
    for (const [k, v] of wiersze) linie.push('| ' + k + ' | ' + String(v === null || v === undefined ? '—' : v).replace(/\|/g, '\\|') + ' |');
    return linie.join('\n');
  }

  function opisRekordu(r, k, redakcja, L) {
    const t = czasZMs(r.t);
    const et = r.etap ? ' `[' + r.etap + ']`' : '';
    const tekst = (s) => (redakcja ? redagujTekst(String(s), k) : String(s));
    if (r.rodzaj === 'nawigacja') return '- **' + t + '**' + et + ' — ' + L.nawigacja + tekst(r.url);
    if (r.rodzaj === 'shopify') {
      const pola = Object.entries(r.podsumowanie || {})
        .map(([a, b]) => a + '=' + (redakcja && KLUCZE_WRAZLIWE.test(a) ? MASKA : tekst(b)))
        .join(', ');
      return '- **' + t + '**' + et + ' — `' + r.nazwa + '` (web pixel)' + L.doPikseli + (r.dostarczoneDo || []).length + (pola ? ' · ' + pola : '');
    }
    if (r.rodzaj === 'zadanie') {
      const flagi = (r.flagi || []).map((f) => ' **[' + f.poziom.toUpperCase() + ': ' + f.tekst + ']**').join('');
      const pola = (r.pola || [])
        .filter((f) => ['event_id', 'transaction_id', 'value', 'currency', 'gcs', 'pixel_id', 'tid', 'conversion_id'].includes(f.nazwa))
        .map((f) => f.nazwa + '=' + (redakcja && KLUCZE_WRAZLIWE.test(f.nazwa) ? MASKA : tekst(f.wartosc)))
        .join(', ');
      return (
        '- **' + t + '**' + et + ' — ' + r.etykietaPlatformy + ' · `' + (r.nazwaZdarzenia || r.format) + '` · ' + r.metoda + ' ' + tekst(r.host + r.sciezka) +
        ' · status ' + (r.blad || r.status || '—') + (pola ? ' · ' + pola : '') + flagi
      );
    }
    return '- **' + t + '**' + et + ' — ' + r.rodzaj + ' `' + (r.nazwa || '') + '`' + (r.ramka ? ' · ' + tekst(r.ramka) : '');
  }

  function doMarkdown(dane) {
    const g = naglowek(dane);
    const k = kontekstRedakcji(dane.meta);
    const L = etykiety(dane.meta);
    const rz = g.rzetelnosc;
    const w = g.rzetelnosc.wiarygodnosc;
    const lista = [];
    lista.push('# ' + L.tytul);
    lista.push('');
    lista.push(
      mdTabela(
        [
          [L.wygenerowano, g.wygenerowanoLokalnie + ' (' + g.wygenerowano + ')'],
          [L.wersja, g.wersjaRozszerzenia],
          [L.strona, dane.meta.redakcja ? redagujTekst(String(g.badanaStrona || '—'), k) : g.badanaStrona],
          [L.domena, g.domena],
          [L.karta, g.identyfikatorKarty],
          [L.oknoZapisu, g.oknoCzasoweZapisu.od + ' → ' + g.oknoCzasoweZapisu.do],
          [L.oknoEksportu, g.oknoCzasoweEksportu.od + ' → ' + g.oknoCzasoweEksportu.do],
          [L.etap, g.etap || L.calaSesja],
          [L.profil, g.profil || L.globalne],
          [L.filtry, g.filtryOpis],
          [L.pominieto, L.pominietoOpis(g.pominietoPrzezFiltry)],
          [L.redakcja, g.trybRedakcji ? L.redakcjaWl + MASKA : L.redakcjaWyl],
        ],
        L
      )
    );
    lista.push('');
    lista.push('## ' + L.naglowekRzetelnosci);
    lista.push('');
    lista.push('> ' + (w.wiarygodne ? '**' + L.wiarygodnyOd + czasZMs(w.od) + '.**' : '**' + L.niewiarygodny + '**') + ' ' + A.opisPowodu(w.powod, dane.meta.lang));
    lista.push('');
    lista.push(
      mdTabela(
        [
          [L.odKiedy, w.wiarygodne ? czasZMs(w.od) : L.nieustalono],
          [L.przyczyna, w.powod],
          [L.usuniete, rz.usuniete + (rz.przycieteListy ? L.usunieteUwaga : '')],
          [L.limit, rz.limitPozycji == null ? '—' : rz.limitPozycji],
          [L.restarty, rz.restartyWorkera],
          [L.ramkiBezSondy, rz.ramkiBezSondy + L.zWidocznych + rz.sandboksowWidocznych + L.widocznych],
          [L.nierozpoznane, rz.nierozpoznaneRpc + L.rozpoznane + rz.nierozpoznaneRpcSzczegoly.rozpoznane + ')'],
          [L.pominieteZasoby, rz.pominieteZasoby + L.tylkoLicznik],
          [L.obceHosty, rz.obceHosty],
          [L.bezKarty, rz.zadaniaBezKarty],
          [L.pikseleBezSub, rz.piksele.bezSubskrypcji.length ? rz.piksele.bezSubskrypcji.join(', ') + L.pikseleBezSubOpis : L.brak],
          [L.pikseleCiche, rz.piksele.zSubskrypcjaBezZdarzen.length ? rz.piksele.zSubskrypcjaBezZdarzen.join(', ') : L.brak],
        ],
        L
      )
    );
    lista.push('');
    lista.push('## ' + L.naglowekGranicy);
    lista.push('');
    lista.push(L.granica1);
    lista.push(L.granica2);
    lista.push('');

    const grupy = new Map();
    const dodajDoGrupy = (r, gdzie) => {
      const e = r.etap || L.bezEtapu;
      if (!grupy.has(e)) grupy.set(e, { zdarzenia: [], zadania: [] });
      grupy.get(e)[gdzie].push(r);
    };
    for (const r of dane.widoczne.zdarzenia || []) dodajDoGrupy(r, 'zdarzenia');
    for (const r of dane.widoczne.zadania || []) dodajDoGrupy(r, 'zadania');
    const kolejnosc = A.ETAPY.filter((e) => grupy.has(e));
    for (const e of grupy.keys()) if (!kolejnosc.includes(e)) kolejnosc.push(e);

    for (const etap of kolejnosc) {
      const gr = grupy.get(etap);
      lista.push('## ' + L.etapNaglowek + etap);
      lista.push('');
      lista.push('### ' + L.zdarzenia + ' (' + gr.zdarzenia.length + ')');
      lista.push('');
      if (!gr.zdarzenia.length) lista.push(L.brakKursywa);
      for (const r of gr.zdarzenia.slice().sort((a, b) => a.t - b.t)) lista.push(opisRekordu(r, k, dane.meta.redakcja, L));
      lista.push('');
      lista.push('### ' + L.zadania + ' (' + gr.zadania.length + ')');
      lista.push('');
      if (!gr.zadania.length) lista.push(L.brakKursywa);
      for (const r of gr.zadania.slice().sort((a, b) => a.t - b.t)) lista.push(opisRekordu(r, k, dane.meta.redakcja, L));
      lista.push('');
    }
    return { nazwa: nazwaPliku(dane.meta, 'md'), mime: 'text/markdown', tresc: lista.join('\n') };
  }

  // ------------------------------------------------------------------ CSV
  const KOLUMNY = [
    'czas',
    'etap',
    'platforma',
    'etykieta_platformy',
    'metoda',
    'typ_zasobu',
    'host',
    'sciezka',
    'nazwa_zdarzenia',
    'event_id',
    'transaction_id',
    'value',
    'currency',
    'gcs',
    'client_id',
    'pixel_id',
    'status',
    'ramka',
    'flagi',
    'adres',
  ];

  function pole(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function doCsv(dane) {
    const g = naglowek(dane);
    const k = kontekstRedakcji(dane.meta);
    const E = etykiety(dane.meta);
    const C = E.csv;
    const rz = g.rzetelnosc;
    const w = rz.wiarygodnosc;
    const L = [];
    // Naglowek jako komentarze — arkusze wczytuja to jako wiersze tekstu, a plik zostaje samoopisowy.
    const kom = (a, b) => L.push('# ' + a + ',' + pole(b));
    kom(C.narzedzie, 'Tracking Debugger ' + g.wersjaRozszerzenia);
    kom(C.wygenerowano, g.wygenerowanoLokalnie);
    kom(C.strona, dane.meta.redakcja ? redagujTekst(String(g.badanaStrona || ''), k) : g.badanaStrona);
    kom(C.domena, g.domena);
    kom(C.karta, g.identyfikatorKarty);
    kom(C.okno, g.oknoCzasoweZapisu.od + ' - ' + g.oknoCzasoweZapisu.do);
    kom(C.etap, g.etap || C.calosc);
    kom(C.profil, g.profil || C.globalne);
    kom(C.filtry, g.filtryOpis);
    kom(C.pominieto, g.pominietoPrzezFiltry.razem);
    kom(C.redakcja, g.trybRedakcji ? C.wl : C.wyl);
    kom(C.wiarygodne, w.wiarygodne ? czasZMs(w.od) : C.nieustalono + ' (' + w.powod + ')');
    kom(C.rzUsuniete, rz.usuniete);
    kom(C.rzRestarty, rz.restartyWorkera);
    kom(C.rzRamki, rz.ramkiBezSondy);
    kom(C.rzRpc, rz.nierozpoznaneRpc);
    kom(C.rzZasoby, rz.pominieteZasoby);
    kom(C.rzBezKarty, rz.zadaniaBezKarty);
    L.push(E.kolumny.join(','));
    const tekst = (s) => (dane.meta.redakcja ? redagujTekst(String(s == null ? '' : s), k) : s);
    const wrazliwe = (nazwa, v) => (dane.meta.redakcja && KLUCZE_WRAZLIWE.test(nazwa) ? MASKA : tekst(v));
    for (const r of (dane.widoczne.zadania || []).filter((x) => x.rodzaj === 'zadanie').sort((a, b) => a.t - b.t)) {
      const sem = r.sem || {};
      L.push(
        [
          czasZMs(r.t),
          r.etap || '',
          r.platform,
          r.etykietaPlatformy,
          r.metoda,
          r.typ,
          tekst(r.host),
          tekst(r.sciezka),
          r.nazwaZdarzenia || '',
          wrazliwe('event_id', sem.event_id),
          tekst(sem.transaction_id),
          sem.value,
          sem.currency,
          sem.gcs,
          wrazliwe('client_id', sem.client_id),
          sem.pixel_id,
          r.blad || r.status || '',
          r.ramka ? r.ramka.etykieta : '',
          (r.flagi || []).map((f) => f.poziom + ':' + f.kod).join(' '),
          tekst(r.url),
        ]
          .map(pole)
          .join(',')
      );
    }
    return { nazwa: nazwaPliku(dane.meta, 'csv'), mime: 'text/csv', tresc: L.join('\n') };
  }

  // ------------------------------------------------------------------ wejscie
  function zbuduj(dane) {
    const format = String((dane.meta && dane.meta.format) || dane.format || 'json').toLowerCase();
    const pelne = Object.assign({}, dane, { meta: Object.assign({ teraz: Date.now() }, dane.meta) });
    if (format === 'md' || format === 'markdown') return doMarkdown(pelne);
    if (format === 'csv') return doCsv(pelne);
    return doJson(pelne);
  }

  return { zbuduj, naglowek, rzetelnosc, nazwaPliku, stempel, czasLokalny, czasZMs, redagujTekst, redagujGleboko, kontekstRedakcji, KLUCZE_WRAZLIWE, KOLUMNY, MASKA };
})();
