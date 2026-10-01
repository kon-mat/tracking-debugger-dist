// content/sonda.js — świat strony (MAIN), WSZYSTKIE ramki (także sandboksy web pixeli Shopify).
// Wyłącznie obserwuje: owija kanały komunikacyjne, niczego nie zmienia w danych strony,
// niczego nie wysyła poza przeglądarkę.
//
// Dlaczego świat strony, a nie sam chrome.webRequest:
//  - na Shopify zdarzenia pomiarowe nie żyją w głównym dokumencie. Manager web pixeli rozmawia
//    z sandboksami protokołem @remote-ui/rpc przez postMessage:
//      [0, [id, "initialize", [{ webPixelConfig, webPixelApi, init }]]]  — rejestracja pixela
//      [5, [id, fnId, [ obiektZdarzenia ]]]                              — dostarczenie zdarzenia
//      [5, [id, fnId, [ "nazwa_zdarzenia", {"_@f": cb} ]]]               — analytics.subscribe z pixela
//  - app pixele (STRICT) to Web Workery tworzone W RAMCE GŁÓWNEJ  → hook new Worker + postMessage
//  - custom pixele (LAX) to sandboksowane iframe'y                → listener 'message' w iframie
//  - sam webRequest pokazałby żądania, ale nigdy wywołań analytics.subscribe ani treści zdarzenia.
//
// Samokontrola (żeby „nie zobaczyłem" nie udawało „nie było"):
//  - rekord `hello` z każdej ramki zaraz po instalacji hooków,
//  - rekord `stats` z licznikami: ile wiadomości RPC rozpoznano, ile NIE (rosnące = zmiana protokołu),
//    ile sandboksowych iframe'ów widzi ramka główna, ile workerów utworzono, czy to w ogóle Shopify.
(() => {
  'use strict';
  if (window.__tdSonda) return;
  try {
    Object.defineProperty(window, '__tdSonda', { value: true, configurable: false, enumerable: false });
  } catch (e) {
    window.__tdSonda = true;
  }

  let jestemNaGorze = false;
  try {
    jestemNaGorze = window.top === window;
  } catch (e) {
    jestemNaGorze = false;
  }
  const ramka = opiszRamke(String(location.href), jestemNaGorze);

  // ------------------------------------------------------------------ narzędzia
  function parsujAdresPixela(href) {
    const m = /web-pixels@([^/]+)\/(?:(custom|app)\/)?web-pixel-([^@/]+)@([^/]+)/.exec(href || '');
    if (!m) return null;
    return { wersjaHash: m[1], podpowiedz: m[2] || null, pixelId: m[3], wersja: m[4], worker: /worker\.modern\.js/.test(href) };
  }

  function opiszRamke(href, gora) {
    if (gora) return { rodzaj: 'top', etykieta: 'ramka główna', pixelId: null, href };
    const p = parsujAdresPixela(href);
    if (p) {
      const rodzaj = p.podpowiedz === 'custom' ? 'custom-pixel' : 'app-pixel';
      return { rodzaj, etykieta: (rodzaj === 'custom-pixel' ? 'custom pixel ' : 'app pixel ') + p.pixelId, pixelId: p.pixelId, href };
    }
    let host = '';
    try {
      host = location.hostname;
    } catch (e) {}
    return { rodzaj: 'iframe', etykieta: 'iframe ' + (host || href.slice(0, 60)), pixelId: null, href };
  }

  function parsujNazweSandboksa(nazwa) {
    // web-pixel-sandbox-CUSTOM-123456-LAX-<hash>
    const m = /^web-pixel-sandbox-(APP|CUSTOM)-(.+)-(LAX|STRICT)-([^-]+)$/.exec(nazwa || '');
    if (!m) return null;
    return { typ: m[1], pixelId: m[2], srodowisko: m[3], wersjaHash: m[4] };
  }

  const MAKS_JSON = 60000;
  function czysty(wartosc, limit) {
    let s;
    try {
      const widziane = new WeakSet();
      s = JSON.stringify(wartosc, (k, v) => {
        if (typeof v === 'function' || typeof v === 'symbol') return undefined;
        if (v && typeof v === 'object') {
          if (widziane.has(v)) return '[cykl]';
          widziane.add(v);
        }
        return v;
      });
    } catch (e) {
      return { __blad: 'nieserializowalne: ' + String(e && e.message) };
    }
    if (s === undefined) return null;
    const lim = limit || MAKS_JSON;
    if (s.length > lim) return { __przyciete: true, rozmiar: s.length, poczatek: s.slice(0, lim) };
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ dostawa do mostka
  const kolejka = [];
  let mostGotowy = false;
  let juzMeldowano = false;

  function dostarcz(rekord) {
    try {
      document.dispatchEvent(new CustomEvent('__td_przechwyt', { detail: JSON.stringify(rekord) }));
    } catch (e) {}
  }

  function wyslij(rekord) {
    rekord.t = Date.now();
    if (!rekord.ramka) rekord.ramka = ramka;
    if (jestemNaGorze) {
      if (mostGotowy) dostarcz(rekord);
      else if (kolejka.length < 500) kolejka.push(rekord);
    } else {
      try {
        window.top.postMessage({ __td_przekaz: rekord }, '*');
      } catch (e) {}
    }
  }

  // Ponowny meldunek. Most moze wejsc drugi raz — po przeladowaniu rozszerzenia stary uchwyt jest
  // martwy i service worker nie wie nic o tym dokumencie. Bez powtorzonego `hello` Diagnostyka
  // uznalaby dokument za slepy, choc od tej chwili jest obserwowany.
  function zamelduj() {
    wyslij({ rodzaj: 'hello', naGorze: jestemNaGorze, shopify: wykryjShopify(), stanDokumentu: document.readyState, ponowny: juzMeldowano });
    juzMeldowano = true;
    statsBrudne = true;
    wyslijStats();
  }

  if (jestemNaGorze) {
    document.addEventListener('__td_most_gotowy', () => {
      const ponownie = mostGotowy;
      mostGotowy = true;
      while (kolejka.length) dostarcz(kolejka.shift());
      if (ponownie) {
        // Most zgłosił się DRUGI raz — to znaczy, że rozszerzenie zostało przeładowane,
        // a poprzedni mostek umarł. Meldujemy się od nowa, bo worker nie wie o tym dokumencie nic.
        zamelduj();
        // Ramki podrzedne tez juz sie zameldowaly (i te meldunki przepadly) — prosimy o powtorke.
        try {
          for (const f of document.querySelectorAll('iframe')) {
            try {
              f.contentWindow.postMessage({ __td_ponow: 1 }, '*');
            } catch (e) {}
          }
        } catch (e) {}
      }
    });
    try {
      document.dispatchEvent(new CustomEvent('__td_sonda_gotowa'));
    } catch (e) {}
  } else {
    // Prosba z ramki glownej o powtorzenie meldunku (most wrocil do zycia).
    window.addEventListener(
      'message',
      (ev) => {
        try {
          if (ev.data && ev.data.__td_ponow) zamelduj();
        } catch (e) {}
      },
      true
    );
  }

  // ------------------------------------------------------------------ czy to Shopify
  function wykryjShopify() {
    try {
      if (window.Shopify || window.webPixelsManager) return true;
      if (document.querySelector && document.querySelector('iframe[name^="web-pixel-sandbox-"]')) return true;
      if (document.querySelector && document.querySelector('script[src*="/cdn/wpm/"], script[src*="web-pixels-manager"]')) return true;
    } catch (e) {}
    return false;
  }

  // ------------------------------------------------------------------ liczniki samokontroli
  const stats = {
    shopify: false,
    rpcInit: 0, // rozpoznane „initialize"
    rpcZdarzenie: 0, // zdarzenia dostarczone do sandboksa
    rpcSubskrypcja: 0, // analytics.subscribe z sandboksa
    rpcApiZnane: 0, // inne znane wywołania API sandboksa
    rpcZgoda: 0, // callback customerPrivacy do sandboksa
    rpcNieznaneDo: 0, // wiadomość do sandboksa, której nie umiem odczytać  ← rośnie = zmiana protokołu
    rpcNieznaneOd: 0, // wiadomość z sandboksa z fnId spoza mapy API        ← rośnie = zmiana protokołu
    rpcWyniki: 0, // odpowiedzi (typ 1/6), liczone dla kompletności
    wiadomosciSpozaRpc: 0,
    workeryUtworzone: 0,
    workeryPixeli: 0,
    iframeSandboksow: 0, // tylko ramka główna
    publishWywolania: 0,
    dlPushe: 0,
  };
  let timerStats = null;
  let statsBrudne = false;
  function licz(nazwa, n) {
    stats[nazwa] = (stats[nazwa] || 0) + (n == null ? 1 : n);
    statsBrudne = true;
    if (!timerStats) timerStats = setTimeout(wyslijStats, 1500);
  }
  function wyslijStats() {
    timerStats = null;
    if (!statsBrudne) return;
    statsBrudne = false;
    stats.shopify = wykryjShopify();
    if (jestemNaGorze) {
      try {
        stats.iframeSandboksow = document.querySelectorAll('iframe[name^="web-pixel-sandbox-"]').length;
      } catch (e) {}
    }
    wyslij({ rodzaj: 'stats', stats: Object.assign({}, stats) });
  }

  // ------------------------------------------------------------------ protokół remote-ui
  function parsujRpc(dane) {
    if (!Array.isArray(dane) || dane.length !== 2 || !Array.isArray(dane[1])) return null;
    const typ = dane[0];
    const p = dane[1];
    if (typ === 0) return { rodzaj: 'wywolanie', id: p[0], metoda: p[1], argumenty: p[2] };
    if (typ === 5) return { rodzaj: 'zastosuj', id: p[0], fn: p[1], argumenty: p[2] };
    if (typ === 1 || typ === 6) return { rodzaj: 'wynik', id: p[0] };
    if (typeof typ === 'number') return { rodzaj: 'inne', typ };
    return null;
  }

  function toZdarzenieShopify(o) {
    return !!(o && typeof o === 'object' && typeof o.name === 'string' && typeof o.id === 'string' && typeof o.timestamp === 'string');
  }

  function skrocZdarzenie(ev) {
    const ctx = (ev.context && ev.context.document) || {};
    const nav = (ev.context && ev.context.navigator) || {};
    return czysty({
      id: ev.id,
      name: ev.name,
      type: ev.type,
      timestamp: ev.timestamp,
      clientId: ev.clientId,
      seq: ev.seq,
      data: ev.data,
      customData: ev.customData,
      context: {
        document: { location: { href: ctx.location && ctx.location.href }, title: ctx.title, referrer: ctx.referrer },
        navigator: { language: nav.language },
      },
    });
  }

  // fnId → ścieżka API (np. "analytics.subscribe", "browser.cookie.set") per pixel
  const mapyFn = new Map();
  function zbierzMapeFn(api) {
    const out = {};
    (function chodz(obj, sciezka, glebokosc) {
      if (!obj || typeof obj !== 'object' || glebokosc > 6) return;
      if (typeof obj['_@f'] === 'string') {
        out[obj['_@f']] = sciezka.join('.');
        return;
      }
      for (const k of Object.keys(obj)) chodz(obj[k], sciezka.concat(k), glebokosc + 1);
    })(api, [], 0);
    return out;
  }
  function zapamietajMapeFn(kluczPixela, mapa) {
    if (!mapa) return;
    let m = mapyFn.get(kluczPixela);
    if (!m) {
      m = new Map();
      mapyFn.set(kluczPixela, m);
    }
    for (const id of Object.keys(mapa)) m.set(id, mapa[id]);
  }

  function zgadnijNazwe(cfg) {
    if (cfg.id === 'shopify-app-pixel') return 'Shopify (app pixel)';
    if (cfg.id === 'shopify-custom-pixel') return 'Shopify (custom pixel)';
    try {
      const c = JSON.parse(cfg.configuration || '{}');
      if (c.webPixelName) return String(c.webPixelName);
      if (c.endpoint) return String(c.endpoint).replace(/^https?:\/\//, '').slice(0, 40);
    } catch (e) {}
    return null;
  }

  // rodzic → sandbox (initialize, dostarczone zdarzenia, callbacki zgody)
  function doSandboksa(dane, meta) {
    const rpc = parsujRpc(dane);
    if (!rpc) {
      licz('wiadomosciSpozaRpc');
      return;
    }
    if (rpc.rodzaj === 'wynik') {
      licz('rpcWyniki');
      return;
    }
    if (rpc.rodzaj === 'wywolanie' && rpc.metoda === 'initialize') {
      const arg = rpc.argumenty && rpc.argumenty[0];
      if (!arg || !arg.webPixelConfig) {
        licz('rpcNieznaneDo');
        return;
      }
      licz('rpcInit');
      const cfg = arg.webPixelConfig;
      const kluczPixela = String(cfg.id);
      const mapaFn = zbierzMapeFn(arg.webPixelApi);
      zapamietajMapeFn(kluczPixela, mapaFn);
      wyslij({
        rodzaj: 'pixel',
        pixel: {
          id: kluczPixela,
          typ: cfg.type || (meta && meta.typ) || null,
          srodowisko: cfg.runtimeContext || (meta && meta.srodowisko) || null,
          nazwa: zgadnijNazwe(cfg),
          apiClientId: cfg.apiClientId,
          scriptVersion: cfg.scriptVersion,
          privacyPurposes: cfg.privacyPurposes,
          dataSharingState: cfg.dataSharingState,
          konfiguracja: typeof cfg.configuration === 'string' ? cfg.configuration.slice(0, 600) : null,
          gospodarz: meta && meta.gospodarz,
        },
        mapaFn,
        zgodaInit: arg.init && arg.init.customerPrivacy ? czysty(arg.init.customerPrivacy, 4000) : null,
      });
      return;
    }
    if (rpc.rodzaj === 'zastosuj' && Array.isArray(rpc.argumenty) && rpc.argumenty.length >= 1) {
      const a0 = rpc.argumenty[0];
      if (toZdarzenieShopify(a0)) {
        licz('rpcZdarzenie');
        wyslij({ rodzaj: 'event', pixelKey: meta && meta.pixelId ? String(meta.pixelId) : null, zdarzenie: skrocZdarzenie(a0) });
        return;
      }
      if (a0 && typeof a0 === 'object' && (a0.customerPrivacy || 'analyticsAllowed' in a0 || 'marketingAllowed' in a0)) {
        licz('rpcZgoda');
        wyslij({ rodzaj: 'consent-shopify', zrodlo: 'callback do sandboksa ' + (meta && meta.pixelId), stan: czysty(a0.customerPrivacy || a0, 4000) });
        return;
      }
    }
    licz('rpcNieznaneDo');
  }

  // sandbox → rodzic (analytics.subscribe, browser.cookie.set, ...)
  function odSandboksa(dane, meta) {
    const rpc = parsujRpc(dane);
    if (!rpc) {
      licz('wiadomosciSpozaRpc');
      return;
    }
    if (rpc.rodzaj === 'wynik') {
      licz('rpcWyniki');
      return;
    }
    if (rpc.rodzaj !== 'zastosuj') {
      licz('rpcNieznaneOd');
      return;
    }
    const klucz = meta && meta.pixelId ? String(meta.pixelId) : null;
    const m = klucz ? mapyFn.get(klucz) : null;
    const sciezka = m ? m.get(rpc.fn) : null;
    if (!sciezka) {
      licz('rpcNieznaneOd');
      return;
    }
    const args = Array.isArray(rpc.argumenty) ? rpc.argumenty : [];
    if (sciezka === 'analytics.subscribe') {
      licz('rpcSubskrypcja');
      wyslij({ rodzaj: 'subscribe', pixelKey: klucz, nazwaZdarzenia: String(args[0]) });
    } else if (sciezka === 'browser.cookie.set' || sciezka === 'browser.sendBeacon') {
      licz('rpcApiZnane');
      wyslij({ rodzaj: 'api', pixelKey: klucz, api: sciezka, arg: String(args[0]).slice(0, 300) });
    } else {
      licz('rpcApiZnane');
    }
  }

  // ------------------------------------------------------------------ Workery (app pixele, STRICT)
  try {
    const OryginalnyWorker = window.Worker;
    if (typeof OryginalnyWorker === 'function') {
      const metaWorkerow = new WeakMap();
      const oryginalnyPost = OryginalnyWorker.prototype.postMessage;
      const OpakowanyWorker = new Proxy(OryginalnyWorker, {
        construct(cel, args, nowyCel) {
          const w = Reflect.construct(cel, args, nowyCel);
          licz('workeryUtworzone');
          try {
            const url = String(args[0]);
            const p = parsujAdresPixela(url);
            if (p) {
              licz('workeryPixeli');
              const meta = { pixelId: p.pixelId, gospodarz: 'worker', typ: 'APP', srodowisko: 'STRICT', url };
              metaWorkerow.set(w, meta);
              w.addEventListener('message', (ev) => odSandboksa(ev.data, meta));
            }
          } catch (e) {}
          return w;
        },
      });
      OryginalnyWorker.prototype.postMessage = function () {
        try {
          const meta = metaWorkerow.get(this);
          if (meta) doSandboksa(arguments[0], meta);
        } catch (e) {}
        return oryginalnyPost.apply(this, arguments);
      };
      window.Worker = OpakowanyWorker;
    }
  } catch (e) {}

  // ------------------------------------------------------------------ iframe'y (custom pixele, LAX)
  if (!jestemNaGorze && ramka.rodzaj !== 'top') {
    const meta = { pixelId: ramka.pixelId, gospodarz: 'iframe', typ: ramka.rodzaj === 'custom-pixel' ? 'CUSTOM' : 'APP', srodowisko: 'LAX' };
    window.addEventListener(
      'message',
      (ev) => {
        try {
          if (!ramka.pixelId) return;
          if (ev.source !== window.parent) return;
          doSandboksa(ev.data, meta);
        } catch (e) {}
      },
      true
    );
  }

  if (jestemNaGorze) {
    window.addEventListener(
      'message',
      (ev) => {
        const d = ev.data;
        if (!d) return;
        if (typeof d === 'object' && d.__td_przekaz) {
          const rekord = d.__td_przekaz;
          if (rekord && rekord.rodzaj === 'pixel' && rekord.mapaFn && rekord.pixel) zapamietajMapeFn(String(rekord.pixel.id), rekord.mapaFn);
          wyslij(rekord);
          return;
        }
        if (Array.isArray(d) && ev.source && ev.source !== window) {
          let nazwa = null;
          try {
            const ramki = document.querySelectorAll('iframe');
            for (const f of ramki) {
              if (f.contentWindow === ev.source) {
                nazwa = f.name;
                break;
              }
            }
          } catch (e) {}
          const sb = parsujNazweSandboksa(nazwa);
          if (sb) odSandboksa(d, { pixelId: sb.pixelId, gospodarz: 'iframe', typ: sb.typ, srodowisko: sb.srodowisko });
        }
      },
      true
    );
  }

  // ------------------------------------------------------------------ dataLayer / gtag consent
  function zbadajPush(element, odtworzone) {
    try {
      if (!element || typeof element !== 'object') return;
      licz('dlPushe');
      const znacznik = Object.prototype.toString.call(element);
      const toArgumenty = znacznik === '[object Arguments]' || Array.isArray(element);
      if (toArgumenty) {
        if (element.length >= 2 && element[0] === 'consent') {
          wyslij({ rodzaj: 'consent', komenda: String(element[1]), parametry: czysty(element[2], 4000), odtworzone: !!odtworzone });
        } else if (element.length >= 2 && element[0] === 'event') {
          wyslij({ rodzaj: 'gtag-event', nazwa: String(element[1]), parametry: czysty(element[2], 20000), odtworzone: !!odtworzone });
        }
        return;
      }
      if (typeof element.event === 'string') {
        wyslij({ rodzaj: 'datalayer', nazwa: element.event, payload: czysty(element, 20000), odtworzone: !!odtworzone });
      }
    } catch (e) {}
  }

  function opaszDataLayer(tablica) {
    if (!Array.isArray(tablica) || tablica.__tdOpakowany) return;
    try {
      Object.defineProperty(tablica, '__tdOpakowany', { value: true, enumerable: false });
    } catch (e) {
      return;
    }
    const oryginalnyPush = tablica.push;
    tablica.push = function () {
      for (let i = 0; i < arguments.length; i++) zbadajPush(arguments[i], false);
      return oryginalnyPush.apply(this, arguments);
    };
    for (let i = 0; i < tablica.length; i++) zbadajPush(tablica[i], true);
  }

  // Nazwa tablicy dataLayer bywa zmieniana w kontenerze — obserwujemy domyślną i typowe warianty.
  for (const nazwa of ['dataLayer', 'gtmDataLayer', 'dataLayerGTM']) {
    try {
      if (Array.isArray(window[nazwa])) {
        opaszDataLayer(window[nazwa]);
        continue;
      }
      let biezaca = window[nazwa];
      Object.defineProperty(window, nazwa, {
        configurable: true,
        enumerable: true,
        get() {
          return biezaca;
        },
        set(v) {
          biezaca = v;
          opaszDataLayer(v);
        },
      });
    } catch (e) {}
  }

  // ------------------------------------------------------------------ Shopify.analytics.publish
  // Zdarzenia własne motywu i aplikacji — widoczne NIEZALEŻNIE od tego, czy ktokolwiek subskrybuje.
  if (jestemNaGorze) {
    let opakowany = null;
    const sprobujOpakowac = () => {
      try {
        const an = window.Shopify && window.Shopify.analytics;
        if (!an || typeof an.publish !== 'function' || an.publish === opakowany) return;
        const oryginal = an.publish;
        opakowany = function (nazwa, payload, opcje) {
          try {
            licz('publishWywolania');
            wyslij({ rodzaj: 'publish', nazwa: String(nazwa), payload: czysty(payload, 20000), opcje: czysty(opcje, 2000) });
          } catch (e) {}
          return oryginal.apply(this, arguments);
        };
        an.publish = opakowany;
      } catch (e) {}
    };
    let prob = 0;
    const interwal = setInterval(() => {
      prob++;
      sprobujOpakowac();
      if (prob > 120) clearInterval(interwal);
    }, 500);
    setInterval(sprobujOpakowac, 5000);
  }

  // ------------------------------------------------------------------ zgoda: Shopify + CMP
  if (jestemNaGorze) {
    const wyslijZgodeShopify = (zrodlo, szczegoly) => {
      const cp = window.Shopify && window.Shopify.customerPrivacy;
      if (!cp) return;
      const stan = {};
      try {
        stan.visitorConsent = cp.currentVisitorConsent();
      } catch (e) {}
      for (const f of ['analyticsProcessingAllowed', 'marketingAllowed', 'preferencesProcessingAllowed', 'saleOfDataAllowed', 'shouldShowBanner']) {
        try {
          if (typeof cp[f] === 'function') stan[f] = cp[f]();
        } catch (e) {}
      }
      wyslij({ rodzaj: 'consent-shopify', zrodlo, stan: czysty(stan, 4000), szczegoly: szczegoly ? czysty(szczegoly, 4000) : null });
    };
    let prob = 0;
    const interwal = setInterval(() => {
      prob++;
      const cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.currentVisitorConsent === 'function') {
        clearInterval(interwal);
        wyslijZgodeShopify('początkowy odczyt');
      } else if (prob > 60) {
        clearInterval(interwal);
      }
    }, 500);
    document.addEventListener('visitorConsentCollected', (e) => wyslijZgodeShopify('visitorConsentCollected', e && e.detail));

    // CMP — rozpoznawane ogólnie, nie pod konkretnego dostawcę.
    const wyslijCmp = (cmp, zrodlo, stan) => wyslij({ rodzaj: 'consent-cmp', cmp, zrodlo, stan: czysty(stan, 3000) });

    const odczytCookiebot = (zrodlo) => {
      try {
        const c = window.Cookiebot && window.Cookiebot.consent;
        if (!c) return;
        wyslijCmp('Cookiebot', zrodlo, {
          marketing: c.marketing,
          statistics: c.statistics,
          preferences: c.preferences,
          necessary: c.necessary,
          method: c.method,
          hasResponse: window.Cookiebot.hasResponse,
        });
      } catch (e) {}
    };
    for (const nazwa of ['CookiebotOnConsentReady', 'CookiebotOnAccept', 'CookiebotOnDecline']) {
      window.addEventListener(nazwa, () => odczytCookiebot(nazwa));
    }

    const odczytOneTrust = (zrodlo) => {
      try {
        if (!window.OnetrustActiveGroups && !window.OneTrust) return;
        wyslijCmp('OneTrust', zrodlo, { aktywneGrupy: String(window.OnetrustActiveGroups || '') });
      } catch (e) {}
    };
    window.addEventListener('consent.onetrust', () => odczytOneTrust('consent.onetrust'));
    window.addEventListener('OneTrustGroupsUpdated', () => odczytOneTrust('OneTrustGroupsUpdated'));

    const odczytUsercentrics = (zrodlo, detail) => {
      try {
        if (!window.UC_UI && !detail) return;
        wyslijCmp('Usercentrics', zrodlo, detail || { gotowe: true });
      } catch (e) {}
    };
    window.addEventListener('ucEvent', (e) => odczytUsercentrics('ucEvent', e && e.detail));

    // IAB TCF — wspólny mianownik wielu CMP
    let tcfProby = 0;
    const tcfInterwal = setInterval(() => {
      tcfProby++;
      try {
        if (typeof window.__tcfapi === 'function') {
          clearInterval(tcfInterwal);
          window.__tcfapi('addEventListener', 2, (tcData, ok) => {
            if (!ok || !tcData) return;
            wyslijCmp('TCF', tcData.eventStatus || 'tcloaded', {
              gdprApplies: tcData.gdprApplies,
              eventStatus: tcData.eventStatus,
              cmpId: tcData.cmpId,
              celeZgody: tcData.purpose && tcData.purpose.consents ? Object.keys(tcData.purpose.consents).filter((k) => tcData.purpose.consents[k]).join(',') : null,
            });
          });
        } else if (tcfProby > 40) {
          clearInterval(tcfInterwal);
        }
      } catch (e) {
        clearInterval(tcfInterwal);
      }
    }, 500);

    setTimeout(() => {
      odczytCookiebot('odczyt po starcie');
      odczytOneTrust('odczyt po starcie');
    }, 3000);
  }

  // ------------------------------------------------------------------ meldunek: hook działa w tej ramce
  zamelduj();
  setTimeout(wyslijStats, 2500);
  setInterval(() => {
    statsBrudne = true;
    wyslijStats();
  }, 10000);
})();
