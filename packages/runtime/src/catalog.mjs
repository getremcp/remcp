import { archiveBackendAvailable, TEXT_OUTPUT_SCHEMA } from './core-catalog-shared.mjs';
import { coreToolDefinitionsPart1 } from './core-catalog-part1.mjs';
import { coreToolDefinitionsPart2 } from './core-catalog-part2.mjs';
export { TEXT_OUTPUT_SCHEMA };

export const toolDefinitions = [...coreToolDefinitionsPart1, ...coreToolDefinitionsPart2];


export function coreToolSupported(definition, {
  platform = process.platform,
  archiveAvailable = platform === 'win32' ? archiveBackendAvailable({ platform }) : true,
} = {}) {
  if (!['create_archive', 'extract_archive'].includes(definition.name)) return true;
  if (platform === 'linux' || platform === 'darwin') return true;
  return platform === 'win32' && archiveAvailable === true;
}

export function supportedCoreTools() {
  const archiveAvailable = process.platform === 'win32' ? archiveBackendAvailable({ platform:process.platform }) : true;
  return toolDefinitions.filter(definition => coreToolSupported(definition, { platform:process.platform, archiveAvailable }));
}

export function advertisedTools() {
  return toolDefinitions.map(({ name, title, description, inputSchema, annotations, outputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
    outputSchema: outputSchema || TEXT_OUTPUT_SCHEMA,
  }));
}

export const toolHandlers = new Map(toolDefinitions.map(definition => [definition.name, definition]));
