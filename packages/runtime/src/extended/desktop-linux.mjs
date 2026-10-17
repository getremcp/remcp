// ReMCP Linux Desktop backend: stable public exports split by capability.
export { parseX11PixelBounds, listWindows } from './desktop-linux-windows.mjs';
export { windowAction, uiSnapshot, uiAction } from './desktop-linux-ui.mjs';
export { clipboard, typeTextWindowTarget, typeTextFocused, keyboard, typeTextKeys, pointer, dragDrop, scroll, cursorPosition } from './desktop-linux-input.mjs';
export { parseWlrRandrOutput, parseXrandrDisplayOutput, resolveLinuxDisplayInventory, displayInventoryAvailable, displayInventory, regionScreenshotBackends, portalCropGeometry } from './desktop-linux-displays.mjs';
export { screenshotRegion, notification, launchApp, openPath, revealPath } from './desktop-linux-screen.mjs';
