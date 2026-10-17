// ReMCP cross-platform Desktop: stable public API, capability-specific modules.
export { boundedComputerSnapshot, listWindows, windowAction, uiSnapshot, uiAction, keyboard, pointer, clipboard, displayInventory, cursorPosition, screenshotRegion, notification, scroll } from './desktop-core.mjs';
export { uiFind, waitForUi, typeText, dragDrop, launchApp, openPath, revealPath } from './desktop-ui-actions.mjs';
export { mapOcrBoxToDesktop } from './desktop-vision.mjs';
export { computerSnapshot } from './desktop-computer-snapshot.mjs';
export { computerActionWindowTextArgs, computerAction, desktopHandlers } from './desktop-computer-actions.mjs';
