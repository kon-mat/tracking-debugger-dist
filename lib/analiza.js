// lib/analiza.js — rozpoznawanie żądań pomiarowych i rozbicie parametrów na pola.
// Ładowane przez service worker (importScripts), panel i stronę opcji (<script>).
//
// W tym pliku NIE MA żadnej domeny konkretnego projektu. Wbudowana lista obejmuje wyłącznie
// platformy globalne (Google, Meta, Microsoft, TikTok...). Domena własnego kontenera serwerowego,
// własne narzędzia i nazwy pikseli przychodzą z konfiguracji (lib/konfiguracja.js).
//
// Zasada „nic nie ginie po cichu": każde żądanie karty trafia do jednej z czterech szuflad:
//   rozpoznane — pasuje do platformy (pełny rekord + pola semantyczne),
//   inne       — obcy host spoza listy (pełny rekord, etykieta = host),
//   własne     — dynamiczne żądanie do domeny badanej strony (pełny rekord),
//   pominięte  — zasoby statyczne (CSS, fonty, obrazy, skrypty motywu) — TYLKO licznik per host.
self.TDAnaliza = (() => {
  'use strict';

  const K = self.TDKonfiguracja;
  const domenaRejestrowalna = K.domenaRejestrowalna;
  const dopasujDowolny = K.dopasujDowolny;

  const h = (re) => (host) => re.test(host);

  // ---------------------------------------------------------------- platformy wbudowane
  const PLATFORMY_WBUDOWANE = [
    // Kontenery serwerowe rozpoznawane po domenie dostawcy. Domeny własne klienta → konfiguracja.
    { id: 'sgtm', etykieta: 'Kontener serwerowy', dopasuj: h(/\.stape\.(io|dev)$/) },
    { id: 'meta', etykieta: 'Meta', dopasuj: (host) => /(^|\.)facebook\.com$/.test(host) || /^connect\.facebook\.net$/.test(host) },
    {
      id: 'ga4',
      etykieta: 'GA4',
      dopasuj: (host, p) =>
        /(^|\.)google-analytics\.com$/.test(host) ||
        /(^|\.)analytics\.google\.com$/.test(host) ||
        (/(^|\.)googletagmanager\.com$/.test(host) && /\/collect/.test(p)) ||
        /^stats\.g\.doubleclick\.net$/.test(host),
    },
    {
      id: 'google-ads',
      etykieta: 'Google Ads',
      dopasuj: (host, p) =>
        /(^|\.)googleadservices\.com$/.test(host) ||
        (/(^|\.)google\.[a-z.]+$/.test(host) && /\/(pagead|ccm|ads)\//.test(p)) ||
        (/(^|\.)googleads\.g\.doubleclick\.net$/.test(host) && /pagead|ccm/.test(p)) ||
        /^(td|ad)\.doubleclick\.net$/.test(host) ||
        /^adservice\.google\.[a-z.]+$/.test(host) ||
        (/(^|\.)googlesyndication\.com$/.test(host) && /pagead/.test(p)),
    },
    {
      id: 'google-tag',
      etykieta: 'Google tag (loader)',
      dopasuj: (host, p) => /(^|\.)googletagmanager\.com$/.test(host) && /^\/(gtm\.js|gtag\/js|gtag\/destination|ns\.html|debug)/.test(p),
    },
    { id: 'microsoft', etykieta: 'Microsoft UET', dopasuj: h(/^bat\.bing\.(com|net)$/) },
    { id: 'clarity', etykieta: 'Clarity', dopasuj: h(/(^|\.)clarity\.ms$/) },
    { id: 'tiktok', etykieta: 'TikTok', dopasuj: h(/(^|\.)analytics(-ipv6)?\.tiktok(w)?\.(com|us)$/) },
    { id: 'merchant-center', etykieta: 'Merchant Center', dopasuj: h(/(^|\.)merchant-center-analytics\.goog$/) },
    { id: 'linkedin', etykieta: 'LinkedIn', dopasuj: h(/(^|\.)(px\.ads\.linkedin\.com|snap\.licdn\.com)$/) },
    { id: 'pinterest', etykieta: 'Pinterest', dopasuj: h(/(^|\.)(ct\.pinterest\.com|s\.pinimg\.com)$/) },
    { id: 'snap', etykieta: 'Snap', dopasuj: h(/(^|\.)(tr\.snapchat\.com|sc-static\.net)$/) },
    { id: 'reddit', etykieta: 'Reddit', dopasuj: h(/(^|\.)(alb\.reddit\.com|redditstatic\.com)$/) },
    { id: 'x-ads', etykieta: 'X (Twitter)', dopasuj: h(/(^|\.)(analytics\.twitter\.com|static\.ads-twitter\.com|t\.co)$/) },
    { id: 'criteo', etykieta: 'Criteo', dopasuj: h(/(^|\.)criteo\.(com|net)$/) },
    { id: 'awin', etykieta: 'Awin', dopasuj: h(/(^|\.)(dwin1\.com|awin1\.com|zenaps\.com)$/) },
    { id: 'klaviyo', etykieta: 'Klaviyo', dopasuj: h(/(^|\.)klaviyo\.com$/) },
    { id: 'hotjar', etykieta: 'Hotjar', dopasuj: h(/(^|\.)hotjar\.(com|io)$/) },
    { id: 'cmp', etykieta: 'CMP (zgoda)', dopasuj: h(/(^|\.)(cookiebot\.com|cookielaw\.org|onetrust\.com|usercentrics\.eu|iubenda\.com|cookieyes\.com|termly\.io)$/) },
    // Shopify — platformowe, nie projektowe.
    { id: 'shopify-monorail', etykieta: 'Shopify Monorail', dopasuj: (host, p) => /^monorail-edge\.shopifysvc\.com$/.test(host) || /\/\.well-known\/shopify\/monorail/.test(p) },
    { id: 'shopify-internal', etykieta: 'Shopify (telemetria)', dopasuj: h(/(^|\.)(otlp-http-production|error-analytics-sessions-production|error-analytics-production)\.shopifysvc\.com$/) },
    { id: 'shop-app', etykieta: 'Shop (Shopify)', dopasuj: h(/(^|\.)shop\.app$/) },
    { id: 'judgeme', etykieta: 'Judge.me', dopasuj: h(/(^|\.)judge\.me$/) },
    { id: 'pushowl', etykieta: 'PushOwl / Brevo', dopasuj: h(/(^|\.)(pushowl\.com|getpushowl\.com|sibautomation\.com|brevo\.com|sendinblue\.com)$/) },
  ];

  // Szuflady spoza listy platform — też dostają chip w panelu.
  const KUBLY_DODATKOWE = [
    { id: 'inne', etykieta: 'Inne (nierozpoznane)' },
    { id: 'wlasne', etykieta: 'Domena strony (XHR/fetch)' },
  ];

  // Platformy pokazywane w filtrach zawsze, nawet przy zerze — brak ruchu do nich bywa ustaleniem.
  const PLATFORMY_KLUCZOWE = ['sgtm', 'meta', 'ga4', 'google-ads', 'google-tag', 'microsoft', 'clarity', 'tiktok'];

  const FORMATY = ['generic', 'ga4', 'meta', 'ads', 'uet', 'tiktok', 'stape-data', 'loader'];

  // ---------------------------------------------------------------- zasoby statyczne
  const HOSTY_STATYCZNE = [
    /(^|\.)cdn\.shopify\.com$/,
    /\.shopifycdn\.com$/,
    /^fonts\.(googleapis\.com|gstatic\.com)$/,
    /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|ajax\.googleapis\.com)$/,
    /^(www\.)?gstatic\.com$/,
  ];
  const TYPY_DYNAMICZNE = new Set(['xmlhttprequest', 'ping', 'other', 'websocket', 'webbundle']);
  const ROZSZERZENIA_STATYCZNE = /\.(js|mjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|pdf)(\?|$)/i;

  // ---------------------------------------------------------------- kontener serwerowy: rozpoznanie po ścieżce
  // Dwa progi celowo się różnią:
  //   scisle = true  → wystarczy pewny, żeby SAMEMU zaklasyfikować żądanie jako kontener serwerowy
  //                    (tylko na domenie badanej strony — patrz klasyfikuj()),
  //   scisle = false → wystarczy podejrzany, żeby ZAPROPONOWAĆ host w konfiguracji.
  // Dzięki temu ścieżka w rodzaju /api/collect nie dostaje na wyrost etykiety kontenera,
  // ale użytkownik i tak dowiaduje się, że taki host istnieje.
  function kandydatNaKontenerSerwerowy(u, metoda, scisle) {
    const p = u.pathname;
    const post = String(metoda || '').toUpperCase() === 'POST';
    if (/^\/(gtm\.js|gtag\/js|gtag\/destination)$/.test(p)) return true;
    const q = u.searchParams;
    const maParametryPomiaru = q.has('tid') || q.has('v') || q.has('en') || q.has('cid') || q.has('measurement_id');
    if (/(^|\/)(g|j|mp)\/collect$/.test(p) || /^\/collect$/.test(p)) {
      return maParametryPomiaru || (!scisle && post);
    }
    // klient danych Stape — wyłącznie POST, żeby nie łapać przypadkowego /data
    if (/^\/data$/.test(p) && post) return true;
    if (!scisle) {
      // Luźniej, tylko na potrzeby podpowiedzi: dowolna ścieżka kończąca się na /collect
      // albo typowe końcówki kolektorów, o ile to POST lub są parametry pomiaru.
      if (/\/collect$/.test(p) && (post || maParametryPomiaru)) return true;
      if (/\/(gtag|gtm|sgtm|server[-_]?gtm)\//.test(p) && (post || maParametryPomiaru)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- klasyfikator
  function utworz(ustawienia) {
    const u = ustawienia || {};
    const serwerowe = Array.isArray(u.serwerowe) ? u.serwerowe : [];
    const wlasnePlatformy = Array.isArray(u.platformy) ? u.platformy : [];
    const statyczne = Array.isArray(u.statyczneHosty) ? u.statyczneHosty : [];
    const autoSgtm = u.autoWykrywanieSgtm !== false;
    const zbierajWlasne = u.zbierajWlasneDomeny !== false;

    function klasyfikuj(url, hostKarty, metoda) {
      let a;
      try {
        a = new URL(url);
      } catch (e) {
        return null;
      }
      const host = a.hostname.toLowerCase();
      const sciezka = a.pathname;

      // 1. własne narzędzia z konfiguracji — mają pierwszeństwo, żeby dało się nadpisać wbudowane
      for (const p of wlasnePlatformy) {
        if (dopasujDowolny(p.hosty, host)) {
          return { platform: p.id, etykieta: p.etykieta, format: p.format || wykryjFormat(p.id, a), wlasna: true };
        }
      }
      // 2. kontener serwerowy z konfiguracji
      if (dopasujDowolny(serwerowe, host)) {
        return { platform: 'sgtm', etykieta: 'Kontener serwerowy', format: wykryjFormat('sgtm', a) };
      }
      // 3. platformy wbudowane
      for (const p of PLATFORMY_WBUDOWANE) {
        if (p.dopasuj(host, sciezka)) {
          return { platform: p.id, etykieta: p.etykieta, format: wykryjFormat(p.id, a) };
        }
      }
      // 4. automatyczne rozpoznanie kontenera serwerowego na domenie badanej strony (próg ścisły)
      if (autoSgtm && hostKarty && kandydatNaKontenerSerwerowy(a, metoda, true) && domenaRejestrowalna(host) === domenaRejestrowalna(hostKarty)) {
        return { platform: 'sgtm', etykieta: 'Kontener serwerowy (wykryty)', format: wykryjFormat('sgtm', a), auto: true, host };
      }
      return null;
    }

    // Czy host wygląda na kontener serwerowy, choć nie ma go w konfiguracji?
    // Third-party też — taki host trafia do „Inne", a strona opcji proponuje go dodać.
    function kandydat(url, metoda, hostKarty) {
      let a;
      try {
        a = new URL(url);
      } catch (e) {
        return null;
      }
      if (!kandydatNaKontenerSerwerowy(a, metoda, false)) return null;
      const host = a.hostname.toLowerCase();
      if (dopasujDowolny(serwerowe, host)) return null;
      for (const p of wlasnePlatformy) if (dopasujDowolny(p.hosty, host)) return null;
      for (const p of PLATFORMY_WBUDOWANE) if (p.dopasuj(host, a.pathname)) return null;
      return {
        host,
        sciezka: a.pathname,
        pierwszaStrona: !!(hostKarty && domenaRejestrowalna(host) === domenaRejestrowalna(hostKarty)),
      };
    }

    function klasyfikujInne(url, typ, hostKarty) {
      let a;
      try {
        a = new URL(url);
      } catch (e) {
        return { kubel: 'skip', host: '?' };
      }
      const host = a.hostname.toLowerCase();
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return { kubel: 'skip', host };
      if (HOSTY_STATYCZNE.some((r) => r.test(host))) return { kubel: 'skip', host };
      if (dopasujDowolny(statyczne, host)) return { kubel: 'skip', host };
      const pierwszaStrona = hostKarty && domenaRejestrowalna(host) === domenaRejestrowalna(hostKarty);
      if (pierwszaStrona) {
        if (!zbierajWlasne) return { kubel: 'skip', host };
        // XHR / fetch / beacon do domeny strony = zawsze rekord (także /cart.js — API z .js w nazwie)
        if (typ === 'xmlhttprequest' || typ === 'ping' || typ === 'websocket') return { kubel: 'wlasne', host };
        // typ „other" (prefetch, reguły spekulacji, service worker): /cdn/ i rozszerzenia statyczne = zasób
        if (TYPY_DYNAMICZNE.has(typ) && !/^\/cdn\//.test(a.pathname) && !ROZSZERZENIA_STATYCZNE.test(a.pathname)) {
          return { kubel: 'wlasne', host };
        }
        return { kubel: 'skip', host };
      }
      if (typ === 'stylesheet' || typ === 'font' || typ === 'media') return { kubel: 'skip', host };
      return { kubel: 'inne', host };
    }

    function listaPlatform(licznikiPlatform) {
      const l = licznikiPlatform || {};
      const wynik = [];
      const dodane = new Set();
      for (const p of wlasnePlatformy) {
        wynik.push({ id: p.id, etykieta: p.etykieta });
        dodane.add(p.id);
      }
      for (const p of PLATFORMY_WBUDOWANE) {
        if (dodane.has(p.id)) continue;
        if (PLATFORMY_KLUCZOWE.includes(p.id) || l[p.id]) {
          wynik.push({ id: p.id, etykieta: p.etykieta });
          dodane.add(p.id);
        }
      }
      for (const p of KUBLY_DODATKOWE) if (!dodane.has(p.id)) wynik.push(p);
      return wynik;
    }

    return { klasyfikuj, klasyfikujInne, kandydat, listaPlatform, zbudujRekordy, ustawienia: u };
  }

  function wykryjFormat(platform, u) {
    const sciezka = u.pathname;
    const host = u.hostname.toLowerCase();
    if (platform === 'meta') {
      if (host === 'connect.facebook.net') return 'loader';
      return /^\/tr\/?/.test(sciezka) ? 'meta' : 'meta-other';
    }
    if (platform === 'microsoft') return /\.js$/.test(sciezka) ? 'loader' : 'uet';
    if (platform === 'tiktok') return /\.js$/.test(sciezka) ? 'loader' : 'tiktok';
    if (platform === 'clarity') return 'clarity';
    if (platform === 'google-tag') return 'loader';
    if (platform === 'google-ads') return /\.js$/.test(sciezka) ? 'loader' : 'ads';
    if (/\/g\/collect/.test(sciezka) || /\/(j\/)?collect$/.test(sciezka) || /\/measurement\/conversion/.test(sciezka)) return 'ga4';
    if (platform === 'sgtm') {
      if (/\/data\b/.test(sciezka)) return 'stape-data';
      if (/\.js$/.test(sciezka) || /\/gtm\.js|\/gtag\/js/.test(sciezka)) return 'loader';
      return 'generic';
    }
    if (/\.js$/.test(sciezka)) return 'loader';
    return 'generic';
  }

  // ---------------------------------------------------------------- parsowanie parametrów
  function parsujUrlEncoded(tekst) {
    const out = {};
    let sp;
    try {
      sp = new URLSearchParams(tekst);
    } catch (e) {
      return out;
    }
    for (const [k, v] of sp) {
      if (k in out) {
        if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      } else out[k] = v;
    }
    return out;
  }

  function splaszcz(obj, prefiks, out, glebokosc) {
    out = out || {};
    glebokosc = glebokosc || 0;
    if (glebokosc > 6) return out;
    if (obj === null || typeof obj !== 'object') {
      out[prefiks || '(wartość)'] = obj;
      return out;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) out[prefiks] = '[]';
      obj.slice(0, 50).forEach((v, i) => splaszcz(v, prefiks ? prefiks + '[' + i + ']' : '[' + i + ']', out, glebokosc + 1));
      return out;
    }
    const klucze = Object.keys(obj);
    if (klucze.length === 0) out[prefiks] = '{}';
    for (const k of klucze.slice(0, 200)) splaszcz(obj[k], prefiks ? prefiks + '.' + k : k, out, glebokosc + 1);
    return out;
  }

  const MAKS_BODY = 16000;
  function odczytajBody(requestBody) {
    if (!requestBody) return { rodzaj: null, tekst: null, parametry: {}, linie: null };
    if (requestBody.formData) {
      const parametry = {};
      for (const k of Object.keys(requestBody.formData)) {
        const v = requestBody.formData[k];
        parametry[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
      }
      return { rodzaj: 'form', tekst: null, parametry, linie: null };
    }
    if (requestBody.raw && requestBody.raw.length) {
      let tekst = '';
      try {
        const dek = new TextDecoder('utf-8', { fatal: false });
        for (const czesc of requestBody.raw) {
          if (czesc.bytes) tekst += dek.decode(czesc.bytes);
          else if (czesc.file) tekst += '[plik: ' + czesc.file + ']';
        }
      } catch (e) {
        return { rodzaj: 'binary', tekst: null, parametry: {}, linie: null };
      }
      let zle = 0;
      for (let i = 0; i < Math.min(tekst.length, 400); i++) {
        const c = tekst.charCodeAt(i);
        if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) zle++;
      }
      if (zle > 8) return { rodzaj: 'binary', tekst: null, parametry: {}, linie: null, rozmiar: tekst.length };
      const przyciety = tekst.trim();
      if (przyciety.startsWith('{') || przyciety.startsWith('[')) {
        try {
          const json = JSON.parse(przyciety);
          return { rodzaj: 'json', tekst: tekst.slice(0, MAKS_BODY), parametry: splaszcz(json, ''), json, linie: null };
        } catch (e) {
          /* spadamy do tekstu */
        }
      }
      if (/^[A-Za-z0-9_.\[\]%-]+=/.test(przyciety)) {
        const linie = przyciety.split('\n').map((l) => l.trim()).filter(Boolean);
        if (linie.length > 1 && linie.every((l) => /^[A-Za-z0-9_.\[\]%-]+=/.test(l))) {
          return { rodzaj: 'urlencoded-batch', tekst: tekst.slice(0, MAKS_BODY), parametry: {}, linie: linie.map(parsujUrlEncoded) };
        }
        return { rodzaj: 'urlencoded', tekst: tekst.slice(0, MAKS_BODY), parametry: parsujUrlEncoded(przyciety), linie: null };
      }
      return { rodzaj: 'text', tekst: tekst.slice(0, MAKS_BODY), parametry: {}, linie: null };
    }
    return { rodzaj: null, tekst: null, parametry: {}, linie: null };
  }

  // ---------------------------------------------------------------- pola semantyczne
  const MAPA_POL = {
    ga4: [
      ['event_name', ['en']],
      ['event_id', ['ep.event_id', 'ep.eventID', 'ep.eventId', 'ep.event_identifier', 'ep.fb_event_id']],
      ['transaction_id', ['ep.transaction_id']],
      ['value', ['epn.value', 'ep.value']],
      ['currency', ['cu', 'ep.currency']],
      ['gcs', ['gcs']],
      ['gcd', ['gcd']],
      ['dma', ['dma']],
      ['npa', ['npa']],
      ['client_id', ['cid']],
      ['session_id', ['sid']],
      ['user_id', ['uid']],
      ['tid', ['tid']],
      ['gtm', ['gtm']],
      ['gclid', ['gclid', 'ep.gclid']],
      ['fbclid', ['ep.fbclid']],
      ['_fbp', ['ep.fbp', 'ep._fbp']],
      ['_fbc', ['ep.fbc', 'ep._fbc']],
      ['page_location', ['dl']],
      ['items', ['pr1']],
    ],
    meta: [
      ['pixel_id', ['id']],
      ['event_name', ['ev']],
      ['event_id', ['eid']],
      ['value', ['cd[value]']],
      ['currency', ['cd[currency]']],
      ['content_ids', ['cd[content_ids]']],
      ['content_type', ['cd[content_type]']],
      ['content_name', ['cd[content_name]']],
      ['num_items', ['cd[num_items]']],
      ['order_id', ['cd[order_id]']],
      ['_fbp', ['fbp']],
      ['_fbc', ['fbc']],
      ['page_location', ['dl']],
      ['referrer', ['rl']],
      ['ud_em', ['ud[em]']],
      ['ud_ph', ['ud[ph]']],
      ['ud_external_id', ['ud[external_id]']],
      ['coo', ['coo']],
    ],
    'meta-other': [
      ['pixel_id', ['id']],
      ['event_name', ['ev']],
    ],
    ads: [
      ['event_name', ['en']],
      ['label', ['label']],
      ['value', ['value']],
      ['currency', ['currency_code']],
      ['transaction_id', ['oid']],
      ['gcs', ['gcs']],
      ['gcd', ['gcd']],
      ['dma', ['dma']],
      ['gclid', ['gclid', 'gclaw', 'gclgb']],
      ['gtm', ['gtm']],
      ['page_location', ['url']],
    ],
    uet: [
      ['uet_tag_id', ['ti']],
      ['event_type', ['evt']],
      ['action', ['ea']],
      ['category', ['ec']],
      ['label', ['el']],
      ['event_value', ['ev']],
      ['goal_value', ['gv']],
      ['currency', ['gc']],
      ['product_ids', ['pid']],
      ['asc (zgoda)', ['asc']],
      ['page_location', ['p']],
      ['referrer', ['r']],
      ['title', ['tl']],
      ['mid', ['mid']],
      ['sid', ['sid']],
      ['vid', ['vid']],
    ],
    tiktok: [
      ['event_name', ['event']],
      ['event_id', ['event_id', 'message_id']],
      ['pixel_code', ['context.pixel_code']],
      ['value', ['properties.value']],
      ['currency', ['properties.currency']],
      ['page_location', ['context.page.url']],
    ],
    'stape-data': [
      ['event_name', ['event_name', 'event', 'en']],
      ['event_id', ['event_id', 'eventID', 'eventId']],
      ['transaction_id', ['transaction_id', 'order_id']],
      ['value', ['value']],
      ['currency', ['currency']],
      ['client_id', ['client_id', 'cid']],
      ['session_id', ['session_id', 'sid']],
      ['gcs', ['gcs']],
      ['_fbp', ['fbp', '_fbp']],
      ['_fbc', ['fbc', '_fbc']],
      ['gclid', ['gclid']],
      ['page_location', ['page_location', 'dl']],
    ],
    generic: [
      ['event_name', ['event_name', 'event', 'en', 'ev', 'evt', 'e', 'type', 'action', 'events[0].event', 'events[0].name', 'event_type']],
      ['event_id', ['event_id', 'eventID', 'eid', 'ep.event_id', 'events[0].event_id', 'events[0].id']],
      ['transaction_id', ['transaction_id', 'ti', 'oid', 'ep.transaction_id', 'order_id', 'order_ref']],
      ['value', ['value', 'epn.value', 'amount', 'total', 'revenue']],
      ['currency', ['currency', 'cu', 'currency_code']],
      ['gcs', ['gcs']],
      ['gcd', ['gcd']],
      ['client_id', ['cid', 'client_id']],
      ['session_id', ['sid', 'session_id']],
      ['tid', ['tid']],
      ['gclid', ['gclid']],
      ['fbclid', ['fbclid']],
      ['_fbp', ['fbp', '_fbp']],
      ['_fbc', ['fbc', '_fbc']],
    ],
    loader: [
      ['container_id', ['id']],
      ['gtm', ['gtm']],
      ['l', ['l']],
    ],
    clarity: [],
  };

  const META_WYMAGA_EVENT_ID = ['Purchase', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'AddPaymentInfo'];
  const GA4_WYMAGA_EVENT_ID = ['purchase', 'add_to_cart', 'begin_checkout', 'view_item', 'add_payment_info'];

  function wybierz(parametry, nazwy) {
    for (const n of nazwy) {
      if (n in parametry && parametry[n] !== '' && parametry[n] !== undefined && parametry[n] !== null) {
        return { klucz: n, wartosc: parametry[n] };
      }
    }
    return null;
  }

  function wyciagnijPola(platform, format, parametry, url) {
    const mapa = MAPA_POL[format] || MAPA_POL.generic;
    const pola = [];
    const sem = {};
    for (const [nazwa, kandydaci] of mapa) {
      const trafienie = wybierz(parametry, kandydaci);
      if (trafienie) {
        pola.push({ nazwa, klucz: trafienie.klucz, wartosc: trafienie.wartosc });
        sem[nazwa] = trafienie.wartosc;
      }
    }
    if (format === 'ads') {
      const m = /\/(?:pagead|ccm)\/(?:1p-)?(?:conversion|viewthroughconversion)\/(\d+)/.exec(url);
      if (m) {
        pola.unshift({ nazwa: 'conversion_id', klucz: '(ścieżka)', wartosc: m[1] });
        sem.conversion_id = m[1];
      }
    }
    if (format === 'clarity') {
      const mu = /clarity\.ms\/tag\/uet\/(\d+)/.exec(url);
      const mp = /clarity\.ms\/tag\/([A-Za-z0-9]+)/.exec(url);
      if (mu) pola.push({ nazwa: 'uet_tag_id (most UET→Clarity)', klucz: '(ścieżka)', wartosc: mu[1] });
      else if (mp) pola.push({ nazwa: 'project_id', klucz: '(ścieżka)', wartosc: mp[1] });
    }
    const flagi = [];
    const en = sem.event_name;
    if (format === 'meta' && en && META_WYMAGA_EVENT_ID.includes(String(en)) && !sem.event_id) {
      flagi.push({ poziom: 'error', kod: 'brak_event_id', tekst: 'BRAK event_id (eid) — dedup z CAPI niemożliwy' });
    }
    if (platform === 'sgtm' && (format === 'ga4' || format === 'stape-data') && en && GA4_WYMAGA_EVENT_ID.includes(String(en)) && !sem.event_id) {
      flagi.push({ poziom: 'warn', kod: 'brak_event_id', tekst: 'brak event_id w żądaniu do kontenera serwerowego — CAPI z tego hita nie zdeduplikuje' });
    }
    if ((format === 'ga4' || format === 'stape-data') && en === 'purchase' && !sem.transaction_id) {
      flagi.push({ poziom: 'warn', kod: 'brak_transaction_id', tekst: 'purchase bez transaction_id' });
    }
    return { pola, sem, flagi };
  }

  // ---------------------------------------------------------------- rekord żądania
  function zbudujRekordy(szczegoly, cls) {
    let a;
    try {
      a = new URL(szczegoly.url);
    } catch (e) {
      return [];
    }
    const zapytanie = parsujUrlEncoded(a.search.startsWith('?') ? a.search.slice(1) : a.search);
    const body = odczytajBody(szczegoly.requestBody);
    const baza = {
      rodzaj: 'zadanie',
      requestId: szczegoly.requestId,
      t: Math.round(szczegoly.timeStamp || Date.now()),
      tabId: szczegoly.tabId,
      frameId: szczegoly.frameId,
      platform: cls.platform,
      etykietaPlatformy: cls.etykieta,
      format: cls.format,
      auto: !!cls.auto,
      metoda: szczegoly.method,
      typ: szczegoly.type,
      url: szczegoly.url,
      host: a.hostname,
      sciezka: a.pathname,
      inicjator: szczegoly.initiator || null,
      rodzajBody: body.rodzaj,
      tekstBody: body.tekst,
      status: null,
      blad: null,
    };
    const hity = [];
    if (body.rodzaj === 'urlencoded-batch' && body.linie && body.linie.length) {
      body.linie.forEach((parametryLinii, i) => {
        hity.push({ parametry: Object.assign({}, zapytanie, parametryLinii), nr: i + 1, ile: body.linie.length });
      });
    } else {
      hity.push({ parametry: Object.assign({}, zapytanie, body.parametry || {}), nr: 1, ile: 1 });
    }
    return hity.map((hit) => {
      const ex = wyciagnijPola(cls.platform, cls.format, hit.parametry, szczegoly.url);
      return Object.assign({}, baza, {
        uid: 'r' + szczegoly.requestId + '-' + hit.nr,
        nr: hit.nr,
        ile: hit.ile,
        parametry: hit.parametry,
        pola: ex.pola,
        sem: ex.sem,
        flagi: ex.flagi,
        nazwaZdarzenia: ex.sem.event_name != null ? String(ex.sem.event_name) : null,
      });
    });
  }

  // ---------------------------------------------------------------- ramki
  function opiszRamke(url, frameId) {
    if (frameId === 0) return { rodzaj: 'top', etykieta: 'ramka główna', pixelId: null, href: url || null };
    const m = /web-pixels@([^/]+)\/(?:(custom|app)\/)?web-pixel-([^@/]+)@([^/]+)/.exec(url || '');
    if (m) {
      const rodzaj = m[2] === 'custom' ? 'custom-pixel' : 'app-pixel';
      return { rodzaj, etykieta: (rodzaj === 'custom-pixel' ? 'custom pixel ' : 'app pixel ') + m[3], pixelId: m[3], href: url };
    }
    if (!url || url === 'about:blank' || url.startsWith('about:')) {
      return { rodzaj: 'iframe', etykieta: 'iframe about:blank (#' + frameId + ')', pixelId: null, href: url || null };
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (e) {}
    return { rodzaj: 'iframe', etykieta: 'iframe ' + (host || '#' + frameId), pixelId: null, href: url || null };
  }

  const STANDARDOWE_ZDARZENIA = [
    'page_viewed',
    'product_viewed',
    'collection_viewed',
    'search_submitted',
    'product_added_to_cart',
    'product_removed_from_cart',
    'cart_viewed',
    'checkout_started',
    'checkout_contact_info_submitted',
    'checkout_address_info_submitted',
    'checkout_shipping_info_submitted',
    'payment_info_submitted',
    'checkout_completed',
    'alert_displayed',
  ];

  function podsumujZdarzenie(ev) {
    const d = (ev && ev.data) || {};
    const out = {};
    const kwota = (m) => (m && m.amount != null ? m.amount + (m.currencyCode ? ' ' + m.currencyCode : '') : null);
    if (d.checkout) {
      const c = d.checkout;
      if (c.order && c.order.id) out['checkout.order.id'] = c.order.id;
      if (c.token) out['checkout.token'] = c.token;
      if (c.totalPrice) out.totalPrice = kwota(c.totalPrice);
      if (c.currencyCode) out.currencyCode = c.currencyCode;
      if (Array.isArray(c.lineItems)) out.lineItems = c.lineItems.length;
      if (c.email) out.email = '(obecny)';
    }
    if (d.cart) {
      const c = d.cart;
      if (c.id) out['cart.id'] = c.id;
      if (c.cost && c.cost.totalAmount) out.totalAmount = kwota(c.cost.totalAmount);
      if (c.totalQuantity != null) out.totalQuantity = c.totalQuantity;
      if (Array.isArray(c.lines)) out.lines = c.lines.length;
    }
    if (d.cartLine) {
      const l = d.cartLine;
      if (l.merchandise && l.merchandise.product) out.product = l.merchandise.product.title;
      if (l.merchandise && l.merchandise.id) out.variantId = l.merchandise.id;
      if (l.quantity != null) out.quantity = l.quantity;
      if (l.cost && l.cost.totalAmount) out.totalAmount = kwota(l.cost.totalAmount);
    }
    if (d.productVariant) {
      const v = d.productVariant;
      if (v.product) out.product = v.product.title;
      if (v.id) out.variantId = v.id;
      if (v.sku) out.sku = v.sku;
      if (v.price) out.price = kwota(v.price);
    }
    if (d.collection) out.collection = d.collection.title || d.collection.id;
    if (d.searchResult) out.query = d.searchResult.query;
    if (d.alert) out.alert = (d.alert.type || '') + ' ' + (d.alert.message || '');
    return out;
  }

  // ---------------------------------------------------------------- etapy zakupu
  // Kolejnosc ma znaczenie: panel pokazuje je w tej kolejnosci, eksport sortuje po niej.
  const ETAPY = ['home', 'product', 'add-to-cart', 'checkout', 'payment', 'thank-you', 'post-purchase'];

  // ---------------------------------------------------------------- wiarygodnosc zapisu
  // Najwazniejsza funkcja diagnostyczna narzedzia. Odpowiada na jedno pytanie:
  // OD KTOREGO MOMENTU wolno traktowac brak zdarzenia jako dowod, ze zdarzenia nie bylo?
  //
  // Skrypt tresci wchodzi do dokumentu WYLACZNIE przy jego ladowaniu. Jesli rozszerzenie
  // zostalo wczytane albo przeladowane, gdy karta juz stala otwarta, to w tym dokumencie
  // sondy nie ma i nigdy nie bedzie — az do nastepnej pelnej nawigacji. Zadania sieciowe
  // leca dalej (webRequest jest niezalezny), wiec panel wyglada na dzialajacy, a zakladka
  // Zdarzenia jest pusta. Na dlugim dokumencie (Shopify Checkout to jeden dokument przez
  // caly proces zakupu) taka cisza potrafi trwac kwadranse i wyglada jak „nic sie nie dzialo".
  // Strony, na ktore Chrome NIE POZWALA wstrzyknac skryptu tresci — zadne odswiezenie tego nie zmieni.
  // Rozroznienie jest wazne: „nie wolno mi tu wejsc" to inny stan niz „powinienem tu byc, a mnie nie ma".
  // Mylenie ich robi z najwazniejszego ostrzezenia panelu falszywy alarm, a falszywe alarmy uczy sie ignorowac.
  const PROTOKOLY_POZA_ZASIEGIEM = /^(chrome|chrome-untrusted|chrome-extension|devtools|edge|extension|moz-extension|view-source|about|data|blob):/i;
  const HOSTY_POZA_ZASIEGIEM = /^(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

  function pozaZasiegiem(url) {
    const u = String(url || '');
    if (!u) return null;
    if (/^file:/i.test(u)) return 'plik';
    if (PROTOKOLY_POZA_ZASIEGIEM.test(u)) return 'systemowa';
    if (HOSTY_POZA_ZASIEGIEM.test(u.replace(/^https?:\/\//i, ''))) return 'sklep-chrome';
    return null;
  }

  const POWODY = {
    ok: 'Sonda zgłosiła się w tym dokumencie — strumień zdarzeń jest kompletny od chwili meldunku.',
    'poza-zasiegiem':
      'TA STRONA JEST POZA ZASIĘGIEM ROZSZERZENIA. Chrome nie pozwala wstrzykiwać skryptów treści na stronach ' +
      'systemowych (chrome://, strony rozszerzeń, Chrome Web Store) — odświeżanie karty tego nie zmieni. ' +
      'To nie jest usterka narzędzia ani stan badanej witryny. Otwórz zwykłą stronę http albo https.',
    'poza-zasiegiem-plik':
      'TA STRONA JEST POZA ZASIĘGIEM. Skrypty treści na adresach file:// działają tylko wtedy, gdy w chrome://extensions ' +
      'włączysz przy tym rozszerzeniu „Zezwalaj na dostęp do adresów URL plików". Żądania sieciowe są liczone dalej.',
    'brak-sondy-w-dokumencie':
      'BRAK SONDY W DOKUMENCIE. Rozszerzenie zostało wczytane albo przeładowane, gdy ta karta już była otwarta — ' +
      'skrypt treści wchodzi tylko przy ładowaniu dokumentu, więc w tym dokumencie go nie ma. ' +
      'Zdarzenia web pixel, consent i dataLayer NIE są przechwytywane; żądania sieciowe są kompletne. ' +
      'Odśwież kartę — od następnego załadowania dane są wiarygodne.',
    'sonda-sprzed-nawigacji':
      'Sonda zgłosiła się PRZED ostatnią nawigacją i nie zameldowała się ponownie. Bieżący dokument jest bez sondy — ' +
      'zdarzenia web pixel z tej strony NIE są przechwytywane. Odśwież kartę.',
    'odzyskane-w-locie':
      'Dokument DOŁĄCZONY W LOCIE. Rozszerzenie dostrzyknęło sondę do już otwartej strony, więc od podanej godziny ' +
      'zapis jest kompletny, ale zdarzenia TEGO dokumentu sprzed tej godziny nie zostały zapisane i nie da się ich odtworzyć. ' +
      'Żeby mieć cały dokument od zera — odśwież kartę.',
    czekamy: 'Dokument dopiero się ładuje — meldunek sondy jeszcze nie dotarł.',
  };

  // Ten sam komplet po angielsku. Material dowodowy idacy do klienta nie moze byc po polsku,
  // a to wlasnie te zdania tlumacza, czemu wolno (albo nie wolno) wierzyc liczbom.
  const POWODY_EN = {
    ok: 'The probe checked in inside this document — the event stream is complete from the check-in time.',
    'poza-zasiegiem':
      'THIS PAGE IS OUT OF REACH. Chrome does not allow content scripts on system pages (chrome://, extension pages, ' +
      'the Chrome Web Store) — reloading the tab will not change that. This is neither a tool failure nor a state of the ' +
      'site under test. Open a regular http or https page.',
    'poza-zasiegiem-plik':
      'THIS PAGE IS OUT OF REACH. Content scripts on file:// URLs only work if you enable "Allow access to file URLs" ' +
      'for this extension in chrome://extensions. Network requests are still counted.',
    'brak-sondy-w-dokumencie':
      'NO PROBE IN THIS DOCUMENT. The extension was loaded or reloaded while this tab was already open — ' +
      'a content script only enters a document while it loads, so it is not present here. ' +
      'Web pixel events, consent and dataLayer are NOT being captured; network requests are complete. ' +
      'Reload the tab — data is reliable from the next page load.',
    'sonda-sprzed-nawigacji':
      'The probe checked in BEFORE the last navigation and never checked in again. The current document has no probe — ' +
      'web pixel events from this page are NOT being captured. Reload the tab.',
    'odzyskane-w-locie':
      'DOCUMENT ATTACHED MID-FLIGHT. The extension injected its probe into an already open page, so the record is complete ' +
      'from the time shown, but events of THIS document from before that time were never captured and cannot be recovered. ' +
      'For a full document from the start — reload the tab.',
    czekamy: 'The document is still loading — the probe has not checked in yet.',
  };

  function opisPowodu(powod, jezyk) {
    const zrodlo = String(jezyk || 'pl').toLowerCase() === 'en' ? POWODY_EN : POWODY;
    return zrodlo[powod] || powod;
  }

  // `diag` — obiekt diagnostyki karty, `teraz` — znacznik czasu (wstrzykiwany, zeby dalo sie testowac).
  function ocenWiarygodnosc(diag, teraz, url) {
    const d = diag || {};
    const t = teraz || Date.now();

    // Najpierw pytanie „czy w ogole wolno mi tu byc" — inaczej kazda strona systemowa
    // wygladalaby jak nasza slepota i ostrzezenie stracilo by znaczenie.
    const poza = pozaZasiegiem(url || d.adresNawigacji);
    if (poza) {
      const powod = poza === 'plik' ? 'poza-zasiegiem-plik' : 'poza-zasiegiem';
      return { wiarygodne: false, poza: true, od: null, powod, opis: POWODY[powod], poziom: 'unknown' };
    }
    const odkryte = d.odkryteO || d.ostatniaNawigacja || null;
    const nawigacja = d.ostatniaNawigacja || null;
    const meldunek = d.meldunekTop || null;

    // Meldunek po ostatniej nawigacji (z zapasem na wyscig zdarzen webNavigation vs skrypt tresci).
    if (meldunek && (!nawigacja || meldunek >= nawigacja - 2000)) {
      const wLocie = d.odzyskaneO && (!nawigacja || nawigacja < d.odzyskaneO);
      if (wLocie) {
        return { wiarygodne: true, od: meldunek, powod: 'odzyskane-w-locie', opis: POWODY['odzyskane-w-locie'], poziom: 'warn' };
      }
      return { wiarygodne: true, poza: false, od: meldunek, powod: 'ok', opis: POWODY.ok, poziom: 'ok' };
    }
    // Jeszcze za wczesnie, zeby cokolwiek orzekac.
    const odniesienie = nawigacja || odkryte;
    if (odniesienie && t - odniesienie < 5000) {
      return { wiarygodne: false, od: null, powod: 'czekamy', opis: POWODY.czekamy, poziom: 'unknown' };
    }
    if (!odniesienie) {
      return { wiarygodne: false, od: null, powod: 'czekamy', opis: POWODY.czekamy, poziom: 'unknown' };
    }
    const powod = meldunek ? 'sonda-sprzed-nawigacji' : 'brak-sondy-w-dokumencie';
    return { wiarygodne: false, od: null, powod, opis: POWODY[powod], poziom: 'err' };
  }

  // Nowa nawigacja uniewaznia diagnostyke POPRZEDNIEGO dokumentu — ale tylko ja.
  // Kasujemy wylacznie wpisy starsze od chwili nawigacji. Bezwarunkowe zerowanie gubilo meldunek
  // NOWEGO dokumentu: uspiony service worker budzi sie dopiero pierwsza wiadomoscia sondy, a wtedy
  // kolejnosc dostarczenia zaleglego `webNavigation.onCommitted` i `runtime.onMessage` nie jest
  // gwarantowana — nawigacja potrafila dojsc PO meldunku, ktory sama miala poprzedzac.
  // Skutek byl najgorszy z mozliwych: dokument z dzialajaca sonda raportowany jako slepy.
  function przytnijDoNawigacji(diag, t, url) {
    const d = diag || {};
    d.ostatniaNawigacja = t;
    if (url !== undefined) d.adresNawigacji = url;
    for (const k of Object.keys(d.meldunki || {})) if (!(d.meldunki[k].t >= t)) delete d.meldunki[k];
    for (const k of Object.keys(d.ramki || {})) if (!(d.ramki[k].t >= t)) delete d.ramki[k];
    if (!(d.meldunekTop >= t)) d.meldunekTop = null;
    if (!(d.ostatnieZdarzenie >= t)) d.ostatnieZdarzenie = null;
    if (!d.meldunekTop) d.shopify = null;
    // Nowy dokument dostaje sonde przy ladowaniu, wiec przestaje byc „dolaczony w locie".
    d.odzyskaneO = null;
    return d;
  }

  // Pixel, ktory sie zarejestrowal, ale nie wywolal analytics.subscribe, NIE MOZE dostac zdarzenia —
  // tak dziala protokol. Zero przy takim pikselu jest faktem o pikselu, nie o naszej widocznosci.
  // Rozdzielenie tych dwoch stanow jest cala roznica miedzy „nie bylo" a „nie zobaczylem".
  function ocenPiksele(piksele) {
    const lista = Object.values(piksele || {});
    const bezSubskrypcji = lista.filter((p) => !(p.subskrypcje && p.subskrypcje.length));
    const zSubskrypcja = lista.filter((p) => p.subskrypcje && p.subskrypcje.length);
    const milczace = zSubskrypcja.filter((p) => !p.zdarzeniaOdebrane);
    return {
      razem: lista.length,
      bezSubskrypcji: bezSubskrypcji.map((p) => String(p.id)),
      zSubskrypcjaBezZdarzen: milczace.map((p) => String(p.id)),
    };
  }

  return {
    PLATFORMY_WBUDOWANE,
    KUBLY_DODATKOWE,
    PLATFORMY_KLUCZOWE,
    FORMATY,
    STANDARDOWE_ZDARZENIA,
    ETAPY,
    POWODY,
    POWODY_EN,
    opisPowodu,
    ocenWiarygodnosc,
    ocenPiksele,
    pozaZasiegiem,
    przytnijDoNawigacji,
    utworz,
    zbudujRekordy,
    opiszRamke,
    podsumujZdarzenie,
    parsujUrlEncoded,
    splaszcz,
    domenaRejestrowalna,
    kandydatNaKontenerSerwerowy,
  };
})();
