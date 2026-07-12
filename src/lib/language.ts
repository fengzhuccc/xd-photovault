import i18next from 'i18next';

const STORAGE_KEY = 'i18n:lang';

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];

function isSupported(lang: string): lang is SupportedLanguage {
  return lang === 'zh' || lang === 'en';
}

export function detectInitialLanguage(): SupportedLanguage {
  if (typeof window === 'undefined') return 'zh';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && isSupported(stored)) return stored;
  const nav = navigator.language?.toLowerCase() ?? '';
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('en')) return 'en';
  return 'zh';
}

export async function getStoredLanguage(): Promise<SupportedLanguage> {
  const detected = detectInitialLanguage();
  try {
    const saved = await window.api?.config?.getLanguage();
    if (saved && isSupported(saved)) {
      if (saved !== detected) {
        window.localStorage.setItem(STORAGE_KEY, saved);
      }
      return saved;
    }
  } catch {
    // IPC unavailable (e.g. test env) — fall back to sync detection
  }
  return detected;
}

export async function setStoredLanguage(lang: SupportedLanguage): Promise<void> {
  window.localStorage.setItem(STORAGE_KEY, lang);
  try {
    await window.api?.config?.setLanguage(lang);
  } catch {
    // IPC unavailable — localStorage is still updated
  }
  await i18next.changeLanguage(lang);
}
