import { confirm } from '@/stores/confirmStore';

const KEY = 'photovault-trash-first-prompt-shown';

export async function confirmFirstTrashMove(): Promise<boolean> {
  if (localStorage.getItem(KEY)) {
    return true;
  }

  const ok = await confirm(
    '删除的照片会暂存到应用回收站，您可以随时还原或彻底删除。\n\n在回收站中点击“彻底删除”后，照片才会进入系统回收站。\n\n如需更改回收站位置，请前往“设置”。',
    { variant: 'info', confirmText: '我知道了' }
  );

  if (ok) {
    localStorage.setItem(KEY, '1');
  }

  return ok;
}
