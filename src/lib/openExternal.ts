/** 尝试通过 Tauri 在外部打开链接 */
async function tryTauriOpenExternal(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_external_url', { url });
}

/** 打开 Trae MCP 安装链接（自动识别 Trae CN / 国际版） */
export async function openTraeInstall(deeplinkCn: string, deeplinkIntl: string): Promise<string> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('open_trae_install', {
      deeplinkCn,
      deeplinkIntl,
    });
  } catch (error) {
    const cnError = await openDeeplink(deeplinkCn);
    if (!cnError) return 'Trae CN';
    const intlError = await openDeeplink(deeplinkIntl);
    if (!intlError) return 'Trae';
    throw error instanceof Error ? error : new Error(cnError || intlError || '无法打开 Trae');
  }
}

function triggerDeeplinkClick(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.style.display = 'none';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function openExternalUrl(url: string): Promise<void> {
  const target = url.trim();
  if (!target) return;

  try {
    await tryTauriOpenExternal(target);
    return;
  } catch {
    // 浏览器环境回退
  }

  const isCustomScheme = /^(trae-cn|trae|cursor):/i.test(target);
  if (isCustomScheme) {
    triggerDeeplinkClick(target);
    return;
  }

  window.open(target, '_blank', 'noopener,noreferrer');
}

/** 打开 deeplink；返回 null 表示成功，否则为错误信息 */
export async function openDeeplink(deeplink: string, webFallback?: string): Promise<string | null> {
  try {
    await tryTauriOpenExternal(deeplink);
    if (webFallback) {
      window.setTimeout(() => {
        void openExternalUrl(webFallback);
      }, 1200);
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法打开应用';
    if (webFallback) {
      try {
        await openExternalUrl(webFallback);
        return null;
      } catch {
        return message;
      }
    }
    return message;
  }
}
