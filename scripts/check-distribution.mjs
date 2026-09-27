#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson('package.json');
const agentPlugin = readJson('plugin.json');
const agentMcp = readJson('mcp.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const cursorPlugin = readJson('.cursor-plugin/plugin.json');
const claudeMcp = readJson('.mcp.json');
const gemini = readJson('gemini-extension.json');
const registry = readJson('server.json');
const glama = readJson('glama.json');
const codexMarketplace = readJson('.agents/plugins/marketplace.json');
const copilotMarketplace = readJson('.github/plugin/marketplace.json');

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

const endpoint = 'https://remcp.site/mcp';
const version = pkg.version;

check(agentPlugin.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'plugin.json must stay Agent Plugins 1.0');
check(agentPlugin.name === 'remcp', 'plugin.json name must stay remcp');
check(agentPlugin.version === version, 'plugin.json version must match package.json');
check(agentMcp?.mcpServers?.remcp?.url === endpoint, 'mcp.json must point at the production MCP endpoint');

check(cursorPlugin.name === 'remcp', 'Cursor plugin name must stay remcp');
check(cursorPlugin.displayName === 'ReMCP', 'Cursor plugin displayName must stay ReMCP');
check(cursorPlugin.version === version, 'Cursor plugin version must match package.json');
check(cursorPlugin.publisher === 'ReMCP', 'Cursor plugin publisher must stay ReMCP');
check(cursorPlugin.homepage === 'https://remcp.site', 'Cursor plugin homepage must point at remcp.site');
check(cursorPlugin.repository === 'https://github.com/antonbaider/remcp', 'Cursor plugin repository must point at the canonical public repo');
check(cursorPlugin.logo === 'assets/remcp-marketplace-400.png', 'Cursor plugin must use the committed marketplace logo');
check(cursorPlugin.skills === './skills/', 'Cursor plugin must expose the bundled skills');
check(cursorPlugin.mcpServers === './mcp.json', 'Cursor plugin must expose the production MCP config');
check(cursorPlugin.category === 'developer-tools', 'Cursor plugin category must stay developer-tools');

check(claudePlugin.version === version, 'Claude plugin version must match package.json');
check(claudeMcp?.mcpServers?.remcp?.url === endpoint, 'Claude MCP config must point at the production MCP endpoint');

check(gemini.name === 'remcp', 'Gemini extension name must be remcp');
check(gemini.version === version, 'Gemini extension version must match package.json');
check(gemini?.mcpServers?.remcp?.httpUrl === endpoint, 'Gemini extension must point at the production Streamable HTTP endpoint');
check(!('url' in (gemini?.mcpServers?.remcp || {})), 'Gemini extension must not declare the Streamable HTTP endpoint as an SSE url');
check(gemini?.mcpServers?.remcp?.authProviderType === 'dynamic_discovery', 'Gemini extension must use OAuth dynamic discovery');

check(registry.name === 'io.github.getremcp/remcp', 'MCP Registry name must stay in the GitHub-authenticated namespace');
check(registry.version === version, 'MCP Registry server version must match package.json');
check(registry?.repository?.url === 'https://github.com/antonbaider/remcp', 'MCP Registry repository must point at the public repo');
check(registry?.remotes?.length === 1, 'MCP Registry record must expose exactly one production remote');
check(registry?.remotes?.[0]?.type === 'streamable-http', 'MCP Registry remote must use Streamable HTTP');
check(registry?.remotes?.[0]?.url === endpoint, 'MCP Registry remote must point at the production MCP endpoint');

check(glama.$schema === 'https://glama.ai/mcp/schemas/server.json', 'glama.json must use the official Glama server schema');
check(Array.isArray(glama.maintainers) && glama.maintainers.includes('antonbaider'), 'glama.json must keep antonbaider as a maintainer');

check(codexMarketplace.name === 'remcp', 'Codex marketplace name must be remcp');
check(codexMarketplace?.interface?.displayName === 'ReMCP', 'Codex marketplace display name must be ReMCP');
check(codexMarketplace?.plugins?.length === 1, 'Codex marketplace must expose exactly one ReMCP plugin');
check(codexMarketplace?.plugins?.[0]?.name === 'remcp', 'Codex marketplace plugin name must be remcp');
check(codexMarketplace?.plugins?.[0]?.source?.source === 'local', 'Codex marketplace must use a local source for this repository');
check(codexMarketplace?.plugins?.[0]?.source?.path === './', 'Codex marketplace must source the root Agent Plugin');
check(codexMarketplace?.plugins?.[0]?.category === 'Developer Tools', 'Codex marketplace category must stay Developer Tools');

check(copilotMarketplace.name === 'remcp', 'Copilot marketplace name must be remcp');
check(copilotMarketplace?.metadata?.version === version, 'Copilot marketplace version must match package.json');
check(copilotMarketplace?.plugins?.length === 1, 'Copilot marketplace must expose exactly one ReMCP plugin');
check(copilotMarketplace?.plugins?.[0]?.name === 'remcp', 'Copilot marketplace plugin name must be remcp');
check(copilotMarketplace?.plugins?.[0]?.source === './', 'Copilot marketplace must source the root Agent Plugin');
check(copilotMarketplace?.plugins?.[0]?.version === version, 'Copilot marketplace plugin version must match package.json');

if (problems.length) {
  console.error('distribution check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`distribution contracts OK: Agent Plugins, Cursor, Codex marketplace, Claude Code, Gemini CLI, MCP Registry, Copilot/VS Code (v${version})`);
