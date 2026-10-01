// tlo.js — service worker (MV3). Serce narzędzia: zbiera, porządkuje, nic nie wysyła na zewnątrz.
//
// Dwa źródła danych:
//  1. content/sonda.js (świat strony) → zdarzenia web pixel Shopify, subskrypcje, gtag consent,
//     dataLayer, Customer Privacy API, Shopify.analytics.publish, meldunki `hello` i liczniki `stats`.
//  2. chrome.webRequest → żądania ze WSZYSTKICH kontekstów karty (ramka główna, sandboksowane
//     iframe'y, workery) razem z body POST. Każde żądanie trafia do jednej z szuflad:
//     rozpoznane / inne / własne (pełne rekordy) albo pominięte (licznik per host).
//
// Stan trzymany per karta w pamięci + kopia w chrome.storage.session (przeżywa uśpienie workera,
// nie przeżywa zamknięcia przeglądarki).
importScripts('lib/konfiguracja.js', 'lib/analiza.js');

const K = self.TDKonfiguracja;
const A = self.TDAnaliza;

const MAKS_HISTORII = 300;

const karty = new Map(); // tabId -> stan
const panele = new Set(); // { port, tabId }
const pamiecRamek = new Map(); // "tabId:frameId" -> opis ramki
const hostyKart = new Map(); // tabId -> host dokumentu głównego
const timeryZapisu = new Map();
const timeryDiag = new Map();
const sieroty = { razem: 0, hosty: {} }; // żądania bez karty (prerender, service worker strony)

let konfiguracja = K.normalizuj(null);
const klasyfikatory = new Map(); // host -> { klasyfikator, profil, ustawienia }
let wykryteKandydatury = {};
let timerWykrytych = null;

// ---------------------------------------------------------------- konfiguracja
async function przeladujKonfiguracje() {
  konfiguracja = await K.wczytaj();
  klasyfikatory.clear();
  wykryteKandydatury = await K.wczytajWykryte();
  for (const p of panele) {
    try {
      p.port.postMessage({ typ: 'konfiguracja', konfiguracja });
    } catch (e) {}
  }
}

const gotowaKonfiguracja = przeladujKonfiguracje();

chrome.storage.onChanged.addListener((zmiany, obszar) => {
  if (obszar !== 'local') return;
  if (zmiany[K.KLUCZ]) przeladujKonfiguracje();
});

function klasyfikatorDla(host) {
  const klucz = host || '';
  let wpis = klasyfikatory.get(klucz);
  if (!wpis) {
    const ustawienia = K.dlaHosta(konfiguracja, host);
    wpis = { klasyfikator: A.utworz(ustawienia), profil: ustawienia.profil, ustawienia };
    klasyfikatory.set(klucz, wpis);
  }
  return wpis;
}

// ---------------------------------------------------------------- stan karty
function nowyStan(tabId) {
  return {
    tabId,
    seq: 0,
    zdarzenia: [],
    zadania: [],
    piksele: {},
    zgoda: { gtag: {}, zrodlaGtag: {}, gcs: null, shopify: null, cmp: null, historia: [] },
    liczniki: { zdarzenia: {}, platformy: {}, dl: {} },
    diag: {
      profil: null,
      shopify: null,
      ostatniaNawigacja: null,
      adresNawigacji: null,
      meldunekTop: null,
      meldunki: {},
      ramki: {},
      obceHosty: {},
      sciezkiWlasne: {},
      pominiete: {},
      pominieteRazem: 0,
      usuniete: 0,
      limitPozycji: konfiguracja.globalne.limitPozycji,
      restartyWorkera: 0,
      // Kiedy worker w ogole zaczal patrzec na te karte. Bez tego nie da sie odroznic
      // „nic sie nie dzialo" od „zaczelismy patrzec dopiero teraz".
      odkryteO: Date.now(),
      odzyskaneO: null,
      kandydaci: {},
    },
    // Aktywny znacznik etapu zakupu (home / product / add-to-cart / checkout / ...).
    etap: null,
    zmienionyO: Date.now(),
  };
}

function stan(tabId) {
  let s = karty.get(tabId);
  if (!s) {
    s = nowyStan(tabId);
    karty.set(tabId, s);
  }
  if (!s.diag) s.diag = nowyStan(tabId).diag;
  return s;
}

function nastepnyUid(s) {
  s.seq++;
  return 'e' + s.tabId + '-' + s.seq;
}

function dodaj(s, lista, rekord) {
  // Kazda pozycja dostaje etykiete aktywnego etapu w chwili zapisu — eksport per etap stoi na tym.
  if (rekord && rekord.etap === undefined) rekord.etap = s.etap || null;
  lista.push(rekord);
  const limit = konfiguracja.globalne.limitPozycji || K.DOMYSLNA.globalne.limitPozycji;
  s.diag.limitPozycji = limit;
  if (lista.length > limit) {
    const n = lista.length - limit;
    lista.splice(0, n);
    s.diag.usuniete += n;
  }
}

function rozeslij(tabId, wiadomosc) {
  for (const p of panele) {
    if (p.tabId !== tabId) continue;
    try {
      p.port.postMessage(wiadomosc);
    } catch (e) {}
  }
}

function dotknij(tabId) {
  const s = stan(tabId);
  s.zmienionyO = Date.now();
  zaplanujZapis(tabId);
}

function rozeslijDiag(tabId) {
  if (timeryDiag.has(tabId)) return;
  timeryDiag.set(
    tabId,
    setTimeout(() => {
      timeryDiag.delete(tabId);
      const s = karty.get(tabId);
      if (!s) return;
      rozeslij(tabId, { typ: 'diag', tabId, diag: s.diag, sieroty });
    }, 400)
  );
}

// ---------------------------------------------------------------- trwałość
function zaplanujZapis(tabId) {
  if (timeryZapisu.has(tabId)) return;
  timeryZapisu.set(
    tabId,
    setTimeout(async () => {
      timeryZapisu.delete(tabId);
      const s = karty.get(tabId);
      if (!s) return;
      try {
        await chrome.storage.session.set({ ['karta:' + tabId]: s });
      } catch (e) {
        try {
          const przytnij = (lista) => {
            const n = Math.max(0, lista.length - 400);
            lista.splice(0, n);
            s.diag.usuniete += n;
          };
          przytnij(s.zdarzenia);
          przytnij(s.zadania);
          await chrome.storage.session.set({ ['karta:' + tabId]: s });
          rozeslijDiag(tabId);
        } catch (e2) {}
      }
    }, 1000)
  );
}

const odtworzone = chrome.storage.session
  .get(null)
  .then((wszystko) => {
    for (const k of Object.keys(wszystko || {})) {
      if (!k.startsWith('karta:')) continue;
      const id = Number(k.slice(6));
      if (!karty.has(id)) {
        const s = wszystko[k];
        if (!s.diag) s.diag = nowyStan(id).diag;
        s.diag.restartyWorkera = (s.diag.restartyWorkera || 0) + 1;
        karty.set(id, s);
      }
    }
    if (wszystko && wszystko.sieroty) Object.assign(sieroty, wszystko.sieroty);
  })
  .catch(() => {});

const gotowe = Promise.all([gotowaKonfiguracja, odtworzone]);

// ---------------------------------------------------------------- wykryte kandydatury
function zapiszKandydata(tabId, kand, url) {
  const s = stan(tabId);
  s.diag.kandydaci[kand.host] = (s.diag.kandydaci[kand.host] || 0) + 1;
  const w = wykryteKandydatury[kand.host] || { host: kand.host, liczba: 0, pierwszy: Date.now(), sciezki: {}, pierwszaStrona: kand.pierwszaStrona };
  w.liczba++;
  w.ostatni = Date.now();
  w.sciezki[kand.sciezka] = (w.sciezki[kand.sciezka] || 0) + 1;
  w.przyklad = String(url).slice(0, 300);
  w.pierwszaStrona = w.pierwszaStrona || kand.pierwszaStrona;
  wykryteKandydatury[kand.host] = w;
  if (!timerWykrytych) {
    timerWykrytych = setTimeout(() => {
      timerWykrytych = null;
      chrome.storage.local.set({ [K.KLUCZ_WYKRYTE]: wykryteKandydatury }).catch(() => {});
    }, 2000);
  }
  rozeslijDiag(tabId);
}

// ---------------------------------------------------------------- zgoda
function dopiszHistorie(s, wpis) {
  s.zgoda.historia.push(wpis);
  if (s.zgoda.historia.length > MAKS_HISTORII) s.zgoda.historia.splice(0, s.zgoda.historia.length - MAKS_HISTORII);
  rozeslij(s.tabId, { typ: 'zgoda', tabId: s.tabId, zgoda: s.zgoda });
}

function odnotujGcs(s, r) {
  const gcs = String(r.sem.gcs);
  const poprzedni = s.zgoda.gcs ? s.zgoda.gcs.wartosc : null;
  s.zgoda.gcs = { wartosc: gcs, gcd: r.sem.gcd || null, t: r.t, platforma: r.etykietaPlatformy, url: r.host + r.sciezka };
  if (poprzedni !== gcs) {
    dopiszHistorie(s, {
      t: r.t,
      rodzaj: 'gcs',
      zrodlo: r.etykietaPlatformy + ' ' + r.host + r.sciezka,
      ramka: r.ramka ? r.ramka.etykieta : null,
      wartosci: { gcs, gcd: r.sem.gcd || null, event: r.nazwaZdarzenia || null },
    });
  } else {
    rozeslij(s.tabId, { typ: 'zgoda', tabId: s.tabId, zgoda: s.zgoda });
  }
}

// ---------------------------------------------------------------- rekordy ze świata strony
function zapewnijPiksel(s, klucz, t) {
  if (!s.piksele[klucz]) {
    s.piksele[klucz] = { id: klucz, subskrypcje: [], wywolaniaApi: [], zdarzeniaOdebrane: 0, pierwszyRaz: t };
  }
  return s.piksele[klucz];
}

function obsluzPrzechwyt(tabId, rekord) {
  if (!rekord || typeof rekord !== 'object') return;
  const s = stan(tabId);
  const ramka = rekord.ramka || { rodzaj: 'top', etykieta: 'ramka główna', pixelId: null };
  const t = rekord.t || Date.now();

  // KAŻDY rekord z ramki głównej jest dowodem, że sonda w tym dokumencie żyje — nie tylko `hello`.
  // Pojedynczy meldunek wysyłany przy document_start potrafi zginąć (uśpiony service worker budzi
  // się dopiero na tę wiadomość, mostek bywa wymieniany w trakcie ładowania). Gdyby wiarygodność
  // wisiała na tym jednym rekordzie, działający dokument bywałby raportowany jako ślepy —
  // czyli narzędzie kłamałoby w drugą stronę, co jest równie szkodliwe jak cicha ślepota.
  // Rekordy starsze od ostatniej nawigacji pochodzą z poprzedniego dokumentu i się nie liczą.
  // Zapisujemy PIERWSZY sygnał życia w tym dokumencie — „dane wiarygodne od" ma wskazywać początek
  // kompletnego zapisu, a nie ostatnią rzecz, jaka przyszła.
  if (ramka.rodzaj === 'top' && (!s.diag.ostatniaNawigacja || t >= s.diag.ostatniaNawigacja - 2000) && (!s.diag.meldunekTop || t < s.diag.meldunekTop)) {
    s.diag.meldunekTop = t;
    if (ramka.href) s.diag.adresMeldunku = ramka.href;
    if (!s.diag.meldunki['ramka główna']) s.diag.meldunki['ramka główna'] = { t, rodzaj: 'top', href: ramka.href || null };
    rozeslijDiag(tabId);
  }

  switch (rekord.rodzaj) {
    case 'hello': {
      if (ramka.rodzaj === 'top') {
        s.diag.meldunekTop = t;
        s.diag.adresMeldunku = ramka.href || null;
        s.diag.shopify = !!rekord.shopify;
        if (ramka.href) {
          try {
            hostyKart.set(tabId, new URL(ramka.href).hostname);
          } catch (e) {}
        }
      }
      s.diag.meldunki[ramka.etykieta] = { t, rodzaj: ramka.rodzaj, href: ramka.href || null };
      rozeslijDiag(tabId);
      break;
    }
    case 'stats': {
      s.diag.ramki[ramka.etykieta] = { t, rodzaj: ramka.rodzaj, stats: rekord.stats };
      if (ramka.rodzaj === 'top' && rekord.stats && typeof rekord.stats.shopify === 'boolean') {
        s.diag.shopify = rekord.stats.shopify;
      }
      rozeslijDiag(tabId);
      break;
    }
    case 'pixel': {
      const p = rekord.pixel;
      if (!p || p.id == null) return;
      const klucz = String(p.id);
      const px = zapewnijPiksel(s, klucz, t);
      Object.assign(px, {
        typ: p.typ || px.typ || null,
        srodowisko: p.srodowisko || px.srodowisko || null,
        nazwa: p.nazwa || px.nazwa || null,
        apiClientId: p.apiClientId != null ? p.apiClientId : px.apiClientId,
        scriptVersion: p.scriptVersion || px.scriptVersion,
        privacyPurposes: p.privacyPurposes || px.privacyPurposes,
        dataSharingState: p.dataSharingState || px.dataSharingState,
        konfiguracja: p.konfiguracja || px.konfiguracja || null,
        gospodarz: p.gospodarz || px.gospodarz || null,
        ramka: ramka.etykieta,
        ostatnioWidziany: t,
        rejestracje: (px.rejestracje || 0) + 1,
      });
      s.diag.shopify = true;
      if (rekord.zgodaInit) {
        const ostatni = s.zgoda.historia.filter((x) => x.rodzaj === 'shopify-init').pop();
        const takiSam = ostatni && JSON.stringify(ostatni.wartosci) === JSON.stringify(rekord.zgodaInit);
        if (!takiSam) dopiszHistorie(s, { t, rodzaj: 'shopify-init', zrodlo: 'init pixela ' + klucz, ramka: ramka.etykieta, wartosci: rekord.zgodaInit });
      }
      rozeslij(tabId, { typ: 'piksele', tabId, piksele: s.piksele });
      break;
    }
    case 'subscribe': {
      if (!rekord.pixelKey) return;
      const px = zapewnijPiksel(s, String(rekord.pixelKey), t);
      if (!px.subskrypcje.includes(rekord.nazwaZdarzenia)) px.subskrypcje.push(rekord.nazwaZdarzenia);
      px.ostatniaSubskrypcja = t;
      rozeslij(tabId, { typ: 'piksele', tabId, piksele: s.piksele });
      break;
    }
    case 'api': {
      if (!rekord.pixelKey) return;
      const px = zapewnijPiksel(s, String(rekord.pixelKey), t);
      px.wywolaniaApi.push({ t, api: rekord.api, arg: rekord.arg });
      if (px.wywolaniaApi.length > 50) px.wywolaniaApi.splice(0, px.wywolaniaApi.length - 50);
      rozeslij(tabId, { typ: 'piksele', tabId, piksele: s.piksele });
      break;
    }
    case 'event': {
      const ev = rekord.zdarzenie;
      if (!ev || !ev.id) return;
      const klucz = rekord.pixelKey ? String(rekord.pixelKey) : ramka.pixelId ? String(ramka.pixelId) : '?';
      let istniejacy = null;
      for (let i = s.zdarzenia.length - 1; i >= 0 && i >= s.zdarzenia.length - 400; i--) {
        const r = s.zdarzenia[i];
        if (r.rodzaj === 'shopify' && r.id === ev.id) {
          istniejacy = r;
          break;
        }
      }
      if (istniejacy) {
        if (!istniejacy.dostarczoneDo.includes(klucz)) istniejacy.dostarczoneDo.push(klucz);
        if (s.piksele[klucz]) s.piksele[klucz].zdarzeniaOdebrane++;
        rozeslij(tabId, { typ: 'aktualizacja', tabId, lista: 'zdarzenia', rekord: istniejacy });
      } else {
        const r = {
          uid: nastepnyUid(s),
          rodzaj: 'shopify',
          t,
          id: ev.id,
          nazwa: ev.name,
          typZdarzenia: ev.type || null,
          timestamp: ev.timestamp,
          clientId: ev.clientId || null,
          seq: ev.seq != null ? ev.seq : null,
          podsumowanie: A.podsumujZdarzenie(ev),
          adres: ev.context && ev.context.document && ev.context.document.location ? ev.context.document.location.href : null,
          dostarczoneDo: [klucz],
          surowe: ev,
        };
        dodaj(s, s.zdarzenia, r);
        s.liczniki.zdarzenia[ev.name] = (s.liczniki.zdarzenia[ev.name] || 0) + 1;
        s.diag.ostatnieZdarzenie = t;
        s.diag.shopify = true;
        if (s.piksele[klucz]) s.piksele[klucz].zdarzeniaOdebrane++;
        rozeslij(tabId, { typ: 'dodaj', tabId, lista: 'zdarzenia', rekord: r });
      }
      break;
    }
    case 'publish': {
      const r = { uid: nastepnyUid(s), rodzaj: 'publish', t, nazwa: rekord.nazwa, ramka: ramka.etykieta, surowe: { payload: rekord.payload, opcje: rekord.opcje } };
      dodaj(s, s.zdarzenia, r);
      s.liczniki.dl['publish:' + rekord.nazwa] = (s.liczniki.dl['publish:' + rekord.nazwa] || 0) + 1;
      rozeslij(tabId, { typ: 'dodaj', tabId, lista: 'zdarzenia', rekord: r });
      break;
    }
    case 'consent': {
      const parametry = rekord.parametry && typeof rekord.parametry === 'object' ? rekord.parametry : {};
      for (const k of Object.keys(parametry)) {
        s.zgoda.gtag[k] = parametry[k];
        s.zgoda.zrodlaGtag[k] = { komenda: rekord.komenda, ramka: ramka.etykieta, t };
      }
      const r = { uid: nastepnyUid(s), rodzaj: 'consent', t, nazwa: 'consent ' + rekord.komenda, komenda: rekord.komenda, parametry, ramka: ramka.etykieta, odtworzone: !!rekord.odtworzone };
      dodaj(s, s.zdarzenia, r);
      rozeslij(tabId, { typ: 'dodaj', tabId, lista: 'zdarzenia', rekord: r });
      dopiszHistorie(s, { t, rodzaj: 'gtag ' + rekord.komenda, zrodlo: "gtag('consent','" + rekord.komenda + "')", ramka: ramka.etykieta, wartosci: parametry, odtworzone: !!rekord.odtworzone });
      break;
    }
    case 'consent-shopify': {
      s.zgoda.shopify = { t, zrodlo: rekord.zrodlo, stan: rekord.stan || {} };
      const wartosci = Object.assign({}, (rekord.stan && rekord.stan.visitorConsent) || {});
      for (const k of Object.keys(rekord.stan || {})) if (k !== 'visitorConsent') wartosci[k] = rekord.stan[k];
      dopiszHistorie(s, { t, rodzaj: 'shopify', zrodlo: 'Shopify.customerPrivacy (' + rekord.zrodlo + ')', ramka: ramka.etykieta, wartosci });
      break;
    }
    case 'consent-cmp': {
      s.zgoda.cmp = { t, cmp: rekord.cmp, zrodlo: rekord.zrodlo, stan: rekord.stan || {} };
      dopiszHistorie(s, { t, rodzaj: 'cmp', zrodlo: (rekord.cmp || 'CMP') + ' (' + rekord.zrodlo + ')', ramka: ramka.etykieta, wartosci: rekord.stan || {} });
      break;
    }
    case 'datalayer': {
      const r = {
        uid: nastepnyUid(s),
        rodzaj: 'datalayer',
        t,
        nazwa: rekord.nazwa,
        ramka: ramka.etykieta,
        klucze: rekord.payload && typeof rekord.payload === 'object' ? Object.keys(rekord.payload).filter((k) => k !== 'event') : [],
        surowe: rekord.payload,
        odtworzone: !!rekord.odtworzone,
      };
      dodaj(s, s.zdarzenia, r);
      s.liczniki.dl[rekord.nazwa] = (s.liczniki.dl[rekord.nazwa] || 0) + 1;
      rozeslij(tabId, { typ: 'dodaj', tabId, lista: 'zdarzenia', rekord: r });
      break;
    }
    case 'gtag-event': {
      const r = { uid: nastepnyUid(s), rodzaj: 'gtag-event', t, nazwa: rekord.nazwa, ramka: ramka.etykieta, surowe: rekord.parametry, odtworzone: !!rekord.odtworzone };
      dodaj(s, s.zdarzenia, r);
      rozeslij(tabId, { typ: 'dodaj', tabId, lista: 'zdarzenia', rekord: r });
      break;
    }
    default:
      return;
  }
  dotknij(tabId);
}

chrome.runtime.onMessage.addListener((wiadomosc, nadawca) => {
  if (!wiadomosc || wiadomosc.typ !== 'przechwyt' || !nadawca.tab) return;
  gotowe.then(() => obsluzPrzechwyt(nadawca.tab.id, wiadomosc.rekord));
});

// ---------------------------------------------------------------- ramki
function wyczyscPamiecRamek(tabId, frameId) {
  if (frameId == null) {
    for (const k of Array.from(pamiecRamek.keys())) if (k.startsWith(tabId + ':')) pamiecRamek.delete(k);
  } else {
    pamiecRamek.delete(tabId + ':' + frameId);
  }
}

async function ustalRamke(tabId, frameId) {
  if (frameId === 0) return { rodzaj: 'top', etykieta: 'ramka główna', pixelId: null };
  if (frameId < 0) return { rodzaj: 'inna', etykieta: 'poza ramką (worker / SW)', pixelId: null };
  const klucz = tabId + ':' + frameId;
  if (pamiecRamek.has(klucz)) return pamiecRamek.get(klucz);
  let opis;
  try {
    const f = await chrome.webNavigation.getFrame({ tabId, frameId });
    opis = A.opiszRamke(f && f.url, frameId);
  } catch (e) {
    opis = { rodzaj: 'iframe', etykieta: 'ramka #' + frameId, pixelId: null };
  }
  pamiecRamek.set(klucz, opis);
  return opis;
}

async function hostKarty(tabId) {
  if (hostyKart.has(tabId)) return hostyKart.get(tabId);
  try {
    const t = await chrome.tabs.get(tabId);
    const host = new URL(t.url || '').hostname;
    if (host) hostyKart.set(tabId, host);
    return host;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- webRequest
chrome.webRequest.onBeforeRequest.addListener(
  (szczegoly) => {
    if (szczegoly.tabId < 0) {
      // Żądanie bez karty: prerender, service worker strony, inne rozszerzenie. Liczone, nie gubione.
      try {
        const host = new URL(szczegoly.url).hostname;
        sieroty.razem++;
        sieroty.hosty[host] = (sieroty.hosty[host] || 0) + 1;
        chrome.storage.session.set({ sieroty }).catch(() => {});
        for (const p of panele) {
          try {
            p.port.postMessage({ typ: 'sieroty', sieroty });
          } catch (e) {}
        }
      } catch (e) {}
      return;
    }
    gotowe.then(async () => {
      const host = await hostKarty(szczegoly.tabId);
      const { klasyfikator, profil } = klasyfikatorDla(host);
      const s = stan(szczegoly.tabId);
      if (s.diag.profil !== profil) {
        s.diag.profil = profil;
        rozeslijDiag(szczegoly.tabId);
      }

      const cls = klasyfikator.klasyfikuj(szczegoly.url, host, szczegoly.method);
      if (cls) {
        if (cls.auto) {
          const kand = klasyfikator.kandydat(szczegoly.url, szczegoly.method, host);
          if (kand) zapiszKandydata(szczegoly.tabId, kand, szczegoly.url);
        }
        const rekordy = A.zbudujRekordy(szczegoly, cls);
        if (!rekordy.length) return;
        const ramka = await ustalRamke(szczegoly.tabId, szczegoly.frameId);
        for (const r of rekordy) {
          r.ramka = ramka;
          dodaj(s, s.zadania, r);
          s.liczniki.platformy[r.platform] = (s.liczniki.platformy[r.platform] || 0) + 1;
          rozeslij(szczegoly.tabId, { typ: 'dodaj', tabId: szczegoly.tabId, lista: 'zadania', rekord: r });
          if (r.sem && r.sem.gcs) odnotujGcs(s, r);
        }
        dotknij(szczegoly.tabId);
        return;
      }

      // Nierozpoznany host → szuflada inne / własne / pominięte
      const kand = klasyfikator.kandydat(szczegoly.url, szczegoly.method, host);
      if (kand) zapiszKandydata(szczegoly.tabId, kand, szczegoly.url);

      const kubel = klasyfikator.klasyfikujInne(szczegoly.url, szczegoly.type, host);
      if (kubel.kubel === 'skip') {
        s.diag.pominiete[kubel.host] = (s.diag.pominiete[kubel.host] || 0) + 1;
        s.diag.pominieteRazem++;
        rozeslijDiag(szczegoly.tabId);
        dotknij(szczegoly.tabId);
        return;
      }
      const cls2 = {
        platform: kubel.kubel,
        etykieta: kubel.kubel === 'inne' ? 'Inne: ' + kubel.host : 'Domena strony',
        format: /\.js$/.test(new URL(szczegoly.url).pathname) ? 'loader' : 'generic',
      };
      const rekordy = A.zbudujRekordy(szczegoly, cls2);
      const ramka = await ustalRamke(szczegoly.tabId, szczegoly.frameId);
      for (const r of rekordy) {
        r.ramka = ramka;
        dodaj(s, s.zadania, r);
        s.liczniki.platformy[r.platform] = (s.liczniki.platformy[r.platform] || 0) + 1;
        if (kubel.kubel === 'inne') s.diag.obceHosty[kubel.host] = (s.diag.obceHosty[kubel.host] || 0) + 1;
        else s.diag.sciezkiWlasne[r.sciezka] = (s.diag.sciezkiWlasne[r.sciezka] || 0) + 1;
        rozeslij(szczegoly.tabId, { typ: 'dodaj', tabId: szczegoly.tabId, lista: 'zadania', rekord: r });
      }
      rozeslijDiag(szczegoly.tabId);
      dotknij(szczegoly.tabId);
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

function oznaczZadanie(szczegoly, latka) {
  if (szczegoly.tabId < 0) return;
  const s = karty.get(szczegoly.tabId);
  if (!s) return;
  let zmienione = false;
  for (let i = s.zadania.length - 1; i >= 0 && i >= s.zadania.length - 600; i--) {
    const r = s.zadania[i];
    if (r.rodzaj === 'zadanie' && r.requestId === szczegoly.requestId) {
      Object.assign(r, latka);
      rozeslij(szczegoly.tabId, { typ: 'aktualizacja', tabId: szczegoly.tabId, lista: 'zadania', rekord: r });
      zmienione = true;
    }
  }
  if (zmienione) dotknij(szczegoly.tabId);
}

chrome.webRequest.onCompleted.addListener(
  (szczegoly) => oznaczZadanie(szczegoly, { status: szczegoly.statusCode, zCache: !!szczegoly.fromCache }),
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener((szczegoly) => oznaczZadanie(szczegoly, { blad: szczegoly.error }), { urls: ['<all_urls>'] });

// ---------------------------------------------------------------- nawigacja
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) {
    wyczyscPamiecRamek(d.tabId, d.frameId);
    return;
  }
  wyczyscPamiecRamek(d.tabId, null);
  try {
    hostyKart.set(d.tabId, new URL(d.url).hostname);
  } catch (e) {}
  gotowe.then(() => {
    const s = stan(d.tabId);
    const t = Math.round(d.timeStamp || Date.now());
    const baza = { rodzaj: 'nawigacja', t, url: d.url, przejscie: d.transitionType };
    const e = Object.assign({ uid: nastepnyUid(s) }, baza);
    const r = Object.assign({ uid: nastepnyUid(s) }, baza);
    dodaj(s, s.zdarzenia, e);
    dodaj(s, s.zadania, r);
    // Diagnostyka per strona: unieważnia wpisy POPRZEDNIEGO dokumentu, nie nowsze. Szczegóły
    // i powód takiego warunku — w komentarzu przy A.przytnijDoNawigacji.
    A.przytnijDoNawigacji(s.diag, t, d.url);
    try {
      s.diag.profil = klasyfikatorDla(new URL(d.url).hostname).profil;
    } catch (err) {}
    rozeslij(d.tabId, { typ: 'dodaj', tabId: d.tabId, lista: 'zdarzenia', rekord: e });
    rozeslij(d.tabId, { typ: 'dodaj', tabId: d.tabId, lista: 'zadania', rekord: r });
    rozeslijDiag(d.tabId);
    dotknij(d.tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  karty.delete(tabId);
  hostyKart.delete(tabId);
  wyczyscPamiecRamek(tabId, null);
  chrome.storage.session.remove('karta:' + tabId).catch(() => {});
});

// ---------------------------------------------------------------- panel
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'td-panel') return;
  const wpis = { port, tabId: null };
  panele.add(wpis);
  port.onMessage.addListener((wiadomosc) => {
    if (!wiadomosc) return;
    if (wiadomosc.typ === 'subskrybuj') {
      wpis.tabId = wiadomosc.tabId;
      gotowe.then(() => {
        try {
          port.postMessage({ typ: 'stan', tabId: wiadomosc.tabId, stan: stan(wiadomosc.tabId), sieroty, konfiguracja });
        } catch (e) {}
      });
    } else if (wiadomosc.typ === 'etap') {
      const s = stan(wiadomosc.tabId);
      const nowy = wiadomosc.etap ? String(wiadomosc.etap).trim().slice(0, 40) : null;
      s.etap = nowy || null;
      s.diag.etap = s.etap;
      s.diag.etapOd = Date.now();
      rozeslij(wiadomosc.tabId, { typ: 'etap', tabId: wiadomosc.tabId, etap: s.etap, etapOd: s.diag.etapOd });
      rozeslijDiag(wiadomosc.tabId);
      dotknij(wiadomosc.tabId);
    } else if (wiadomosc.typ === 'wyczysc') {
      const stary = karty.get(wiadomosc.tabId);
      const swiezy = nowyStan(wiadomosc.tabId);
      if (stary) swiezy.etap = stary.etap || null;
      if (stary && stary.diag) {
        swiezy.diag.ostatniaNawigacja = stary.diag.ostatniaNawigacja;
        swiezy.diag.adresNawigacji = stary.diag.adresNawigacji;
        swiezy.diag.meldunekTop = stary.diag.meldunekTop;
        swiezy.diag.meldunki = stary.diag.meldunki;
        swiezy.diag.ramki = stary.diag.ramki;
        swiezy.diag.profil = stary.diag.profil;
        swiezy.diag.shopify = stary.diag.shopify;
        swiezy.diag.odzyskaneO = stary.diag.odzyskaneO;
        swiezy.diag.etap = stary.etap || null;
      }
      karty.set(wiadomosc.tabId, swiezy);
      wyczyscPamiecRamek(wiadomosc.tabId, null);
      chrome.storage.session.remove('karta:' + wiadomosc.tabId).catch(() => {});
      rozeslij(wiadomosc.tabId, { typ: 'stan', tabId: wiadomosc.tabId, stan: stan(wiadomosc.tabId), sieroty, konfiguracja });
    }
  });
  port.onDisconnect.addListener(() => panele.delete(wpis));
});

// ---------------------------------------------------------------- odzyskanie sondy w otwartych kartach
// Skrypt tresci wchodzi do dokumentu WYLACZNIE przy jego ladowaniu. Jesli rozszerzenie wczytano
// albo przeladowano przy otwartej karcie, ten dokument zostaje bez sondy do nastepnej nawigacji —
// a Shopify Checkout to JEDEN dokument przez caly proces zakupu, wiec cisza potrafi trwac kwadranse.
// Udowodnione doswiadczalnie 2026-09-10 na obcym sklepie (patrz CHANGELOG 1.1.0).
//
// Dlatego przy kazdym starcie workera dostrzykujemy sonde do wszystkich otwartych kart. Sonda jest
// idempotentna (`window.__tdSonda`), a mostek przy ponownym wejsciu podmienia martwy uchwyt na zywy.
// Karty, ktore udalo sie w ten sposob dolaczyc, dostaja znacznik `odzyskaneO` — Diagnostyka mowi
// wprost, ze wczesniejsze zdarzenia TEGO dokumentu nie zostaly zapisane.
async function odzyskajSonde(powod) {
  let karty_ = [];
  try {
    karty_ = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (e) {
    return;
  }
  for (const t of karty_) {
    if (t.id == null || t.id < 0) continue;
    // Karta, ktora ma swiezy meldunek sondy, jest zdrowa — nie ruszamy jej.
    // (Uspienie samego service workera nie uniewaznia skryptow tresci.)
    const przed = karty.get(t.id);
    if (przed && przed.diag && przed.diag.meldunekTop && (!przed.diag.ostatniaNawigacja || przed.diag.meldunekTop >= przed.diag.ostatniaNawigacja - 2000)) continue;
    let udane = false;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content/sonda.js'], world: 'MAIN', injectImmediately: true });
      await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ['content/most.js'], injectImmediately: true });
      udane = true;
    } catch (e) {
      // Strona chroniona (chrome://, Web Store, plik lokalny bez zgody) — nie da sie i tyle.
    }
    if (!udane) continue;
    const s = stan(t.id);
    // Znacznik „dołączone w locie" stawiamy TYLKO wtedy, gdy dokument naprawdę stał już otwarty.
    // Strona, która właśnie się ładuje, dostaje sondę normalną drogą (skrypt treści z manifestu) —
    // opisanie jej jako dołączonej w locie byłoby fałszywym ostrzeżeniem, a fałszywe ostrzeżenia
    // psują zaufanie do prawdziwych.
    const wlasnieNawigowala = s.diag.ostatniaNawigacja && Date.now() - s.diag.ostatniaNawigacja < 15000;
    if (!s.diag.meldunekTop && !wlasnieNawigowala) {
      s.diag.odzyskaneO = Date.now();
      s.diag.powodOdzyskania = powod;
      try {
        hostyKart.set(t.id, new URL(t.url || '').hostname);
      } catch (e) {}
      rozeslijDiag(t.id);
      dotknij(t.id);
    }
  }
}

gotowe.then(() => odzyskajSonde('start service workera'));
chrome.runtime.onInstalled.addListener(() => gotowe.then(() => odzyskajSonde('instalacja / przeladowanie rozszerzenia')));
chrome.runtime.onStartup.addListener(() => gotowe.then(() => odzyskajSonde('start przegladarki')));

function ustawPanelBoczny() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(ustawPanelBoczny);
chrome.runtime.onStartup.addListener(ustawPanelBoczny);
ustawPanelBoczny();
