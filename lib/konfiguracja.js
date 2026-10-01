// lib/konfiguracja.js — jedno miejsce, w którym żyje wiedza o konkretnym projekcie.
// Ładowane przez service worker (importScripts), panel i stronę opcji (<script>).
//
// Zasada: w KODZIE nie ma żadnych nazw klienta ani domen projektu. Wszystko, co odróżnia
// jeden sklep od drugiego — domena kontenera serwerowego, własne narzędzia pomiarowe,
// nazwy pikseli — siedzi w konfiguracji i daje się wyeksportować do pliku profilu.
self.TDKonfiguracja = (() => {
  'use strict';

  const KLUCZ = 'konfiguracja';
  const KLUCZ_WYKRYTE = 'wykryte';

  // Wersja 2: limitPozycji podniesiony z 1500 na 20000 (sesja zakupowa jest dluga).
  const WERSJA = 2;

  const DOMYSLNA = {
    wersja: WERSJA,
    // Ustawienia wspólne dla wszystkich stron.
    globalne: {
      serwerowe: [], // hosty własnego kontenera serwerowego (sGTM), np. "dane.sklep.pl"
      platformy: [], // własne narzędzia: { id, etykieta, hosty: [...], format }
      etykietyPikseli: {}, // { "123456789": "Custom pixel: GTM + zgoda" }
      statyczneHosty: [], // dodatkowe hosty traktowane jak zasoby statyczne (tylko licznik)
      autoWykrywanieSgtm: true, // rozpoznaj kontener serwerowy po ścieżce na domenie własnej
      zbierajWlasneDomeny: true, // rejestruj XHR/fetch do domeny badanej strony
      limitPozycji: 20000,
    },
    // Profile projektów. Dopasowanie po domenie karty; ustawienia profilu dokładają się
    // do globalnych (nie zastępują ich).
    profile: {},
    // null = wybieraj profil automatycznie po domenie; nazwa = wymuś ten profil wszędzie.
    wymuszonyProfil: null,
  };

  // ------------------------------------------------------------------ domeny
  const CZLONY_ZLOZONE = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'];

  function domenaRejestrowalna(host) {
    if (!host) return '';
    const czesci = String(host).toLowerCase().replace(/\.$/, '').split('.');
    if (czesci.length <= 2) return czesci.join('.');
    const tld = czesci[czesci.length - 1];
    const sld = czesci[czesci.length - 2];
    if (tld.length === 2 && CZLONY_ZLOZONE.includes(sld)) return czesci.slice(-3).join('.');
    return czesci.slice(-2).join('.');
  }

  // Wzorce hostów:
  //   "sklep.pl"    → sklep.pl i każda subdomena
  //   "*.sklep.pl"  → tylko subdomeny
  //   "=sklep.pl"   → dokładnie ten host
  function dopasujHost(wzorzec, host) {
    if (!wzorzec || !host) return false;
    const w = String(wzorzec).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const h = String(host).trim().toLowerCase();
    if (!w) return false;
    if (w.startsWith('=')) return h === w.slice(1);
    if (w.startsWith('*.')) return h.endsWith(w.slice(1));
    return h === w || h.endsWith('.' + w);
  }

  function dopasujDowolny(wzorce, host) {
    if (!Array.isArray(wzorce)) return false;
    for (const w of wzorce) if (dopasujHost(w, host)) return true;
    return false;
  }

  // ------------------------------------------------------------------ normalizacja
  function listaTekstow(v) {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x || '').trim()).filter(Boolean);
  }

  function normalizujPlatformy(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const p of v) {
      if (!p || typeof p !== 'object') continue;
      const hosty = listaTekstow(p.hosty);
      const etykieta = String(p.etykieta || '').trim();
      if (!hosty.length || !etykieta) continue;
      const id = String(p.id || etykieta).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wlasna';
      out.push({ id: 'w-' + id, etykieta, hosty, format: String(p.format || 'generic') });
    }
    return out;
  }

  function normalizujEtykiety(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const k of Object.keys(v)) {
      const nazwa = String(v[k] || '').trim();
      if (nazwa) out[String(k).trim()] = nazwa;
    }
    return out;
  }

  const LIMIT_MAKS = 200000;

  function normalizujUstawienia(u, baza, staraWersja) {
    const b = baza || DOMYSLNA.globalne;
    u = u && typeof u === 'object' ? u : {};
    return {
      serwerowe: listaTekstow(u.serwerowe),
      platformy: normalizujPlatformy(u.platformy),
      etykietyPikseli: normalizujEtykiety(u.etykietyPikseli),
      statyczneHosty: listaTekstow(u.statyczneHosty),
      autoWykrywanieSgtm: typeof u.autoWykrywanieSgtm === 'boolean' ? u.autoWykrywanieSgtm : b.autoWykrywanieSgtm,
      zbierajWlasneDomeny: typeof u.zbierajWlasneDomeny === 'boolean' ? u.zbierajWlasneDomeny : b.zbierajWlasneDomeny,
      // Migracja: konfiguracja sprzed wersji 2 miala limit dobrany pod stary domyslny 1500.
      // Nie chcemy, zeby zapisane 1500 albo 10000 po cichu ograniczalo dluga sesje zakupowa.
      limitPozycji: staraWersja || !(Number(u.limitPozycji) > 0) ? b.limitPozycji : Math.min(LIMIT_MAKS, Math.round(Number(u.limitPozycji))),
    };
  }

  function normalizuj(cfg) {
    cfg = cfg && typeof cfg === 'object' ? cfg : {};
    const staraWersja = !(Number(cfg.wersja) >= WERSJA);
    const globalne = normalizujUstawienia(cfg.globalne, DOMYSLNA.globalne, staraWersja);
    const profile = {};
    const zrodlo = cfg.profile && typeof cfg.profile === 'object' ? cfg.profile : {};
    for (const nazwa of Object.keys(zrodlo)) {
      const p = zrodlo[nazwa] || {};
      const domeny = listaTekstow(p.domeny);
      profile[String(nazwa).trim()] = {
        domeny,
        serwerowe: listaTekstow(p.serwerowe),
        platformy: normalizujPlatformy(p.platformy),
        etykietyPikseli: normalizujEtykiety(p.etykietyPikseli),
        statyczneHosty: listaTekstow(p.statyczneHosty),
        opis: String(p.opis || '').trim(),
      };
    }
    return {
      wersja: WERSJA,
      globalne,
      profile,
      wymuszonyProfil: cfg.wymuszonyProfil ? String(cfg.wymuszonyProfil) : null,
    };
  }

  // ------------------------------------------------------------------ profil dla hosta
  function nazwaProfiluDlaHosta(cfg, host) {
    if (cfg.wymuszonyProfil && cfg.profile[cfg.wymuszonyProfil]) return cfg.wymuszonyProfil;
    if (!host) return null;
    let najlepszy = null;
    let dlugosc = -1;
    for (const nazwa of Object.keys(cfg.profile)) {
      for (const d of cfg.profile[nazwa].domeny) {
        if (dopasujHost(d, host) && d.length > dlugosc) {
          najlepszy = nazwa;
          dlugosc = d.length;
        }
      }
    }
    return najlepszy;
  }

  // Ustawienia efektywne = globalne + profil pasujący do hosta karty.
  function dlaHosta(cfg, host) {
    const nazwa = nazwaProfiluDlaHosta(cfg, host);
    const p = nazwa ? cfg.profile[nazwa] : null;
    return {
      profil: nazwa,
      serwerowe: cfg.globalne.serwerowe.concat(p ? p.serwerowe : []),
      platformy: cfg.globalne.platformy.concat(p ? p.platformy : []),
      etykietyPikseli: Object.assign({}, cfg.globalne.etykietyPikseli, p ? p.etykietyPikseli : {}),
      statyczneHosty: cfg.globalne.statyczneHosty.concat(p ? p.statyczneHosty : []),
      autoWykrywanieSgtm: cfg.globalne.autoWykrywanieSgtm,
      zbierajWlasneDomeny: cfg.globalne.zbierajWlasneDomeny,
      limitPozycji: cfg.globalne.limitPozycji,
    };
  }

  // ------------------------------------------------------------------ zapis i odczyt
  async function wczytaj() {
    try {
      const dane = await chrome.storage.local.get(KLUCZ);
      return normalizuj(dane && dane[KLUCZ]);
    } catch (e) {
      return normalizuj(null);
    }
  }

  async function zapisz(cfg) {
    const czysta = normalizuj(cfg);
    await chrome.storage.local.set({ [KLUCZ]: czysta });
    return czysta;
  }

  // Scalanie importu (jak w profilach Attribution Helpera: import DOKŁADA, nie kasuje).
  function scal(biezaca, importowana) {
    const a = normalizuj(biezaca);
    const b = normalizuj(importowana);
    const unikalne = (x, y) => Array.from(new Set(x.concat(y)));
    const wynik = {
      wersja: WERSJA,
      globalne: {
        serwerowe: unikalne(a.globalne.serwerowe, b.globalne.serwerowe),
        platformy: a.globalne.platformy.concat(b.globalne.platformy.filter((p) => !a.globalne.platformy.some((q) => q.id === p.id))),
        etykietyPikseli: Object.assign({}, a.globalne.etykietyPikseli, b.globalne.etykietyPikseli),
        statyczneHosty: unikalne(a.globalne.statyczneHosty, b.globalne.statyczneHosty),
        autoWykrywanieSgtm: b.globalne.autoWykrywanieSgtm,
        zbierajWlasneDomeny: b.globalne.zbierajWlasneDomeny,
        limitPozycji: b.globalne.limitPozycji,
      },
      profile: Object.assign({}, a.profile, b.profile),
      wymuszonyProfil: b.wymuszonyProfil || a.wymuszonyProfil,
    };
    return normalizuj(wynik);
  }

  // ------------------------------------------------------------------ wykryte kandydatury
  // Hosty, które wyglądają na kontener serwerowy, a nie ma ich w konfiguracji.
  // Strona opcji pokazuje je jako gotowe do dodania jednym kliknięciem.
  async function wczytajWykryte() {
    try {
      const dane = await chrome.storage.local.get(KLUCZ_WYKRYTE);
      return (dane && dane[KLUCZ_WYKRYTE]) || {};
    } catch (e) {
      return {};
    }
  }

  async function wyczyscWykryte() {
    await chrome.storage.local.remove(KLUCZ_WYKRYTE);
  }

  return {
    KLUCZ,
    KLUCZ_WYKRYTE,
    WERSJA,
    LIMIT_MAKS,
    DOMYSLNA,
    normalizuj,
    dlaHosta,
    nazwaProfiluDlaHosta,
    dopasujHost,
    dopasujDowolny,
    domenaRejestrowalna,
    wczytaj,
    zapisz,
    scal,
    wczytajWykryte,
    wyczyscWykryte,
  };
})();
