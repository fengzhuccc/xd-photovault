import i18next from '@/i18n';
import { confirm } from '@/stores/confirmStore';

const KEY = 'photovault-trash-first-prompt-shown';

export async function confirmFirstTrashMove(): Promise<boolean> {
  if (localStorage.getItem(KEY)) {
    return true;
  }

  const ok = await confirm(
    i18next.t('trashPrompt.message'),
    { variant: 'info', confirmText: i18next.t('trashPrompt.confirmText') }
  );

  if (ok) {
    localStorage.setItem(KEY, '1');
  }

  return ok;
}
