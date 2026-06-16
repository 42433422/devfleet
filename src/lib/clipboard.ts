/** 复制文本到剪贴板，Clipboard API 不可用时回退 execCommand */

export async function copyToClipboard(text: string): Promise<void> {
  const value = String(text ?? '');
  if (!value) throw new Error('没有可复制的内容');

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 权限或安全上下文受限时回退
    }
  }

  fallbackCopy(value);
}

function fallbackCopy(text: string): void {
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持复制');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }

  if (!copied) {
    throw new Error('复制失败，请手动选中内容复制');
  }
}
