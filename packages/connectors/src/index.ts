import path from 'node:path';
import type { DiscoveryConnector, Sys } from '@synaptome/core';
import { ConnectorRegistry } from '@synaptome/discovery';
import { createGitHubConnector } from './github';
import type { FetchLike } from './github-api';
import { createLocalClaudeConnector } from './local-host';
import { createMcpRegistryConnector } from './mcp-registry';
import { createBlockedConnector, createNpmConnector } from './npm';
import { OFFICIAL_SKILL_REPOS, createRepoListConnector, repositoryLinks } from './repo-list';

export * from './github-api';
export * from './github';
export * from './mcp-registry';
export * from './local-host';
export * from './npm';
export * from './repo-list';

/**
 * skills.sh is registered so its status is visible, but it is not queried: its robots.txt
 * (checked 2026-11-11) disallows /api/ and /search for automated agents. Skills listed there live
 * in GitHub repositories, which the GitHub connector reaches directly. See docs/DISCOVERY_SOURCES.md.
 */
export function createSkillsShConnector(): DiscoveryConnector {
  const blocked = 'not queried: skills.sh robots.txt disallows /api/ and /search for automated clients';
  return {
    id: 'skills-sh',
    kind: 'marketplace',
    title: 'skills.sh',
    description: 'Community skill directory. Registered but policy-blocked; no requests are made.',
    official: false,
    terms: { allowed: false, basis: 'robots.txt disallows /api/ and /search for automated clients', checkedAt: '2026-11-11' },
    async health() {
      return { ok: false, authenticated: false, detail: blocked };
    },
    async search() {
      throw new Error(blocked);
    },
    async fetchPackage() {
      throw new Error(blocked);
    },
  };
}

/** Composition root for discovery sources. Adding a source = one more register() call here. */
export function buildConnectorRegistry(sys: Sys, opts: { fetchImpl?: FetchLike; claudeRoot?: string; token?: string | null } = {}): ConnectorRegistry {
  const github = createGitHubConnector({ fetchImpl: opts.fetchImpl, token: opts.token, cacheDir: path.join(sys.paths.cache, 'github') });
  const curated = () => sys.settings().discovery.curatedLists;
  return new ConnectorRegistry()
    .register(github)
    .register(createMcpRegistryConnector({ fetchImpl: opts.fetchImpl }))
    .register(createLocalClaudeConnector({ claudeRoot: opts.claudeRoot }))
    .register(
      createRepoListConnector({
        id: 'official-skills',
        title: 'Official skill repositories',
        description: `Repositories published by vendors on the official-publisher list: ${OFFICIAL_SKILL_REPOS.join(', ')}.`,
        official: true,
        github,
        repos: async () => ({ repos: OFFICIAL_SKILL_REPOS, requests: 0, notes: [] }),
      }),
    )
    .register(
      createRepoListConnector({
        id: 'curated-lists',
        title: 'Curated lists',
        description: 'Repositories linked from curated "awesome" lists (setting discovery.curatedLists). Only the links are read from each list.',
        official: false,
        github,
        repos: async () => {
          const repos: string[] = [];
          const notes: string[] = [];
          let requests = 0;
          for (const list of curated()) {
            try {
              requests++;
              const md = String(await github.client.get<string>(`/repos/${list}/readme`, { accept: 'application/vnd.github.raw+json' }));
              const links = repositoryLinks(md, list);
              notes.push(`${list}: ${links.length} repository links`);
              repos.push(...links);
            } catch (e) {
              notes.push(`${list}: ${(e as Error).message}`);
            }
          }
          return { repos, requests, notes };
        },
      }),
    )
    .register(createNpmConnector({ fetchImpl: opts.fetchImpl }))
    .register(createSkillsShConnector())
    .register(createBlockedConnector({ id: 'gitlab', kind: 'code-host', title: 'GitLab', description: 'Public GitLab projects. Registered but policy-blocked; no requests are made.', basis: 'gitlab.com/robots.txt disallows /api/v* for all user agents', checkedAt: '2026-11-12' }))
    .register(createBlockedConnector({ id: 'pypi', kind: 'package-registry', title: 'PyPI', description: 'Python packages. Registered but policy-blocked; no requests are made.', basis: 'pypi.org/robots.txt disallows /pypi/*/json and /search for all user agents', checkedAt: '2026-11-12' }));
}
