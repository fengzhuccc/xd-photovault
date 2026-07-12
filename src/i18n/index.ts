import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import { detectInitialLanguage } from '@/lib/language';

const initialLanguage = detectInitialLanguage();

void i18next.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initialLanguage,
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

export default i18next;
