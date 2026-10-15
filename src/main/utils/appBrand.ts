import { APP_DISPLAY_NAME_DEFAULT } from "../../shared/types/settings";

/** 系统通知、窗口和渲染层共用显示名称；数据目录与密钥环继续使用历史身份。 */
export const APP_DISPLAY_NAME = APP_DISPLAY_NAME_DEFAULT;

/** Electron 的 Linux/macOS 密钥环标识源自旧运行时名，必须保留以解密既有凭据。 */
const LEGACY_KEYCHAIN_APP_NAME = "pi-desktop";

type AppBrandLifecycle = {
	setName: (name: string) => void;
	once: (event: "ready", listener: () => void) => unknown;
};

/**
 * 在 ready 前装配：Electron 在 PostCreateMainMessageLoop 快照密钥环名，随后才发 ready。
 * 此阶段保持历史标识；ready 时恢复品牌，窗口/菜单/通知不再显示 npm 的内部旧名。
 * 不能把改名提前到 ready 前，否则旧 safeStorage 密文和 Chromium Cookie 将失去原密钥。
 */
export function initializeAppBrand(app: AppBrandLifecycle, displayName: string = APP_DISPLAY_NAME): void {
	app.setName(LEGACY_KEYCHAIN_APP_NAME);
	app.once("ready", () => app.setName(displayName));
}
