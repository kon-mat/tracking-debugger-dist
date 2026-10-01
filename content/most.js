// content/most.js — świat izolowany rozszerzenia. Jedyne zadanie: odebrać rekordy z content/sonda.js
// (świat strony) i przekazać je do service workera.
//
// Ramki podrzędne (sandboksy pixeli) przekazują swoje rekordy do ramki głównej przez
// window.top.postMessage i dopiero stamtąd tutaj. Jedna droga = brak duplikatów.
//
// Mostek musi dać się ZAINSTALOWAĆ PONOWNIE. Po przeładowaniu rozszerzenia stary uchwyt zostaje
// w izolowanym świecie, ale jego `chrome.runtime` jest już nieważny — każdy rekord ginie po cichu.
// Dlatego przy ponownym wejściu podmieniamy uchwyt zamiast odpuszczać, a sondzie mówimy, że most
// znowu żyje, żeby zameldowała się jeszcze raz (bez tego Diagnostyka uznałaby dokument za ślepy).
(() => {
  'use strict';

  const poprzedni = window.__tdMost;
  if (poprzedni && poprzedni.uchwyt) {
    try {
      document.removeEventListener('__td_przechwyt', poprzedni.uchwyt);
      document.removeEventListener('__td_sonda_gotowa', poprzedni.oglos);
    } catch (e) {}
  }

  const uchwyt = (ev) => {
    let rekord;
    try {
      rekord = JSON.parse(ev.detail);
    } catch (e) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ typ: 'przechwyt', rekord }, () => void chrome.runtime.lastError);
    } catch (e) {
      // Kontekst rozszerzenia unieważniony (przeładowanie rozszerzenia). Nowy mostek wejdzie
      // przy starcie service workera (tlo.js → odzyskajSonde) i podmieni ten uchwyt.
    }
  };

  const oglos = () => {
    try {
      document.dispatchEvent(new CustomEvent('__td_most_gotowy'));
    } catch (e) {}
  };

  document.addEventListener('__td_przechwyt', uchwyt);
  document.addEventListener('__td_sonda_gotowa', oglos);
  window.__tdMost = { uchwyt, oglos, odKiedy: Date.now() };
  oglos();
})();
