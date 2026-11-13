/**
 * Fixture registry for the routing benchmark: 70 capabilities written in the style of real marketplace
 * skills, several per domain so that near neighbours compete. It is seeded into a temporary home; it is not
 * product data.
 */
export interface BenchCapability {
  id: string;
  name: string;
  description: string;
  domain: string;
  tags: string[];
}

const c = (name: string, domain: string, description: string, tags: string): BenchCapability => ({ id: `b.${name}`, name, description, domain, tags: tags.split(' ') });

export const BENCH_CAPABILITIES: BenchCapability[] = [
  // frontend
  c('react-patterns', 'frontend', 'React component patterns: hooks, state, context, composition and rendering behaviour. Use when building or refactoring React components.', 'react hooks components frontend'),
  c('vue-patterns', 'frontend', 'Vue 3 composition API patterns, reactivity and single-file components. Use when building Vue applications.', 'vue composition frontend'),
  c('nextjs-app-router', 'frontend', 'Next.js App Router: server components, routing, data fetching and caching. Use when working in a Next.js project.', 'nextjs next.js react server-components'),
  c('tailwind-styling', 'frontend', 'Tailwind CSS utility styling, responsive layout and theme configuration. Use when styling with Tailwind.', 'tailwind css styling'),
  c('webgl-three-scenes', 'frontend', 'Build WebGL scenes with three.js: cameras, lighting, materials, loaders and render loops. Use for 3D on the web.', 'webgl three.js threejs 3d'),
  c('web-animation-motion', 'frontend', 'Web animation with CSS transitions and motion libraries: easing, choreography, reduced motion. Use when adding animation to an interface.', 'animation motion transitions'),
  c('landing-page-builder', 'frontend', 'Build marketing landing pages: hero, sections, calls to action and responsive structure. Use when creating a landing page.', 'landing page marketing website'),
  // design
  c('design-system-tokens', 'design', 'Create a design system: tokens for color, spacing and type, component guidelines and theming. Use when establishing or extending a design system.', 'design-system tokens theming'),
  c('ux-heuristics-review', 'design', 'Review an interface against usability heuristics and report friction with severity. Use for a UX review of an existing interface.', 'ux usability heuristics'),
  c('accessibility-wcag-audit', 'design', 'Audit an interface for WCAG accessibility: contrast, keyboard access, focus order, labels and screen-reader behaviour.', 'accessibility a11y wcag'),
  c('typography-web', 'design', 'Typography for the web: type scales, pairing, measure, rhythm and font loading.', 'typography fonts type-scale'),
  c('brand-identity-guidelines', 'design', 'Develop brand identity guidelines: logo usage, palette, voice and visual language.', 'brand branding identity'),
  // backend
  c('rest-api-design', 'backend', 'Design REST APIs: resources, status codes, pagination, versioning and error format. Use when designing or reviewing an HTTP API.', 'rest api endpoints http'),
  c('graphql-schema-design', 'backend', 'Design GraphQL schemas, resolvers, pagination and federation. Use when building a GraphQL API.', 'graphql schema resolvers'),
  c('fastapi-service', 'backend', 'Build Python services with FastAPI: routers, dependency injection, pydantic models and async handlers.', 'fastapi python pydantic'),
  c('express-node-service', 'backend', 'Build Node.js services with Express: middleware, routing, validation and error handling.', 'express nodejs node middleware'),
  c('auth-oauth-jwt', 'backend', 'Implement authentication and authorization: OAuth 2, OpenID Connect, JWT sessions and role checks.', 'authentication oauth jwt authorization'),
  c('webhook-handlers', 'backend', 'Receive and verify webhooks: signatures, retries, idempotency and replay protection.', 'webhook webhooks idempotency'),
  // database
  c('postgres-schema-migrations', 'database', 'Design PostgreSQL schemas and write safe migrations: constraints, indexes, zero-downtime changes.', 'postgres postgresql schema migrations'),
  c('sql-query-optimization', 'database', 'Optimize slow SQL queries: read execution plans, add indexes, rewrite joins.', 'sql query indexes explain'),
  c('redis-caching', 'database', 'Use Redis for caching, rate limiting and queues: key design, expiry and invalidation.', 'redis cache caching'),
  c('mongodb-modeling', 'database', 'Model data in MongoDB: document design, embedding versus referencing, aggregation pipelines.', 'mongodb documents aggregation'),
  // testing
  c('unit-test-writing', 'testing', 'Write unit tests: arrange-act-assert, fixtures, mocks and edge cases. Use when adding tests to existing code.', 'unit tests testing mocks'),
  c('playwright-e2e', 'testing', 'End-to-end browser testing with Playwright: locators, fixtures, traces and flaky-test repair.', 'playwright e2e browser testing'),
  c('tdd-workflow', 'testing', 'Test-driven development: red, green, refactor. Use when implementing a feature test-first.', 'tdd test-driven red-green'),
  c('systematic-debugging', 'testing', 'Debug systematically: reproduce, isolate, form hypotheses, find the root cause before fixing. Use for a bug whose cause is unknown.', 'debugging debug root-cause'),
  // security
  c('owasp-security-review', 'security', 'Review code for security vulnerabilities against the OWASP Top 10: injection, XSS, CSRF, broken access control.', 'security owasp vulnerabilities xss'),
  c('threat-modeling-stride', 'security', 'Threat modeling with STRIDE: assets, trust boundaries, threats and mitigations. Use when designing or reviewing a system for security.', 'threat-modeling stride threats'),
  c('secrets-scanning', 'security', 'Find and remediate leaked secrets and credentials in code and history.', 'secrets credentials leaks'),
  c('dependency-vulnerability-audit', 'security', 'Audit third-party dependencies for known vulnerabilities and plan upgrades.', 'dependencies vulnerabilities cve supply-chain'),
  // devops
  c('kubernetes-operations', 'devops', 'Operate Kubernetes: deployments, services, autoscaling, helm charts and cluster troubleshooting.', 'kubernetes k8s helm cluster'),
  c('docker-containerization', 'devops', 'Containerize applications with Docker: multi-stage builds, image size and compose.', 'docker container dockerfile'),
  c('github-actions-ci', 'devops', 'Build CI/CD pipelines with GitHub Actions: workflows, caching, matrices and release jobs.', 'github-actions ci cd pipeline'),
  c('terraform-infrastructure', 'devops', 'Infrastructure as code with Terraform: modules, state and plans.', 'terraform infrastructure iac'),
  c('observability-monitoring', 'devops', 'Observability: structured logging, metrics, tracing, dashboards and alerts.', 'observability monitoring tracing metrics'),
  // performance
  c('web-performance-vitals', 'performance', 'Improve web performance and Core Web Vitals: LCP, CLS, INP, bundle size and loading strategy.', 'performance core-web-vitals lighthouse'),
  c('backend-profiling', 'performance', 'Profile backend services: CPU and memory profiling, latency analysis and throughput tuning.', 'profiling latency throughput memory'),
  // data
  c('pandas-data-analysis', 'data', 'Analyze datasets with pandas: cleaning, grouping, joins and summary statistics.', 'pandas dataset analysis statistics'),
  c('data-visualization-charts', 'data', 'Choose and build charts: chart type, encoding, labelling and accessible color.', 'visualization charts plots'),
  c('spreadsheet-xlsx', 'data', 'Create and edit spreadsheets: xlsx files, formulas, formatting and pivot tables.', 'spreadsheet excel xlsx'),
  c('etl-pipelines', 'data', 'Build ETL pipelines: extraction, transformation, loading, scheduling and data quality checks.', 'etl pipelines ingestion'),
  // ai
  c('prompt-engineering', 'ai', 'Write and improve prompts for language models: structure, examples and evaluation.', 'prompt prompts llm'),
  c('mcp-server-builder', 'ai', 'Build Model Context Protocol servers: tools, resources, transports and testing.', 'mcp model-context-protocol tools'),
  c('rag-pipeline', 'ai', 'Build retrieval-augmented generation: chunking, embeddings, retrieval and evaluation.', 'rag retrieval embeddings'),
  c('agent-evaluation', 'ai', 'Evaluate AI agents: task suites, graders, baselines and regression tracking.', 'evals evaluation agents'),
  c('skill-authoring', 'ai', 'Author agent skills: front matter, activation descriptions, structure and testing.', 'skill skills authoring'),
  // research
  c('deep-research-synthesis', 'research', 'Research a question across many sources, cross-check claims and write a cited synthesis.', 'research sources citations synthesis'),
  c('competitive-market-analysis', 'research', 'Analyze competitors and a market: positioning, features, pricing and gaps.', 'competitive market competitors'),
  // docs
  c('technical-docs-writing', 'docs', 'Write technical documentation: READMEs, guides, API references and tutorials.', 'documentation docs readme tutorial'),
  c('changelog-release-notes', 'docs', 'Write changelogs and release notes from merged changes.', 'changelog release-notes'),
  c('internal-comms-status', 'docs', 'Write internal communications: status updates, incident summaries, announcements and newsletters.', 'status update announcement newsletter communications'),
  c('pdf-documents', 'docs', 'Read, create and edit PDF documents: extract text and tables, merge, fill forms.', 'pdf documents forms'),
  c('slide-decks-pptx', 'docs', 'Create presentation slide decks as pptx: structure, layouts and speaker notes.', 'slides pptx presentation deck'),
  // product
  c('prd-writing', 'product', 'Write product requirement documents: problem, goals, requirements and success metrics.', 'prd requirements spec'),
  c('roadmap-planning', 'product', 'Plan a product roadmap: themes, sequencing, dependencies and trade-offs.', 'roadmap planning prioritization'),
  c('seo-optimization', 'product', 'Search engine optimization: technical SEO, metadata, structured data and content mapping.', 'seo search metadata'),
  c('pricing-strategy', 'product', 'Design pricing and packaging: value metrics, tiers and experiments.', 'pricing packaging tiers'),
  // finance
  c('financial-statements', 'finance', 'Prepare and analyze financial statements: income statement, balance sheet, cash flow.', 'financial accounting statements'),
  c('stock-valuation', 'finance', 'Value stocks: discounted cash flow, multiples and portfolio analysis.', 'stock stocks valuation portfolio'),
  // mobile
  c('react-native-app', 'mobile', 'Build mobile apps with React Native and Expo: navigation, native modules and release builds.', 'react-native expo mobile'),
  c('swiftui-ios', 'mobile', 'Build iOS interfaces with SwiftUI: views, state, navigation and animation.', 'swiftui ios swift'),
  // automation
  c('web-scraping', 'automation', 'Scrape websites: crawling, parsing, pagination, rate limits and anti-bot handling.', 'scraping scrape crawler'),
  c('git-workflow', 'automation', 'Git workflows: branching, rebasing, resolving conflicts and recovering lost work.', 'git branching rebase'),
  c('code-review-pr', 'automation', 'Review pull requests: correctness, design, tests and actionable comments.', 'code-review pull-request review'),
  c('refactoring-patterns', 'automation', 'Refactor code safely: extract, rename, simplify and remove duplication under test.', 'refactor refactoring cleanup'),
  // languages
  c('python-idioms', 'languages', 'Idiomatic Python: typing, dataclasses, iteration and error handling.', 'python typing idioms'),
  c('rust-ownership', 'languages', 'Rust ownership, borrowing, lifetimes and error handling.', 'rust ownership lifetimes'),
  c('typescript-types', 'languages', 'Advanced TypeScript types: generics, conditional and mapped types, narrowing.', 'typescript types generics'),
  c('azure-storage-queue-rust', 'languages', 'Azure Queue Storage library for Rust. Send, receive and manage queue messages.', 'azure rust queue storage'),
  c('go-concurrency', 'languages', 'Go concurrency: goroutines, channels, context and synchronization.', 'golang goroutines channels'),
  // architecture
  c('system-design-scalability', 'architecture', 'Design scalable systems: load, storage, caching, queues, consistency and failure modes.', 'system-design scalability architecture'),
  c('microservices-architecture', 'architecture', 'Microservices architecture: service boundaries, communication, resilience and data ownership.', 'microservices services architecture'),
  c('adr-decision-records', 'architecture', 'Write architecture decision records: context, decision, alternatives and consequences.', 'adr decision-records architecture'),
  c('domain-driven-design', 'architecture', 'Domain-driven design: bounded contexts, aggregates, domain events and ubiquitous language.', 'ddd domain-driven bounded-contexts'),
];
