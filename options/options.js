// options/options.js — edytor konfiguracji. Formaty tekstowe są celowo proste, żeby dało się
// wkleić listę hostów prosto z panelu Stape czy GTM.
(() => {
  'use strict';
  const K = self.TDKonfiguracja;
  const A = self.TDAnaliza;

  let konfiguracja = K.normalizuj(null);
  let wykryte = {};

  const $ = (id) => document.getElementById(id);
  const el = (tag, klasa, tekst) => {
    const e = document.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst != null) e.textContent = String(tekst);
    return e;
  };

  function komunikat(tekst, klasa) {
    const s = $('stanZapisu');
    s.textContent = tekst;
    s.className = 'stan ' + (klasa || '');
    if (tekst) setTimeout(() => { if (s.textContent === tekst) s.textContent = ''; }, 4000);
  }

  // ---------------------------------------------------------------- formaty tekstowe
  const zListy = (t) => String(t || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const doListy = (a) => (a || []).join('\n');

  // "123456789 = Custom pixel: GTM + zgoda"
  function zEtykiet(t) {
    const out = {};
    for (const linia of String(t || '').split('\n')) {
      const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(linia);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
  const doEtykiet = (o) => Object.keys(o || {}).map((k) => k + ' = ' + o[k]).join('\n');

  // "Nazwa narzędzia | host1, host2 | format"
  function zPlatform(t) {
    const out = [];
    for (const linia of String(t || '').split('\n')) {
      if (!linia.trim()) continue;
      const czesci = linia.split('|').map((x) => x.trim());
      if (czesci.length < 2) continue;
      out.push({ etykieta: czesci[0], hosty: zListy(czesci[1]), format: czesci[2] || 'generic' });
    }
    return out;
  }
  const doPlatform = (a) => (a || []).map((p) => p.etykieta + ' | ' + (p.hosty || []).join(', ') + ' | ' + (p.format || 'generic')).join('\n');

  function pole(rodzic, etykieta, wskazowka, wartosc, przypnij) {
    const d = el('div', 'pole');
    d.appendChild(el('label', null, etykieta));
    d.appendChild(el('span', 'wskazowka', wskazowka));
    const ta = document.createElement('textarea');
    ta.value = wartosc || '';
    d.appendChild(ta);
    rodzic.appendChild(d);
    przypnij(ta);
    return ta;
  }

  const WSKAZOWKI = {
    serwerowe: 'Jeden host w wierszu. Wzorce: „dane.sklep.pl" obejmuje subdomeny, „*.sklep.pl" tylko subdomeny, „=dane.sklep.pl" dokładnie ten host.',
    platformy: 'Jeden wiersz na narzędzie: Nazwa | host1, host2 | format. Format: ' + A.FORMATY.join(', ') + ' (decyduje o rozbiciu parametrów).',
    etykiety: 'Jeden wiersz: identyfikator pixela = czytelna nazwa. Nazwy bierzesz z panelu sklepu (Shopify → Ustawienia → Zdarzenia klienta).',
    statyczne: 'Hosty traktowane jak zasoby statyczne — trafiają do licznika zamiast na listę. Jeden host w wierszu.',
    domeny: 'Domeny, na których ten profil ma być używany. Jeden host w wierszu; subdomeny obejmowane automatycznie.',
  };

  // ---------------------------------------------------------------- render
  function renderujGlobalne() {
    const box = $('globalne');
    box.replaceChildren();
    const g = konfiguracja.globalne;
    pole(box, 'Kontener serwerowy (sGTM)', WSKAZOWKI.serwerowe, doListy(g.serwerowe), (ta) => {
      ta.addEventListener('input', () => (g.serwerowe = zListy(ta.value)));
    });
    pole(box, 'Własne narzędzia pomiarowe', WSKAZOWKI.platformy, doPlatform(g.platformy), (ta) => {
      ta.addEventListener('input', () => (g.platformy = zPlatform(ta.value)));
    });
    pole(box, 'Etykiety pikseli', WSKAZOWKI.etykiety, doEtykiet(g.etykietyPikseli), (ta) => {
      ta.addEventListener('input', () => (g.etykietyPikseli = zEtykiet(ta.value)));
    });
    pole(box, 'Hosty do pominięcia (zasoby)', WSKAZOWKI.statyczne, doListy(g.statyczneHosty), (ta) => {
      ta.addEventListener('input', () => (g.statyczneHosty = zListy(ta.value)));
    });
  }

  function renderujProfile() {
    const box = $('profile');
    box.replaceChildren();
    const nazwy = Object.keys(konfiguracja.profile).sort();
    if (!nazwy.length) box.appendChild(el('p', 'opis', 'Brak profili. Bez profilu działają ustawienia globalne.'));
    for (const nazwa of nazwy) {
      const p = konfiguracja.profile[nazwa];
      const d = el('div', 'profil');
      const naglowek = el('div', 'naglowek');
      naglowek.appendChild(el('span', 'nazwa', nazwa));
      const opis = document.createElement('input');
      opis.type = 'text';
      opis.placeholder = 'opis (opcjonalny)';
      opis.value = p.opis || '';
      opis.addEventListener('input', () => (p.opis = opis.value));
      naglowek.appendChild(opis);
      naglowek.appendChild(el('span', 'spacer'));
      const usun = el('button', 'maly niebezpieczny', 'Usuń profil');
      usun.addEventListener('click', () => {
        delete konfiguracja.profile[nazwa];
        renderujProfile();
        renderujWyborProfilu();
      });
      naglowek.appendChild(usun);
      d.appendChild(naglowek);

      pole(d, 'Domeny', WSKAZOWKI.domeny, doListy(p.domeny), (ta) => ta.addEventListener('input', () => (p.domeny = zListy(ta.value))));
      pole(d, 'Kontener serwerowy (sGTM)', WSKAZOWKI.serwerowe, doListy(p.serwerowe), (ta) => ta.addEventListener('input', () => (p.serwerowe = zListy(ta.value))));
      pole(d, 'Własne narzędzia pomiarowe', WSKAZOWKI.platformy, doPlatform(p.platformy), (ta) => ta.addEventListener('input', () => (p.platformy = zPlatform(ta.value))));
      pole(d, 'Etykiety pikseli', WSKAZOWKI.etykiety, doEtykiet(p.etykietyPikseli), (ta) => ta.addEventListener('input', () => (p.etykietyPikseli = zEtykiet(ta.value))));
      box.appendChild(d);
    }
  }

  function renderujWyborProfilu() {
    const sel = $('wymuszonyProfil');
    sel.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'automatycznie (po domenie karty)';
    sel.appendChild(auto);
    for (const nazwa of Object.keys(konfiguracja.profile).sort()) {
      const o = document.createElement('option');
      o.value = nazwa;
      o.textContent = nazwa;
      sel.appendChild(o);
    }
    sel.value = konfiguracja.wymuszonyProfil || '';
  }

  function renderujZachowanie() {
    $('autoWykrywanieSgtm').checked = konfiguracja.globalne.autoWykrywanieSgtm !== false;
    $('zbierajWlasneDomeny').checked = konfiguracja.globalne.zbierajWlasneDomeny !== false;
    $('limitPozycji').value = konfiguracja.globalne.limitPozycji || K.DOMYSLNA.globalne.limitPozycji;
  }

  function renderujWykryte() {
    const box = $('wykryte');
    box.replaceChildren();
    const wpisy = Object.values(wykryte).sort((a, b) => b.liczba - a.liczba);
    const juzZnane = (host) => {
      if (K.dopasujDowolny(konfiguracja.globalne.serwerowe, host)) return true;
      for (const nazwa of Object.keys(konfiguracja.profile)) {
        if (K.dopasujDowolny(konfiguracja.profile[nazwa].serwerowe, host)) return true;
      }
      return false;
    };
    const doPokazania = wpisy.filter((w) => !juzZnane(w.host));
    if (!doPokazania.length) {
      box.appendChild(el('p', 'pusto', 'Nic nowego. Wejdź na badany sklep z otwartym panelem — kandydaci pojawią się tutaj automatycznie.'));
      return;
    }
    for (const w of doPokazania) {
      const d = el('div', 'wpis');
      d.appendChild(el('span', 'host', w.host));
      if (w.pierwszaStrona) d.appendChild(el('span', 'znacznik pierwsza', 'domena strony'));
      d.appendChild(el('span', 'szczegol', 'żądań: ' + w.liczba + ' · ścieżki: ' + Object.keys(w.sciezki || {}).join(', ')));
      const dodajGlobalnie = el('button', 'maly', 'Dodaj globalnie');
      dodajGlobalnie.addEventListener('click', () => {
        if (!konfiguracja.globalne.serwerowe.includes(w.host)) konfiguracja.globalne.serwerowe.push(w.host);
        renderujGlobalne();
        renderujWykryte();
        komunikat('Dodano ' + w.host + ' — pamiętaj o zapisaniu.', 'ok');
      });
      d.appendChild(dodajGlobalnie);
      const nazwyProfili = Object.keys(konfiguracja.profile).sort();
      if (nazwyProfili.length) {
        const sel = document.createElement('select');
        const pusty = document.createElement('option');
        pusty.value = '';
        pusty.textContent = 'dodaj do profilu…';
        sel.appendChild(pusty);
        for (const nazwa of nazwyProfili) {
          const o = document.createElement('option');
          o.value = nazwa;
          o.textContent = nazwa;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          const nazwa = sel.value;
          if (!nazwa) return;
          const p = konfiguracja.profile[nazwa];
          if (!p.serwerowe.includes(w.host)) p.serwerowe.push(w.host);
          renderujProfile();
          renderujWykryte();
          komunikat('Dodano ' + w.host + ' do profilu ' + nazwa + ' — pamiętaj o zapisaniu.', 'ok');
        });
        d.appendChild(sel);
      }
      box.appendChild(d);
    }
  }

  function renderujWszystko() {
    renderujWykryte();
    renderujWyborProfilu();
    renderujProfile();
    renderujGlobalne();
    renderujZachowanie();
  }

  // ---------------------------------------------------------------- akcje
  function zbierzZachowanie() {
    konfiguracja.globalne.autoWykrywanieSgtm = $('autoWykrywanieSgtm').checked;
    konfiguracja.globalne.zbierajWlasneDomeny = $('zbierajWlasneDomeny').checked;
    const limit = Number($('limitPozycji').value);
    if (limit > 0) konfiguracja.globalne.limitPozycji = Math.min(K.LIMIT_MAKS, Math.max(100, Math.round(limit)));
    konfiguracja.wymuszonyProfil = $('wymuszonyProfil').value || null;
  }

  $('btnZapisz').addEventListener('click', async () => {
    zbierzZachowanie();
    try {
      konfiguracja = await K.zapisz(konfiguracja);
      renderujWszystko();
      komunikat('Zapisano. Panel podłapie zmianę od razu, bez przeładowania rozszerzenia.', 'ok');
    } catch (e) {
      komunikat('Nie udało się zapisać: ' + e.message, 'blad');
    }
  });

  $('btnDodajProfil').addEventListener('click', () => {
    const nazwa = $('nazwaNowegoProfilu').value.trim();
    if (!nazwa) return komunikat('Podaj nazwę profilu.', 'blad');
    if (konfiguracja.profile[nazwa]) return komunikat('Profil o tej nazwie już istnieje.', 'blad');
    konfiguracja.profile[nazwa] = { domeny: [], serwerowe: [], platformy: [], etykietyPikseli: {}, statyczneHosty: [], opis: '' };
    $('nazwaNowegoProfilu').value = '';
    renderujProfile();
    renderujWyborProfilu();
  });

  $('btnOdswiezWykryte').addEventListener('click', async () => {
    wykryte = await K.wczytajWykryte();
    renderujWykryte();
  });

  $('btnWyczyscWykryte').addEventListener('click', async () => {
    await K.wyczyscWykryte();
    wykryte = {};
    renderujWykryte();
    komunikat('Lista wyczyszczona.', 'ok');
  });

  $('btnEksport').addEventListener('click', () => {
    zbierzZachowanie();
    const tresc = JSON.stringify(konfiguracja, null, 2);
    const blob = new Blob([tresc], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tracking-debugger-konfiguracja.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('btnImport').addEventListener('click', () => $('plikImportu').click());
  $('plikImportu').addEventListener('change', async (e) => {
    const plik = e.target.files && e.target.files[0];
    if (!plik) return;
    try {
      const tekst = await plik.text();
      const dane = JSON.parse(tekst);
      zbierzZachowanie();
      konfiguracja = K.scal(konfiguracja, dane);
      konfiguracja = await K.zapisz(konfiguracja);
      renderujWszystko();
      komunikat('Zaimportowano i zapisano.', 'ok');
    } catch (err) {
      komunikat('Nieprawidłowy plik: ' + err.message, 'blad');
    }
    e.target.value = '';
  });

  $('btnReset').addEventListener('click', async () => {
    if (!confirm('Przywrócić ustawienia domyślne? Profile i własne narzędzia zostaną usunięte.')) return;
    konfiguracja = await K.zapisz(K.normalizuj(null));
    renderujWszystko();
    komunikat('Przywrócono ustawienia domyślne.', 'ok');
  });

  // ---------------------------------------------------------------- start
  (async () => {
    konfiguracja = await K.wczytaj();
    wykryte = await K.wczytajWykryte();
    renderujWszystko();
  })();
})();
