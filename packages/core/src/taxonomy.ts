import { tokenize } from './registry';

/** Task/capability domains. Shared by acquisition (classification) and the router (task analysis). */
export interface Domain {
  id: string;
  title: string;
  keywords: string[];
  /** Typical workflow stage this domain contributes. */
  stage: string;
}

export const DOMAINS: Domain[] = [
  { id: 'architecture', title: 'Architecture', stage: 'design', keywords: ['architecture', 'architect', 'system-design', 'scalable', 'scalability', 'microservices', 'monolith', 'ddd', 'domain-driven', 'adr', 'design-pattern', 'patterns', 'hexagonal', 'event-driven', 'cqrs'] },
  { id: 'frontend', title: 'Frontend', stage: 'build', keywords: ['frontend', 'front-end', 'react', 'vue', 'svelte', 'angular', 'nextjs', 'next.js', 'css', 'tailwind', 'html', 'component', 'components', 'ui', 'webgl', 'three.js', 'threejs', 'canvas', 'animation', 'browser', 'dom', 'spa', 'website', 'landing', 'web', 'interactive', 'configurator', '3d'] },
  { id: 'design', title: 'Design & UX', stage: 'design', keywords: ['design', 'ux', 'ui/ux', 'typography', 'layout', 'visual', 'brand', 'branding', 'figma', 'wireframe', 'prototype', 'usability', 'design-system', 'tokens', 'color', 'premium', 'aesthetic', 'accessibility', 'a11y', 'wcag'] },
  { id: 'backend', title: 'Backend', stage: 'build', keywords: ['backend', 'back-end', 'api', 'rest', 'graphql', 'grpc', 'server', 'endpoint', 'endpoints', 'express', 'fastapi', 'django', 'flask', 'rails', 'spring', 'nestjs', 'node', 'nodejs', 'service', 'webhook', 'auth', 'authentication', 'queue', 'saas'] },
  { id: 'database', title: 'Databases', stage: 'build', keywords: ['database', 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'schema', 'migration', 'migrations', 'query', 'orm', 'prisma', 'index', 'supabase', 'clickhouse'] },
  { id: 'testing', title: 'Testing & QA', stage: 'verify', keywords: ['test', 'tests', 'testing', 'tdd', 'qa', 'e2e', 'unit', 'integration', 'playwright', 'jest', 'vitest', 'pytest', 'coverage', 'regression', 'bug', 'debug', 'debugging', 'fix', 'failing'] },
  { id: 'security', title: 'Security', stage: 'verify', keywords: ['security', 'secure', 'vulnerability', 'vulnerabilities', 'owasp', 'threat', 'pentest', 'audit', 'injection', 'xss', 'csrf', 'secrets', 'encryption', 'hardening', 'compliance', 'sast'] },
  { id: 'devops', title: 'DevOps & SRE', stage: 'ship', keywords: ['devops', 'kubernetes', 'k8s', 'docker', 'container', 'ci', 'cd', 'ci/cd', 'pipeline', 'deploy', 'deployment', 'terraform', 'infrastructure', 'aws', 'azure', 'gcp', 'cloudflare', 'vercel', 'sre', 'observability', 'monitoring', 'helm', 'cluster'] },
  { id: 'performance', title: 'Performance', stage: 'verify', keywords: ['performance', 'optimize', 'optimization', 'latency', 'profiling', 'benchmark', 'core-web-vitals', 'lighthouse', 'memory', 'throughput', 'caching', 'cache', 'slow'] },
  { id: 'data', title: 'Data & Analytics', stage: 'build', keywords: ['data', 'dataset', 'analysis', 'analyze', 'analytics', 'pandas', 'numpy', 'statistics', 'visualization', 'chart', 'charts', 'dashboard', 'etl', 'spreadsheet', 'excel', 'csv', 'xlsx', 'notebook'] },
  { id: 'ai', title: 'AI & Agents', stage: 'build', keywords: ['ai', 'llm', 'agent', 'agents', 'mcp', 'prompt', 'prompts', 'rag', 'embedding', 'embeddings', 'model', 'fine-tune', 'claude', 'openai', 'anthropic', 'skill', 'skills', 'subagent', 'eval', 'evals'] },
  { id: 'research', title: 'Research', stage: 'research', keywords: ['research', 'investigate', 'investigation', 'literature', 'sources', 'survey', 'competitive', 'market', 'synthesis', 'fact-check', 'verify', 'citations'] },
  { id: 'docs', title: 'Documentation & Writing', stage: 'document', keywords: ['documentation', 'docs', 'readme', 'write', 'writing', 'technical-writing', 'changelog', 'tutorial', 'guide', 'article', 'blog', 'copy', 'docx', 'pdf', 'pptx', 'slides', 'report', 'memo', 'status', 'newsletter', 'announcement', 'communication', 'communications', 'email', 'summary', 'faq', 'release-notes'] },
  { id: 'product', title: 'Product & Business', stage: 'research', keywords: ['product', 'roadmap', 'prd', 'spec', 'requirements', 'stakeholder', 'strategy', 'pricing', 'marketing', 'seo', 'sales', 'startup', 'customer', 'growth'] },
  { id: 'finance', title: 'Finance', stage: 'research', keywords: ['finance', 'financial', 'investment', 'investing', 'stock', 'stocks', 'portfolio', 'trading', 'accounting', 'valuation', 'budget', 'invoice', 'tax'] },
  { id: 'mobile', title: 'Mobile', stage: 'build', keywords: ['mobile', 'ios', 'android', 'swift', 'swiftui', 'kotlin', 'flutter', 'react-native', 'expo', 'app-store'] },
  { id: 'automation', title: 'Automation & Workflow', stage: 'build', keywords: ['automation', 'automate', 'workflow', 'workflows', 'scraping', 'scrape', 'crawler', 'cron', 'schedule', 'integration', 'zapier', 'n8n', 'bot', 'git', 'github', 'commit', 'pull-request', 'pr', 'review', 'code-review', 'refactor', 'refactoring'] },
  { id: 'languages', title: 'Languages', stage: 'build', keywords: ['python', 'typescript', 'javascript', 'rust', 'go', 'golang', 'java', 'c#', 'csharp', 'c++', 'cpp', 'ruby', 'php', 'bash', 'shell', 'powershell'] },
];

export const STAGE_ORDER = ['research', 'design', 'build', 'verify', 'ship', 'document'];

/** Scores every domain against a text; returns matches sorted by score. */
export function scoreDomains(text: string): { id: string; score: number; matched: string[] }[] {
  const toks = new Set(tokenize(text.replace(/[-_/]/g, ' ')).concat(tokenize(text)));
  const out: { id: string; score: number; matched: string[] }[] = [];
  for (const d of DOMAINS) {
    const matched = d.keywords.filter((k) => toks.has(k) || (k.includes('-') && text.toLowerCase().includes(k)) || toks.has(k.replace(/s$/, '')));
    if (matched.length) out.push({ id: d.id, score: matched.length, matched });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const inferDomain = (text: string) => scoreDomains(text)[0]?.id ?? 'general';
export const domainById = (id: string) => DOMAINS.find((d) => d.id === id);
