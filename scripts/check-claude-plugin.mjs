#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = relative => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const problems = [];
const requireValue = (condition, message) => {
  if (!condition) problems.push(message);
};

const pkg = readJson('package.json');
const openAiPlugin = readJson('plugin.json');
const openAiMcp = readJson('mcp.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
const claudeMcp = readJson('.mcp.json');

requireValue(claudePlugin.name === 'remcp', 'Claude plugin name must be remcp');
requireValue(claudePlugin.displayName === 'ReMCP', 'Claude displayName must be ReMCP');
requireValue(claudePlugin.version === pkg.version, 'Claude plugin version must match package.json');
requireValue(openAiPlugin.version === pkg.version, 'OpenAI plugin version must still match package.json');
requireValue(claudePlugin.repository === 'https://github.com/antonbaider/remcp', 'Claude repository must point at the public repository');
requireValue(claudePlugin.homepage === 'https://remcp.site', 'Claude homepage must point at remcp.site');
requireValue(claudePlugin.license === 'MIT', 'Claude plugin license must be MIT');

requireValue(claudeMarketplace.name === 'remcp', 'Claude marketplace name must be remcp');
requireValue(claudeMarketplace.owner?.name === claudePlugin.author?.name, 'Claude marketplace owner must match plugin author');
requireValue(Array.isArray(claudeMarketplace.plugins) && claudeMarketplace.plugins.length === 1, 'Claude marketplace must contain exactly one plugin');
const marketplacePlugin = claudeMarketplace.plugins?.[0];
requireValue(marketplacePlugin?.name === claudePlugin.name, 'Claude marketplace plugin name must match plugin.json');
requireValue(marketplacePlugin?.displayName === claudePlugin.displayName, 'Claude marketplace displayName must match plugin.json');
requireValue(marketplacePlugin?.source === './', 'Claude marketplace must install the plugin from repository root');
requireValue(marketplacePlugin?.repository === claudePlugin.repository, 'Claude marketplace repository must match plugin.json');
requireValue(marketplacePlugin?.homepage === 'https://remcp.site/install/claude', 'Claude marketplace homepage must point at the Claude install guide');
requireValue(marketplacePlugin?.license === claudePlugin.license, 'Claude marketplace license must match plugin.json');

const claudeServer = claudeMcp?.mcpServers?.remcp;
const openAiServer = openAiMcp?.mcpServers?.remcp;
requireValue(claudeServer?.type === 'http', 'Claude MCP transport must use the recommended http type');
requireValue(claudeServer?.url === 'https://remcp.site/mcp', 'Claude MCP URL must be the production ReMCP endpoint');
requireValue(openAiServer?.url === claudeServer?.url, 'Claude and OpenAI MCP configs must use the same production endpoint');
requireValue(
  openAiServer?.type === 'streamable-http' || openAiServer?.type === 'http',
  'Existing OpenAI MCP transport must remain Streamable HTTP compatible',
);

const skillRoot = path.join(root, 'skills');
for (const entry of readdirSync(skillRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const relative = `skills/${entry.name}/SKILL.md`;
  const absolute = path.join(root, relative);
  requireValue(existsSync(absolute), `${relative} is missing`);
  if (!existsSync(absolute)) continue;
  const source = readFileSync(absolute, 'utf8');
  const frontmatterEnd = source.indexOf('\n---\n', 4);
  const frontmatter = source.startsWith('---\n') && frontmatterEnd !== -1
    ? source.slice(4, frontmatterEnd)
    : '';
  requireValue(/^description:\s*.+$/m.test(frontmatter), `${relative} needs YAML frontmatter with a description`);
}

if (problems.length) {
  console.error('Claude Code plugin check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Claude Code plugin contract OK (version ${pkg.version}, ${Object.keys(claudeMcp.mcpServers).length} MCP server, ${readdirSync(skillRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).length} skills)`);
