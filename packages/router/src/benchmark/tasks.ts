/**
 * Labelled tasks for the routing benchmark.
 *
 * `expect` lists the needs of the task; each need is satisfied by any one of its alternatives.
 * `allow` lists further capabilities that are reasonable but not required. Anything else selected is wrong.
 * A task with no `expect` must select nothing. `forbid` names capabilities that look related by keyword and
 * must not be selected.
 *
 * Limits, stated plainly: the tasks and the fixture registry were written by the same author as the router.
 * To keep that from flattering the result, a fixed quarter of the tasks is held out (never looked at while
 * tuning, see `isHeldOut`), many tasks avoid the capability's own name, and the "no capability" and
 * "must not activate" groups are built from keywords the registry does contain.
 */
export type BenchCategory = 'simple' | 'engineering' | 'design' | 'research' | 'multi-domain' | 'planning' | 'no-capability' | 'trivial-admin-meta' | 'must-not-activate';

export interface BenchTask {
  id: string;
  category: BenchCategory;
  task: string;
  expect: string[][];
  allow: string[];
  forbid: string[];
}

let n = 0;
const t = (category: BenchCategory, task: string, expect: string[][] = [], extra: { allow?: string[]; forbid?: string[] } = {}): BenchTask => ({
  id: `t${String(++n).padStart(3, '0')}`,
  category,
  task,
  expect: expect.map((slot) => slot.map((x) => `b.${x}`)),
  allow: (extra.allow ?? []).map((x) => `b.${x}`),
  forbid: (extra.forbid ?? []).map((x) => `b.${x}`),
});

export const BENCH_TASKS: BenchTask[] = [
  /* ---------- simple: one clear need ---------- */
  t('simple', 'Write unit tests for the invoice total calculation, including rounding edge cases', [['unit-test-writing']], { allow: ['tdd-workflow'] }),
  t('simple', 'Add a Playwright end-to-end test for the checkout flow in the browser', [['playwright-e2e']]),
  t('simple', 'Containerize this Flask service with a small multi-stage Docker image', [['docker-containerization']]),
  t('simple', 'Set up a GitHub Actions workflow that runs lint and tests on every pull request', [['github-actions-ci']]),
  t('simple', 'Our Postgres migration needs to add a NOT NULL column without downtime', [['postgres-schema-migrations']]),
  t('simple', 'This SQL query takes 14 seconds; read the execution plan and add the right indexes', [['sql-query-optimization']], { allow: ['postgres-schema-migrations'] }),
  t('simple', 'Add Redis caching with sensible expiry in front of the product catalog endpoint', [['redis-caching']]),
  t('simple', 'Verify the Stripe webhook signature and make the handler idempotent', [['webhook-handlers']]),
  t('simple', 'Implement OAuth login with JWT sessions and role checks for the admin area', [['auth-oauth-jwt']]),
  t('simple', 'Build a three.js scene with orbit controls, lighting and a GLTF model loader', [['webgl-three-scenes']]),
  t('simple', 'Convert these class components to React hooks and clean up the state handling', [['react-patterns']], { allow: ['refactoring-patterns'] }),
  t('simple', 'Migrate the page to the Next.js App Router with server components and cached fetches', [['nextjs-app-router']], { allow: ['react-patterns'] }),
  t('simple', 'Write release notes and a changelog entry for the changes merged this sprint', [['changelog-release-notes']]),
  t('simple', 'Write a 3P status update for the leadership team about the billing migration', [['internal-comms-status']]),
  t('simple', 'Extract the tables from this PDF and fill in the attached form', [['pdf-documents']]),
  t('simple', 'Create a pptx slide deck with speaker notes for the quarterly review', [['slide-decks-pptx']]),
  t('simple', 'Build an xlsx spreadsheet with formulas and a pivot table for these sales figures', [['spreadsheet-xlsx']]),
  t('simple', 'Clean this dataset with pandas, group by region and report summary statistics', [['pandas-data-analysis']]),
  t('simple', 'Scrape the product listings across all paginated pages while respecting rate limits', [['web-scraping']]),
  t('simple', 'Help me rebase my branch and resolve the merge conflicts without losing commits', [['git-workflow']]),
  t('simple', 'Build an MCP server that exposes two tools over stdio and test it', [['mcp-server-builder']]),
  t('simple', 'Set up a RAG pipeline: chunk the docs, embed them and evaluate retrieval quality', [['rag-pipeline']], { allow: ['agent-evaluation'] }),
  t('simple', 'Explain why the borrow checker rejects this Rust function and fix the lifetimes', [['rust-ownership']]),
  t('simple', 'Write a conditional mapped TypeScript type that makes selected keys optional', [['typescript-types']]),
  t('simple', 'Fix the goroutine leak: the channel is never closed when the context is cancelled', [['go-concurrency']], { allow: ['systematic-debugging'] }),
  t('simple', 'Write a Terraform module for the VPC and review the plan output', [['terraform-infrastructure']]),
  t('simple', 'The Kubernetes deployment keeps crash-looping; check the helm chart and the autoscaler', [['kubernetes-operations']], { allow: ['systematic-debugging'] }),
  t('simple', 'Run a WCAG accessibility audit of the signup form: contrast, focus order and labels', [['accessibility-wcag-audit']]),
  t('simple', 'Improve Core Web Vitals on the homepage, LCP is 4.2 seconds', [['web-performance-vitals']]),
  t('simple', 'Do a discounted cash flow valuation of this stock and compare against sector multiples', [['stock-valuation']]),
  t('simple', 'Review this pull request and leave actionable comments on correctness and tests', [['code-review-pr']]),
  t('simple', 'Build the onboarding screens in SwiftUI with navigation and state', [['swiftui-ios']]),

  /* ---------- engineering: a real problem, described the way engineers describe it ---------- */
  t('engineering', 'Users report intermittent 502s after deploys. Reproduce it, isolate whether it is the load balancer or the app, and find the root cause before changing anything', [['systematic-debugging']], { allow: ['observability-monitoring', 'kubernetes-operations'] }),
  t('engineering', 'Our Node service leaks memory under sustained load; profile it and find which allocation path grows', [['backend-profiling']], { allow: ['systematic-debugging', 'express-node-service'] }),
  t('engineering', 'Add structured logging, request tracing and latency metrics to the payments service, with alerts on error rate', [['observability-monitoring']]),
  t('engineering', 'Design the REST API for a booking system: resources, pagination, versioning and a consistent error format', [['rest-api-design']]),
  t('engineering', 'Build a FastAPI service with pydantic models, dependency injection and async database access', [['fastapi-service']], { allow: ['python-idioms'] }),
  t('engineering', 'Add an Express middleware chain for validation and centralised error handling in our Node API', [['express-node-service']]),
  t('engineering', 'Design a GraphQL schema with cursor pagination for the catalog and write the resolvers', [['graphql-schema-design']]),
  t('engineering', 'Model orders and line items in MongoDB and write the aggregation pipeline for monthly revenue', [['mongodb-modeling']]),
  t('engineering', 'Implement the discount engine test-first: failing test, minimal code, refactor', [['tdd-workflow']], { allow: ['unit-test-writing'] }),
  t('engineering', 'The Playwright suite is flaky in CI; use traces to find the timing problem and stabilise the locators', [['playwright-e2e']], { allow: ['systematic-debugging', 'github-actions-ci'] }),
  t('engineering', 'Audit our npm dependencies for known CVEs and plan the upgrades that fix them', [['dependency-vulnerability-audit']]),
  t('engineering', 'Scan the repository history for leaked API keys and rotate anything that was exposed', [['secrets-scanning']]),
  t('engineering', 'Review the upload endpoint for injection, XSS and broken access control before we ship', [['owasp-security-review']]),
  t('engineering', 'Build an ETL job that ingests the vendor CSV nightly, validates data quality and loads the warehouse', [['etl-pipelines']]),
  t('engineering', 'Refactor the 900-line order service: extract functions, remove duplication, keep behaviour under test', [['refactoring-patterns']], { allow: ['unit-test-writing'] }),
  t('engineering', 'Build a React Native app with Expo: tab navigation, a native camera module and a release build', [['react-native-app']]),
  t('engineering', 'Evaluate our coding agent: build a task suite with graders, a baseline and regression tracking', [['agent-evaluation']]),
  t('engineering', 'Rewrite the system prompt for the support bot with clear structure and few-shot examples, then measure it', [['prompt-engineering']], { allow: ['agent-evaluation'] }),
  t('engineering', 'Write an agent skill with proper front matter and an activation description, and test that it triggers', [['skill-authoring']]),
  t('engineering', 'Add type hints and dataclasses to this Python module and tidy the error handling', [['python-idioms']], { allow: ['refactoring-patterns'] }),
  t('engineering', 'Set up Tailwind with a custom theme and make the dashboard layout responsive', [['tailwind-styling']]),
  t('engineering', 'Port the settings page to Vue 3 with the composition API and single-file components', [['vue-patterns']]),

  /* ---------- design ---------- */
  t('design', 'Create a design system for our product: color, spacing and type tokens with light and dark themes', [['design-system-tokens']], { allow: ['typography-web'] }),
  t('design', 'Do a usability review of the checkout: list the friction points with severity', [['ux-heuristics-review']]),
  t('design', 'Pick a type scale and font pairing for a long-form reading site and sort out font loading', [['typography-web']]),
  t('design', 'Develop brand identity guidelines: logo usage, palette and voice', [['brand-identity-guidelines']]),
  t('design', 'Add tasteful motion to the onboarding: easing, choreography and a reduced-motion fallback', [['web-animation-motion']]),
  t('design', 'Design and build a landing page for the launch with a hero, feature sections and a call to action', [['landing-page-builder']], { allow: ['tailwind-styling', 'seo-optimization'] }),
  t('design', 'Choose the right chart types for this revenue data and label them so they read without a legend', [['data-visualization-charts']]),
  t('design', 'Our dashboard feels cluttered. Review it against usability heuristics and propose a calmer layout', [['ux-heuristics-review']], { allow: ['design-system-tokens'] }),
  t('design', 'Make the modal dialogs keyboard accessible and check them with a screen reader', [['accessibility-wcag-audit']]),
  t('design', 'Extend the design tokens with a compact density mode and document the theming rules', [['design-system-tokens']], { allow: ['technical-docs-writing'] }),
  t('design', 'Design an interactive 3D product viewer for the web with good lighting and materials', [['webgl-three-scenes']]),
  t('design', 'Build the settings screens for iPhone with SwiftUI and smooth view transitions', [['swiftui-ios']]),

  /* ---------- research ---------- */
  t('research', 'Research how other teams handle zero-downtime schema changes and write a cited synthesis', [['deep-research-synthesis']], { allow: ['postgres-schema-migrations'] }),
  t('research', 'Compare our three main competitors on features and pricing and identify the gaps', [['competitive-market-analysis']], { allow: ['pricing-strategy'] }),
  t('research', 'Investigate the evidence on four-day work weeks across multiple sources and cross-check the claims', [['deep-research-synthesis']]),
  t('research', 'Survey the literature on retrieval-augmented generation evaluation and summarise with citations', [['deep-research-synthesis']], { allow: ['rag-pipeline', 'agent-evaluation'] }),
  t('research', 'Analyze the market for developer observability tools: positioning, competitors and open gaps', [['competitive-market-analysis']], { allow: ['deep-research-synthesis'] }),
  t('research', 'Prepare an income statement and cash flow analysis from these ledgers', [['financial-statements']]),
  t('research', 'Design pricing tiers and a value metric for the new plan, with an experiment to test them', [['pricing-strategy']]),
  t('research', 'Do technical SEO for the docs site: metadata, structured data and a content map', [['seo-optimization']]),
  t('research', 'Fact-check the claims in this draft article against primary sources and cite each one', [['deep-research-synthesis']]),
  t('research', 'Find out why competitors are winning enterprise deals and what they offer that we do not', [['competitive-market-analysis']]),

  /* ---------- multi-domain: several real needs ---------- */
  t('multi-domain', 'Build a Next.js dashboard backed by a Postgres schema, with Playwright end-to-end tests', [['nextjs-app-router'], ['postgres-schema-migrations'], ['playwright-e2e']], { allow: ['react-patterns'] }),
  t('multi-domain', 'Create a FastAPI backend with OAuth login and containerize it with Docker', [['fastapi-service'], ['auth-oauth-jwt'], ['docker-containerization']]),
  t('multi-domain', 'Add Redis caching to the GraphQL API and set up GitHub Actions CI to run the tests', [['redis-caching'], ['graphql-schema-design'], ['github-actions-ci']]),
  t('multi-domain', 'Build a React landing page with Tailwind and get its Core Web Vitals into the green', [['landing-page-builder', 'react-patterns'], ['tailwind-styling'], ['web-performance-vitals']], { allow: ['react-patterns', 'landing-page-builder'] }),
  t('multi-domain', 'Design the REST API, write the Postgres migrations and add unit tests for the service layer', [['rest-api-design'], ['postgres-schema-migrations'], ['unit-test-writing']]),
  t('multi-domain', 'Deploy the service to Kubernetes with Terraform-managed infrastructure and add observability', [['kubernetes-operations'], ['terraform-infrastructure'], ['observability-monitoring']]),
  t('multi-domain', 'Scrape competitor pricing pages weekly and load the results into a pandas analysis', [['web-scraping'], ['pandas-data-analysis']], { allow: ['etl-pipelines', 'competitive-market-analysis'] }),
  t('multi-domain', 'Build an MCP server for our RAG pipeline and write an evaluation suite for it', [['mcp-server-builder'], ['rag-pipeline'], ['agent-evaluation']]),
  t('multi-domain', 'Write the PRD for the export feature and a slide deck that presents it', [['prd-writing'], ['slide-decks-pptx']]),
  t('multi-domain', 'Audit the React app for accessibility and write unit tests for the fixed components', [['accessibility-wcag-audit'], ['unit-test-writing']], { allow: ['react-patterns'] }),
  t('multi-domain', 'Run an OWASP review of the Express API and audit its dependencies for vulnerabilities', [['owasp-security-review'], ['dependency-vulnerability-audit']], { allow: ['express-node-service'] }),
  t('multi-domain', 'Build a WebGL product configurator in React with an animated camera', [['webgl-three-scenes'], ['react-patterns']], { allow: ['web-animation-motion'] }),
  t('multi-domain', 'Create the design tokens, then build the Vue components with Tailwind using them', [['design-system-tokens'], ['vue-patterns'], ['tailwind-styling']]),
  t('multi-domain', 'Write documentation and a changelog for the new webhook API', [['technical-docs-writing'], ['changelog-release-notes']], { allow: ['webhook-handlers', 'rest-api-design'] }),
  t('multi-domain', 'Profile the slow endpoint, optimise the SQL behind it and add a Redis cache', [['backend-profiling'], ['sql-query-optimization'], ['redis-caching']]),

  /* ---------- planning: substantive planning, architecture and security design must still activate ---------- */
  t('planning', 'Plan the architecture for a multi-tenant SaaS that must scale to ten thousand tenants: storage, caching, queues and failure modes', [['system-design-scalability']], { allow: ['microservices-architecture', 'redis-caching'] }),
  t('planning', 'Before we write code, do a STRIDE threat model of the payment flow: assets, trust boundaries and mitigations', [['threat-modeling-stride']]),
  t('planning', 'Propose how to split the monolith into microservices: service boundaries, communication and data ownership', [['microservices-architecture']], { allow: ['domain-driven-design', 'system-design-scalability'] }),
  t('planning', 'Write an architecture decision record for choosing Postgres over MongoDB, with alternatives and consequences', [['adr-decision-records']], { allow: ['postgres-schema-migrations', 'mongodb-modeling'] }),
  t('planning', 'Plan the product roadmap for next quarter: themes, sequencing, dependencies and trade-offs', [['roadmap-planning']]),
  t('planning', 'Map the bounded contexts and aggregates for the logistics domain before we design the services', [['domain-driven-design']], { allow: ['microservices-architecture'] }),
  t('planning', 'Design the security architecture for the new API: threat model it and decide on the authentication approach', [['threat-modeling-stride'], ['auth-oauth-jwt']], { allow: ['owasp-security-review'] }),
  t('planning', 'Draft the product requirements for offline mode: problem, goals, requirements and success metrics', [['prd-writing']]),
  t('planning', 'Plan a zero-downtime migration of the users table to a new Postgres schema', [['postgres-schema-migrations']]),
  t('planning', 'Design a system that handles fifty thousand writes per second with strong consistency for balances', [['system-design-scalability']]),
  t('planning', 'Plan the CI/CD pipeline for the monorepo with GitHub Actions: caching, a test matrix and release jobs', [['github-actions-ci']]),
  t('planning', 'Plan the evaluation strategy for our agent before launch: suites, graders and a baseline', [['agent-evaluation']]),
  t('planning', 'Outline the design system we need before the redesign: tokens, components and theming rules', [['design-system-tokens']]),
  t('planning', 'Plan the observability we need for the checkout service: what to log, trace, measure and alert on', [['observability-monitoring']]),
  t('planning', 'Design the caching strategy for the catalog with Redis: key design, expiry and invalidation', [['redis-caching']], { allow: ['system-design-scalability'] }),
  t('planning', 'Plan the Kubernetes rollout: deployments, autoscaling and how we roll back', [['kubernetes-operations']]),

  /* ---------- no-capability: real work the registry cannot help with; an empty result is correct ---------- */
  t('no-capability', 'Write a COBOL batch job that reconciles the nightly ledger file'),
  t('no-capability', 'Tune the PID controller gains for the quadcopter altitude loop'),
  t('no-capability', 'Translate this contract clause from German to English and keep the legal meaning'),
  t('no-capability', 'Compose a four-part harmony arrangement for this melody'),
  t('no-capability', 'Derive the closed-form solution of this differential equation and check the boundary conditions'),
  t('no-capability', 'Write a Verilog module for a UART transmitter with a testbench'),
  t('no-capability', 'Plan a seven-day hiking itinerary in the Dolomites with huts and elevation gain'),
  t('no-capability', 'Write a short story about a lighthouse keeper who collects clocks'),
  t('no-capability', 'Explain how mRNA vaccines trigger an immune response'),
  t('no-capability', 'Draft a lease termination letter to my landlord'),
  t('no-capability', 'Write an Unreal Engine blueprint that spawns enemies in waves'),
  t('no-capability', 'Calculate the load on this steel beam and choose a section'),
  t('no-capability', 'Write a SystemVerilog assertion for the handshake protocol'),
  t('no-capability', 'Prepare a week of vegetarian meal plans with a shopping list'),
  t('no-capability', 'Write an Ansible playbook that patches the fleet of Debian hosts'),
  t('no-capability', 'Explain the rules of cricket to someone who knows baseball'),

  /* ---------- trivial, administrative, meta: never a reason to load a capability ---------- */
  t('trivial-admin-meta', 'thanks'),
  t('trivial-admin-meta', 'yes, go ahead'),
  t('trivial-admin-meta', 'continue'),
  t('trivial-admin-meta', 'ok that looks good, commit it'),
  t('trivial-admin-meta', 'push the branch'),
  t('trivial-admin-meta', 'run the tests again'),
  t('trivial-admin-meta', 'what did you just change?'),
  t('trivial-admin-meta', 'summarize what we did in this session'),
  t('trivial-admin-meta', 'which model are you?'),
  t('trivial-admin-meta', 'can you see the file I attached?'),
  t('trivial-admin-meta', 'show me the diff'),
  t('trivial-admin-meta', 'rename that variable to total'),
  t('trivial-admin-meta', 'undo the last edit'),
  t('trivial-admin-meta', 'wait, stop'),
  t('trivial-admin-meta', 'open the README'),
  t('trivial-admin-meta', 'list the files in src'),
  t('trivial-admin-meta', 'what time is it in Tokyo?'),
  t('trivial-admin-meta', 'never mind, do the second option instead'),
  t('trivial-admin-meta', 'please proceed with the plan you proposed'),
  t('trivial-admin-meta', 'how many tokens have we used so far?'),
  t('trivial-admin-meta', 'delete the temp folder'),
  t('trivial-admin-meta', 'bump the version to 1.2.0'),
  t('trivial-admin-meta', 'install the dependencies'),
  t('trivial-admin-meta', 'what is 17 percent of 2,340?'),
  t('trivial-admin-meta', 'good morning'),
  t('trivial-admin-meta', 'explain what you are going to do before you do it'),

  /* ---------- must-not-activate: carries a registry keyword but is not that kind of work ---------- */
  t('must-not-activate', 'rename the kubernetes folder to k8s', [], { forbid: ['kubernetes-operations'] }),
  t('must-not-activate', 'what does WCAG stand for?', [], { forbid: ['accessibility-wcag-audit'] }),
  t('must-not-activate', 'is the docker daemon running?', [], { forbid: ['docker-containerization'] }),
  t('must-not-activate', 'open the terraform directory', [], { forbid: ['terraform-infrastructure'] }),
  t('must-not-activate', 'add react to the list of technologies in the README', [], { forbid: ['react-patterns', 'technical-docs-writing'] }),
  t('must-not-activate', 'delete the old playwright report folder', [], { forbid: ['playwright-e2e'] }),
  t('must-not-activate', 'which version of postgres do we use?', [], { forbid: ['postgres-schema-migrations'] }),
  t('must-not-activate', 'commit the redis config change', [], { forbid: ['redis-caching', 'git-workflow'] }),
  t('must-not-activate', 'my friend works in security, what should I get him for his birthday?', [], { forbid: ['owasp-security-review', 'threat-modeling-stride'] }),
  t('must-not-activate', 'the design meeting moved to Thursday, update my note', [], { forbid: ['design-system-tokens', 'ux-heuristics-review'] }),
  t('must-not-activate', 'did the github actions run finish?', [], { forbid: ['github-actions-ci'] }),
  t('must-not-activate', 'spell-check the word "accessibility" in the title', [], { forbid: ['accessibility-wcag-audit'] }),
  t('must-not-activate', 'paste the pandas version into the issue', [], { forbid: ['pandas-data-analysis'] }),
  t('must-not-activate', 'what is the difference between a stock and a bond, in one sentence?', [], { forbid: ['stock-valuation'] }),
  t('must-not-activate', 'move the pdf to the downloads folder', [], { forbid: ['pdf-documents'] }),
  t('must-not-activate', 'tell me a joke about microservices', [], { forbid: ['microservices-architecture'] }),

  /* ---------- added 2026-11-12 from a false activation seen on the real registry (appended so existing ids keep their held-out status) ---------- */
  t('planning', 'Plan the architecture for a multi-tenant SaaS: storage, caching, queues and failure modes', [['system-design-scalability']], { allow: ['redis-caching', 'microservices-architecture'], forbid: ['azure-storage-queue-rust'] }),
  t('simple', 'Send and receive messages on an Azure storage queue from our Rust worker', [['azure-storage-queue-rust']], { allow: ['rust-ownership'] }),
];

/** A fixed quarter of the tasks, chosen by position, is never used for tuning. */
export const isHeldOut = (task: BenchTask) => Number(task.id.slice(1)) % 4 === 0;
