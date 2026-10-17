import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as files from '../src/tools/files.mjs';

const modules = [
  'files.mjs', 'files-secure-paths.mjs', 'files-read-traversal.mjs',
  'files-write-edit.mjs', 'files-bulk-operations.mjs',
  'files-archive-safety.mjs', 'files-archive-actions.mjs',
  'files-screenshots.mjs',
];

test('filesystem operations preserve the exact public exports', () => {
  assert.deepEqual(Object.keys(files), [
    'applyPatchTool', 'archiveBackendAvailable', 'copyFileTool', 'copyPathsTool',
    'createArchiveTool', 'createDirectoryTool', 'deletePathTool', 'deletePathsTool',
    'diffFilesTool', 'editBlockTool', 'extractArchiveTool', 'fileToolHandlers',
    'getFileInfoTool', 'hashFileTool', 'listDirectoryTool', 'moveFileTool',
    'movePathsTool', 'moveToTrashTool', 'openDirectoryPath', 'openRegularFile',
    'readBinaryTool', 'readFileTool', 'readFilesTool', 'readImageTool',
    'readMultipleFilesTool', 'replaceInFilesTool', 'replaceLinesTool',
    'setPermissionsTool', 'takeScreenshotTool', 'tarEntrySize',
    'writeBinaryTool', 'writeFileTool', 'writeFilesTool', 'zipArchiveBackendAvailable',
  ]);
  assert.equal(Object.keys(files.fileToolHandlers).length, 28);
});

test('all seven filesystem capability modules fit within 500 lines', async () => {
  for (const name of modules) {
    const source = await readFile(new URL('../src/tools/' + name, import.meta.url), 'utf8');
    assert.ok(source.trimEnd().split(/\r?\n/).length <= 500, name);
  }
});
