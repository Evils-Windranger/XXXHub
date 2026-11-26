import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tr } from "../i18n";

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error(tr("当前环境不支持复制，请在应用中重试"));
  }
  await navigator.clipboard.writeText(text);
}

export async function pasteText(): Promise<string> {
  if (isTauri()) {
    try {
      return (await readText()) ?? "";
    } catch (error) {
      if (navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
      throw error;
    }
  }
  if (!navigator.clipboard?.readText) {
    throw new Error(tr("当前环境不支持读取剪贴板，请手动粘贴"));
  }
  return await navigator.clipboard.readText();
}
