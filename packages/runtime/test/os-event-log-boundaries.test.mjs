import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowsEventLogScript, macosEventLogPredicate } from '../src/extended/diagnostics-platform.mjs';

test('macOS event log excludes its own log show process but keeps legitimate matches', () => {
  const expression = macosEventLogPredicate('ReMCP "quote"');
  assert.equal(expression, 'eventMessage CONTAINS[c] "ReMCP \\"quote\\"" AND process != "log"');
});

test('Windows event log returns an empty array for NoMatchingEventsFound only', () => {
  const code = buildWindowsEventLogScript({ log:'Application', seconds:900, filter:'ReMCP', limit:4 });
  assert.match(code, /Get-WinEvent -FilterHashtable/);
  assert.match(code, /-ErrorAction Stop/);
  assert.match(code, /NoMatchingEventsFound,\*/);
  assert.match(code, /\{ '\[\]' \} else \{ throw \}/);
  assert.match(code, /Where-Object/);
  assert.doesNotMatch(code, /-ErrorAction SilentlyContinue/);
});

test('Windows event log escapes filter/log names and preserves bounded limits', () => {
  const code = buildWindowsEventLogScript({ log:"App'lication", seconds:35, filter:"O'Hare", limit:3 });
  assert.match(code, /LogName='App''lication'/);
  assert.match(code, /\*O''Hare\*/);
  assert.match(code, /AddSeconds\(-35\)/);
  assert.match(code, /Select-Object -First 3/);
});
