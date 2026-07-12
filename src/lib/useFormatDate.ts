import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

export function useFormatDate() {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';

  return useCallback(
    (
      date: string | Date | null | undefined,
      fallback = '—',
      options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
    ): string => {
      if (!date) return fallback;
      const d = typeof date === 'string' ? new Date(date) : date;
      if (Number.isNaN(d.getTime())) return fallback;
      return d.toLocaleDateString(locale, options);
    },
    [locale],
  );
}
