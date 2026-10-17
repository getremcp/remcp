// ReMCP browser adapter: stable exports, split by endpoint policy, session, read and action.
export { browserAutoLaunchAvailable, browserRemoteEnabled, shouldRestoreBrowserSession, browserAutoLaunchArgs, browserControlAvailable, browserCapabilityAvailable, filterBrowserTargets, listBrowserTargets } from './browser-endpoint.mjs';
export { browserTabs, browserNavigate, browserSnapshot, findExpression } from './browser-read.mjs';
export { browserFind, browserActionLocatorText, browserActionInputValue, browserScrollDeltas, browserAction, browserWait, browserEvaluate, browserHandlers } from './browser-actions.mjs';
