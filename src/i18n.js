'use strict';

// Sistema di gestione traduzioni
class I18n {
  constructor() {
    this.translations = {};
    this.currentLanguage = localStorage.getItem('language') || 'it';
    this.defaultLanguage = 'it';
  }

  async load() {
    try {
      const response = await fetch('../src/translations.json');
      this.translations = await response.json();
    } catch (e) {
      console.error('Errore caricamento traduzioni:', e);
      this.translations = {};
    }
  }

  /** Traduce una chiave con supporto per sostituzioni {key: value} */
  t(key, replacements = {}) {
    const entry = this.translations[key];
    if (!entry) {
      console.warn(`Chiave di traduzione mancante: ${key}`);
      return key;
    }

    let text = entry[this.currentLanguage] || entry[this.defaultLanguage] || key;

    // sostituisci i placeholder {chiave} con i valori
    Object.entries(replacements).forEach(([k, v]) => {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    });

    return text;
  }

  setLanguage(lang) {
    this.currentLanguage = lang;
    localStorage.setItem('language', lang);
  }

  getLanguage() {
    return this.currentLanguage;
  }

  getAvailableLanguages() {
    return ['it', 'en', 'es', 'fr', 'de', 'pt'];
  }

  getLanguageName(lang) {
    const names = {
      it: this.t('settings_language_italian'),
      en: this.t('settings_language_english'),
      es: this.t('settings_language_spanish'),
      fr: this.t('settings_language_french'),
      de: this.t('settings_language_german'),
      pt: this.t('settings_language_portuguese'),
    };
    return names[lang] || lang;
  }
}

const i18n = new I18n();
