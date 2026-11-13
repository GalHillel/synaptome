import { type FetchedFile, type Kind, type PermissionSet, type Settings, type Tier, type Trust, estimateTokens, noPermissions, parseFrontmatter } from '@synaptome/core';

/**
 * Static audit of an untrusted package. Everything here treats file contents as DATA:
 * nothing is executed, imported, or followed as instruction.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface Finding {
  id: string;
  severity: Severity;
  category: 'injection' | 'execution' | 'exfiltration' | 'credentials' | 'configuration' | 'obfuscation' | 'network' | 'licence' | 'structure' | 'unreviewed' | 'policy';
  file: string;
  line: number;
  excerpt: string;
  message: string;
}

export interface LicenceVerdict {
  spdx: string;
  evidence: string;
  compatible: 'yes' | 'no' | 'unknown';
}

export interface AuditResult {
  tier: Tier;
  trust: Trust;
  licence: LicenceVerdict;
  permissions: PermissionSet;
  executables: string[];
  findings: Finding[];
  critical: number;
  high: number;
  unreviewed: number;
  entryFile: string;
  frontmatter: Record<string, any>;
  summary: string;
}

export interface AuditInput {
  kind: Kind;
  files: FetchedFile[];
  skipped?: { path: string; reason: string }[];
  declaredLicence?: { spdx?: string | null; evidence?: string | null };
  publisher?: string | null;
  provenanceVerified?: boolean;
  settings: Settings;
}

/* ---------- licence detection ---------- */

const LICENCE_SIGNATURES: [string, RegExp[]][] = [
  ['Apache-2.0', [/Apache License/i, /Version 2\.0/i]],
  ['MIT', [/Permission is hereby granted, free of charge, to any person obtaining a copy/i]],
  ['BSD-3-Clause', [/Redistribution and use in source and binary forms/i, /Neither the name/i]],
  ['BSD-2-Clause', [/Redistribution and use in source and binary forms/i]],
  ['ISC', [/Permission to use, copy, modify, and\/or distribute this software/i]],
  ['MPL-2.0', [/Mozilla Public License,? (v\. ?|Version )2\.0/i]],
  ['AGPL-3.0', [/GNU AFFERO GENERAL PUBLIC LICENSE/i]],
  ['LGPL-3.0', [/GNU LESSER GENERAL PUBLIC LICENSE/i]],
  ['GPL-3.0', [/GNU GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ['GPL-2.0', [/GNU GENERAL PUBLIC LICENSE/i, /Version 2/i]],
  ['BSL-1.0', [/Boost Software License - Version 1\.0/i]],
  ['Zlib', [/provided 'as-is', without any express or implied\s+warranty/i, /Permission is granted to anyone to use this software for any purpose/i]],
  ['EPL-2.0', [/Eclipse Public License - v 2\.0/i]],
  ['CC0-1.0', [/CC0 1\.0 Universal/i]],
  ['CC-BY-4.0', [/Creative Commons Attribution 4\.0/i]],
  ['Unlicense', [/This is free and unencumbered software released into the public domain/i]],
];
const PROPRIETARY = /all rights reserved|proprietary|may not (be )?(cop(y|ied)|modif(y|ied)|distribut|reproduc)|no (license|licence) is granted|source[- ]available/i;
const SPDX_ATOM = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC|0BSD|MPL-2\.0|GPL-[23]\.0(-only|-or-later)?|AGPL-3\.0(-only|-or-later)?|LGPL-[23]\.[01](-only|-or-later)?|CC0-1\.0|CC-BY-4\.0|Unlicense|BSL-1\.0|Zlib|EPL-2\.0|Python-2\.0)$/i;
/** Licence atoms of an SPDX expression, ignoring exceptions: `(MIT OR Apache-2.0)`, `GPL-2.0-only WITH Classpath-exception-2.0`. */
const spdxAtoms = (expr: string) => expr.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i).map((a) => a.replace(/\s+WITH\s+\S+$/i, '').trim()).filter(Boolean);
/** True when every licence named in the expression is a known SPDX identifier. */
export const isSpdxExpression = (expr: string) => !!expr.trim() && spdxAtoms(expr).every((a) => SPDX_ATOM.test(a));
const SPDX_ID = { test: isSpdxExpression };
/**
 * Whether an SPDX expression is compatible with an allow list: with OR, one alternative whose parts are all allowed is
 * enough (you may choose it); with AND, every part must be allowed.
 */
export function spdxCompatible(expr: string, allowed: string[]): boolean {
  const ok = (atom: string) => allowed.some((a) => a.toLowerCase() === atom.toLowerCase());
  const alternatives = expr.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  return alternatives.some((alt) => alt.split(/\s+AND\s+/i).map((a) => a.replace(/\s+WITH\s+\S+$/i, '').trim()).filter(Boolean).every(ok));
}

export function detectLicence(text: string): string | null {
  for (const [spdx, res] of LICENCE_SIGNATURES) if (res.every((r) => r.test(text))) return spdx;
  if (PROPRIETARY.test(text)) return 'LicenseRef-Proprietary';
  return null;
}

export function judgeLicence(input: AuditInput, frontmatter: Record<string, any>): LicenceVerdict {
  const allowed = input.settings.policy.allowedLicenses;
  const verdict = (spdx: string, evidence: string): LicenceVerdict => ({ spdx, evidence, compatible: spdxCompatible(spdx, allowed) ? 'yes' : 'no' });
  // 1. A licence file inside the unit is the strongest evidence (LICENSE, LICENSE.md, LICENSE-MIT, COPYING.LESSER).
  const own = input.files.find((f) => /^(licen[cs]e|copying|unlicense)([-_.][a-z0-9.-]+)?$/i.test(f.path));
  if (own) {
    const spdx = detectLicence(own.content);
    if (spdx) return verdict(spdx, `${own.path} in the package: "${firstLine(own.content)}"`);
    return { spdx: '', evidence: `${own.path} is present but its terms were not recognised`, compatible: 'unknown' };
  }
  // 2. Front-matter declaration.
  const fm = typeof frontmatter.license === 'string' ? frontmatter.license.trim() : '';
  if (fm && SPDX_ID.test(fm)) return verdict(fm, `front-matter declares license: ${fm}`);
  if (fm && PROPRIETARY.test(fm)) return verdict('LicenseRef-Proprietary', `front-matter: "${fm.slice(0, 100)}"`);
  // 3. Repository-level licence carried along by the connector.
  const up = input.files.find((f) => /^\.upstream\/(licen[cs]e|copying)/i.test(f.path));
  if (up) {
    const spdx = detectLicence(up.content);
    if (spdx) return verdict(spdx, `repository ${up.path.slice(10)}: "${firstLine(up.content)}"`);
  }
  // 4. A bare declaration by the source, with no licence text retrieved, is a claim, not evidence.
  if (input.declaredLicence?.spdx && SPDX_ID.test(input.declaredLicence.spdx)) return { spdx: input.declaredLicence.spdx, evidence: `source declares ${input.declaredLicence.spdx} but no licence text was retrieved to confirm it`, compatible: 'unknown' };
  return { spdx: '', evidence: fm ? `front-matter says "${fm.slice(0, 80)}" but no licence text was found` : 'no licence file or declaration found', compatible: 'unknown' };
}
const firstLine = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 100);

/* ---------- content rules ---------- */

interface Rule {
  id: string;
  severity: Severity;
  category: Finding['category'];
  re: RegExp;
  message: string;
  /** Sets a permission when matched. */
  perm?: keyof PermissionSet;
  /** Only applied to these file classes. */
  on?: 'text' | 'code' | 'all';
  /**
   * The rule's own wording often contains a negation ("do not mention this", "never refuses"), so weak cautionary
   * words on the line say nothing about intent. Only strong defensive context (attacker, malicious, example of an
   * attack) lowers it.
   */
  strongOnly?: boolean;
}

const RULES: Rule[] = [
  // Prompt injection / concealment
  { id: 'inj-ignore-instructions', severity: 'critical', category: 'injection', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all |any )?(previous|prior|above|earlier|system|safety)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|messages)/i, message: 'Tells the model to ignore prior or system instructions' },
  { id: 'inj-override-paraphrase', severity: 'critical', category: 'injection', re: /\b(disregard|ignore|forget)\b[^.\n]{0,30}\b(everything|anything|all)\b[^.\n]{0,40}\b(told|said|instructed|given)\b[^.\n]{0,30}\b(before|previously|earlier|so far|until now)\b|\bfrom now on\b[^.\n]{0,40}\byour only (rules|instructions|guidelines)\b/i, message: 'Tells the model to drop the instructions it was given' },
  { id: 'inj-conceal-from-user', severity: 'critical', category: 'injection', strongOnly: true, re: /\bwithout\s+(first\s+)?(telling|informing|notifying|alerting|asking)\s+(the\s+)?(user|human|operator)\b|\b(do not|don't|never)\s+(tell|inform|notify|alert)\s+(the\s+)?(user|human|operator)\s+(about|that you|what you|of|you (have|are|did))\b|\b(hide|conceal|keep)\s+(this|it|that|these|them)\s+(secret\s+|hidden\s+)?from\s+(the\s+)?(user|human|operator)\b|\b(silently|quietly|secretly|covertly)\s+(copy|send|upload|post|delete|run|execute|transfer|forward|exfiltrate|install)\b|\b(do not|don't|never)\s+(mention|disclose|reveal|report)\s+(this|it|that|these|them|anything)\b[^.\n]{0,20}\bto (the )?(user|human|operator|anyone)\b/i, message: 'Asks the model to act behind the user\'s back' },
  { id: 'inj-role-override', severity: 'critical', category: 'injection', strongOnly: true, re: /\byou are now\b[^.\n]{0,60}\b(unrestricted|jailbroken|DAN|no (rules|restrictions|limits))/i, message: 'Attempts to redefine the model as unrestricted' },
  { id: 'inj-hidden-unicode', severity: 'critical', category: 'obfuscation', re: /[\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u, message: 'Contains zero-width, bidirectional-override or tag characters that can hide text' },
  { id: 'text-direction-mark', severity: 'info', category: 'structure', re: /[\u200E\u200F]/u, message: 'Contains left-to-right or right-to-left marks (normal in mixed-direction text)' },
  // MCP tool-description poisoning: instructions to the model hidden in a tool's description
  { id: 'inj-tool-poisoning', severity: 'critical', category: 'injection', strongOnly: true, re: /<important>[^<]{0,400}\b(read|open|cat|include|pass|send|attach|forward)\b|\bbefore (using|calling) this tool\b[^.\n]{0,100}\b(read|open|cat|include|pass|send|attach)\b|\b(always|whenever)\b[^.\n]{0,60}\bcall (it|this tool) (first|before)\b|\binclude\b[^.\n]{0,40}\b(full |entire |whole )?(conversation|chat|session) (history|transcript|log)\b/i, message: 'Tool description carries hidden instructions to the model (tool poisoning)' },
  { id: 'exfil-markdown-image', severity: 'critical', category: 'exfiltration', re: /!?\[[^\]]{0,80}\]\(\s*https?:\/\/[^)\s]*\?[^)\s]*(\{\{|\$\{|%7B%7B|<[a-z_]+>)[^)]*\)/i, message: 'Embeds data in a URL that is loaded automatically (image or link exfiltration)', perm: 'network' },
  // Execution
  { id: 'exec-pipe-to-shell', severity: 'critical', category: 'execution', re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell|iex|python3?|node)\b/i, message: 'Downloads and pipes remote content into an interpreter', perm: 'shell' },
  { id: 'exec-iex-download', severity: 'critical', category: 'execution', re: /\b(iex|Invoke-Expression)\b[^\n]{0,80}(DownloadString|Invoke-WebRequest|iwr|Net\.WebClient)/i, message: 'PowerShell download-and-execute', perm: 'shell' },
  { id: 'exec-destructive', severity: 'critical', category: 'execution', re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(\/(\s|$|\*)|~(\/|\s|$)|\$HOME\b|%USERPROFILE%)|\bformat\s+[a-z]:|\bmkfs\.|\bdd\s+if=[^\n]+of=\/dev\/(sd|nvme|disk)|Remove-Item[^\n]{0,60}-Recurse[^\n]{0,40}(\$HOME|\$env:USERPROFILE|C:\\\\?(\s|$))/i, message: 'Destructive command against home or system paths', perm: 'delete' },
  { id: 'exec-encoded-payload', severity: 'critical', category: 'obfuscation', re: /\bbase64\s+(-d|--decode)\b[^\n]{0,80}\|\s*(sh|bash|python3?|node)|-EncodedCommand\s+[A-Za-z0-9+/=]{40,}|\beval\s*\(\s*(atob|Buffer\.from)\s*\(/i, message: 'Decodes and executes an encoded payload', perm: 'shell' },
  { id: 'exec-bypass-permissions', severity: 'critical', category: 'configuration', re: /--dangerously-skip-permissions|bypassPermissions|--yolo\b|"defaultMode"\s*:\s*"bypass/i, message: 'Instructs disabling the host permission system' },
  { id: 'exec-reverse-shell', severity: 'critical', category: 'execution', re: /\/dev\/(tcp|udp)\/[\w.-]+\/\d+|\bnc(at)?\b[^\n]{0,30}\s-[a-z]*e\s+\/bin\/(ba|z)?sh\b|\bsocat\b[^\n]{0,80}\bexec:|\bmkfifo\b[^\n]{0,80}\|\s*nc\b/i, message: 'Opens a remote shell to another host', perm: 'shell' },
  { id: 'exec-remote-code', severity: 'critical', category: 'execution', re: /\b(exec|eval)\s*\(\s*([\w.]+\.)?(urlopen|urllib\.request\.urlopen|requests\.get)\s*\(|\b(exec|eval)\s*\([^\n]{0,60}\b(urlopen|requests\.get)\s*\(/i, message: 'Downloads code and executes it', perm: 'shell' },
  { id: 'cfg-self-grant', severity: 'critical', category: 'configuration', strongOnly: true, re: /\b(add|append|insert|put|grant)\b[^.\n]{0,40}("?Bash\(\*\)"?|\ballow[- ]?list\b|\bpermissions?\b|\ballowed[- ]tools\b)[^.\n]{0,80}(settings(\.local)?\.json|\.claude\b)|\bso (you|it|claude) (never|no longer) (needs?|has) to ask\b/i, message: 'Grants itself host permissions or removes approval prompts' },
  { id: 'cred-env-file-out', severity: 'critical', category: 'exfiltration', re: /\b(read|cat|open|load|print)\b[^.\n]{0,20}\.env\b(?!\.(example|sample|template))[^.\n]{0,100}\b(include|send|post|upload|paste|print|output|commit|share|attach)\b/i, message: 'Copies secrets from a .env file into output or a remote destination', perm: 'credentials' },
  // Credentials / exfiltration
  { id: 'cred-secret-paths', severity: 'high', category: 'credentials', re: /(~|\$HOME|%USERPROFILE%)?[\\/]\.(ssh[\\/](id_[a-z0-9]+|authorized_keys)|aws[\\/]credentials|netrc|npmrc|docker[\\/]config\.json|kube[\\/]config|gnupg)\b|\.credentials\.json|login\.keychain|\bLocal State\b[^\n]{0,40}encrypted_key/i, message: 'References credential stores', perm: 'credentials' },
  { id: 'cred-env-dump', severity: 'high', category: 'exfiltration', re: /\b(printenv|env\b[^\n|]{0,10}\||Get-ChildItem\s+env:)[^\n]{0,80}(curl|wget|nc\b|Invoke-WebRequest|https?:\/\/)/i, message: 'Sends environment variables to a remote endpoint', perm: 'credentials' },
  { id: 'exfil-post-data', severity: 'high', category: 'exfiltration', re: /\bcurl\b[^\n]{0,120}(-d|--data(-binary)?|-F|--upload-file|-T)\s+@?[^\n]{0,80}https?:\/\/(?!localhost|127\.0\.0\.1)/i, message: 'Uploads local data to a remote host', perm: 'network' },
  { id: 'exfil-webhook', severity: 'high', category: 'exfiltration', re: /https?:\/\/(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|[a-z0-9-]+\.ngrok(-free)?\.(io|app)|webhook\.site|[a-z0-9]+\.burpcollaborator\.net|requestbin|pipedream\.net)/i, message: 'Hard-coded third-party collection endpoint', perm: 'network' },
  // Configuration tampering
  { id: 'cfg-host-config', severity: 'high', category: 'configuration', re: /\b(add|append|write|edit|modify|update|insert|overwrite)\b[^.\n]{0,60}(~\/\.claude\/(settings(\.local)?\.json|CLAUDE\.md)|\.claude\/settings(\.local)?\.json|\.cursorrules|~\/\.codex\/config|\.bashrc|\.zshrc|\$PROFILE|crontab|Task Scheduler|HKCU|HKLM)/i, message: 'Instructs modifying host or shell configuration', perm: 'configuration' },
  { id: 'cfg-self-permission', severity: 'high', category: 'configuration', re: /"?(allow|permissions)"?\s*:\s*\[[^\]]{0,200}"?(Bash\(\*\)|\*)"?/i, message: 'Grants itself broad tool permissions' },
  // Network / install (not malicious per se; they move a package out of Tier A)
  { id: 'net-fetch-step', severity: 'medium', category: 'network', re: /^\s*(\$\s*)?(curl|wget|Invoke-WebRequest|iwr)\s+[^\n]*https?:\/\//im, message: 'Workflow step fetches from the network', perm: 'network' },
  { id: 'net-install-step', severity: 'medium', category: 'network', re: /^\s*(\$\s*)?(sudo\s+)?(npm (i|install)( -g)?|npx(?! tsc| vitest| eslint| prettier)|pnpm (add|dlx)|yarn (add|global)|pip3? install|pipx (install|run)|uvx?( tool)? (install|run|add)|cargo install|go install|brew install|apt(-get)? install|choco install|winget install)\b/im, message: 'Workflow step installs software from a package registry', perm: 'installation' },
  { id: 'shell-instructions', severity: 'low', category: 'execution', re: /```(bash|sh|shell|zsh|powershell|pwsh|cmd|console)\b/i, message: 'Contains shell command examples the agent may run (informational; no executable files implied)' },
  { id: 'browser-automation', severity: 'low', category: 'network', re: /\b(playwright|puppeteer|selenium|chromedriver|browser automation)\b/i, message: 'Involves browser automation', perm: 'browser' },
  // Obfuscation
  { id: 'obf-long-blob', severity: 'high', category: 'obfuscation', re: /(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{400,}={0,2}([^A-Za-z0-9+/]|$)/, message: 'Long opaque encoded blob', on: 'all' },
  { id: 'obf-js-packed', severity: 'critical', category: 'obfuscation', re: /\beval\(function\(p,a,c,k,e,[dr]\)|\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){30,}|String\.fromCharCode\((\d+,\s*){30,}/i, message: 'Packed or escaped code', on: 'code' },
];

/** Strong evidence a passage describes an attack rather than performs one; may come from the few lines above. */
const STRONG_DEFENSIVE = /\b(attackers?|malicious|malware|example of an? (attack|injection|exploit)|red[- ]team|incident|watch for|red flag|anti-pattern|bad example|detect(ion|ed|s)?|vulnerab\w*|threat model|indicators? of compromise)\b/i;
/** Lines whose findings combine into something worse than either alone: reading a secret and sending it out. */
const SECRET_READ = new Set(['cred-secret-paths', 'cred-env-dump', 'cred-env-file-out']);
const SENDS_OUT = new Set(['exfil-post-data', 'exfil-webhook', 'net-fetch-step']);

const CODE_EXT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|tsx|jsx|rb|pl|php|go|rs|java|kt|swift|lua|r|c|cc|cpp|cs)$/i;
const TEXT_EXT = /\.(md|mdx|txt|rst|ya?ml|json|toml|ini|cfg|html?|css|csv|xml|svg)$/i;

export function isExecutable(f: FetchedFile): boolean {
  return CODE_EXT.test(f.path) || /^#!\s*\//.test(f.content);
}

/** Lines that are clearly describing a threat (e.g. inside a security checklist) are still reported, but one level lower. */
const DEFENSIVE_CONTEXT = /\b(never|do not|don't|avoid|reject|refuse|block|detect|flag|watch for|red flag|anti-pattern|bad example|malicious|attacker|vulnerab|threat|example of an? (attack|injection))\b/i;

export function auditPackage(input: AuditInput): AuditResult {
  const findings: Finding[] = [];
  const permissions = noPermissions();
  const executables: string[] = [];
  const entry = pickEntry(input.kind, input.files);
  const frontmatter = entry && /\.mdx?$/i.test(entry.path) ? parseFrontmatter(entry.content).data : {};

  for (const f of input.files) {
    if (f.path.startsWith('.upstream/')) continue;
    const code = isExecutable(f);
    if (code) {
      executables.push(f.path);
      permissions.shell = true;
    }
    const lines = f.content.split(/\r?\n/);
    /** Strong defensive words on this line or in the three non-empty lines above it. */
    const strongContext = (lineNo: number) => {
      const window: string[] = [];
      for (let i = lineNo - 1; i >= 0 && window.length < 4; i--) if (lines[i]?.trim()) window.push(lines[i]);
      return window.some((l) => STRONG_DEFENSIVE.test(l));
    };
    const fileFindings: Finding[] = [];
    for (const rule of RULES) {
      if (rule.on === 'code' && !code) continue;
      if ((rule.on ?? 'all') === 'text' && code) continue;
      const g = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m: RegExpExecArray | null;
      let hits = 0;
      while ((m = g.exec(f.content)) && hits < 3) {
        hits++;
        const lineNo = f.content.slice(0, m.index).split('\n').length;
        const lineText = lines[lineNo - 1] ?? '';
        let severity = rule.severity;
        const weak = !rule.strongOnly && DEFENSIVE_CONTEXT.test(lineText);
        const defensive = !code && rule.category !== 'obfuscation' && (weak || strongContext(lineNo));
        // Defensive prose lowers severity one level but is never dropped: a reviewer still sees it.
        if (defensive) severity = ({ critical: 'high', high: 'medium', medium: 'low', low: 'info', info: 'info' } as const)[severity];
        fileFindings.push({ id: rule.id, severity, category: rule.category, file: f.path, line: lineNo, excerpt: sanitizeExcerpt(lineText), message: rule.message + (defensive ? ' (appears in cautionary prose; severity lowered one level)' : '') });
        if (rule.perm && !(defensive && severity !== 'critical')) permissions[rule.perm] = true;
        if (m.index === g.lastIndex) g.lastIndex++;
      }
    }
    // Reading a secret and sending something out on the same line (one command, one hook entry) is exfiltration.
    for (const line of new Set(fileFindings.map((x) => x.line))) {
      const here = fileFindings.filter((x) => x.line === line);
      if (here.some((x) => SECRET_READ.has(x.id)) && here.some((x) => SENDS_OUT.has(x.id))) {
        const lowered = here.some((x) => x.message.includes('cautionary prose'));
        fileFindings.push({ id: 'exfil-credentials', severity: lowered ? 'high' : 'critical', category: 'exfiltration', file: f.path, line, excerpt: here[0].excerpt, message: 'Reads credentials or secrets and sends them to a remote host' + (lowered ? ' (appears in cautionary prose; severity lowered one level)' : '') });
        permissions.credentials = true;
        permissions.network = true;
      }
    }
    // Code that fetches from a remote URL and evaluates text at run time executes code nobody reviewed.
    if (code && /\bfetch\s*\(\s*['"`]https?:\/\//.test(f.content) && /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run(InThisContext|InNewContext)?\s*\(/.test(f.content)) {
      const lineNo = f.content.split('\n').findIndex((l) => /\beval\s*\(|new\s+Function\s*\(|vm\.run/.test(l)) + 1;
      fileFindings.push({ id: 'exec-remote-code', severity: 'critical', category: 'execution', file: f.path, line: lineNo, excerpt: sanitizeExcerpt(lines[lineNo - 1] ?? ''), message: 'Fetches code from a remote URL and evaluates it at run time' });
      permissions.network = true;
    }
    findings.push(...fileFindings);
    if (/(^|\/)hooks\/hooks\.json$|(^|\/)hooks\.json$/.test(f.path) || (f === entry && frontmatter.hooks)) {
      findings.push({ id: 'pkg-hooks', severity: 'high', category: 'execution', file: f.path, line: 1, excerpt: '', message: 'Package registers host hooks (code that runs automatically on host events)' });
      permissions.shell = true;
      permissions.configuration = true;
    }
    if (/(^|\/)\.mcp\.json$|(^|\/)server\.json$/.test(f.path)) {
      findings.push({ id: 'pkg-mcp', severity: 'medium', category: 'network', file: f.path, line: 1, excerpt: '', message: 'Package defines or references an MCP server (external process or remote endpoint)' });
      permissions.network = true;
      permissions.api = true;
    }
    if (!code && !TEXT_EXT.test(f.path) && !/^(licen[cs]e|copying|notice|readme|changelog|authors|\.gitignore)/i.test(f.path.split('/').pop()!)) {
      findings.push({ id: 'pkg-unknown-type', severity: 'low', category: 'structure', file: f.path, line: 1, excerpt: '', message: 'File type not recognised as documentation or code' });
    }
  }
  if (executables.length) findings.push({ id: 'pkg-executables', severity: 'medium', category: 'execution', file: executables[0], line: 1, excerpt: '', message: `${executables.length} executable file(s): ${executables.slice(0, 5).join(', ')}${executables.length > 5 ? ', …' : ''}` });
  if (input.kind === 'mcp-server') {
    permissions.network = true;
    permissions.api = true;
    permissions.shell = true;
    findings.push({ id: 'kind-mcp-server', severity: 'medium', category: 'execution', file: entry?.path ?? '', line: 1, excerpt: '', message: 'MCP servers run code or call remote services; implementation is outside this package' });
  }
  if (input.kind === 'hook') permissions.shell = true;
  if (input.kind === 'plugin') findings.push({ id: 'kind-plugin', severity: 'medium', category: 'structure', file: entry?.path ?? '', line: 1, excerpt: '', message: 'Plugins bundle several capability types; each bundled part needs its own review' });

  for (const s of input.skipped ?? []) findings.push({ id: 'unreviewed-content', severity: 'medium', category: 'unreviewed', file: s.path, line: 0, excerpt: '', message: `Not reviewed: ${s.reason}` });

  // Structure
  if (!entry) findings.push({ id: 'struct-no-entry', severity: 'high', category: 'structure', file: '', line: 0, excerpt: '', message: `No entry file found for kind "${input.kind}"` });
  else if (input.kind === 'skill' || input.kind === 'agent') {
    if (typeof frontmatter.name !== 'string' || !frontmatter.name) findings.push({ id: 'struct-no-name', severity: 'medium', category: 'structure', file: entry.path, line: 1, excerpt: '', message: 'Front-matter has no name' });
    if (typeof frontmatter.description !== 'string' || frontmatter.description.length < 20) findings.push({ id: 'struct-thin-description', severity: 'medium', category: 'structure', file: entry.path, line: 1, excerpt: '', message: 'Front-matter description missing or too short to route on' });
    const tools = String(frontmatter['allowed-tools'] ?? frontmatter.tools ?? '');
    if (/\bBash\b(?!\()|Bash\(\*\)/.test(tools)) {
      findings.push({ id: 'struct-broad-tools', severity: 'medium', category: 'configuration', file: entry.path, line: 1, excerpt: sanitizeExcerpt(tools), message: 'Front-matter pre-approves unrestricted shell access' });
      permissions.shell = true;
    }
    // A declared tool list that leaves out what the content evidently needs understates the capability's reach.
    if (tools.trim() && !/\bBash\b/.test(tools) && (executables.length || findings.some((x) => x.id === 'net-install-step' || x.id === 'net-fetch-step'))) {
      findings.push({ id: 'perm-undeclared', severity: 'medium', category: 'configuration', file: entry.path, line: 1, excerpt: sanitizeExcerpt(tools), message: 'Declares allowed tools without shell access, but its content runs commands; the declared permissions understate what it does' });
    }
  }

  const licence = judgeLicence(input, frontmatter);
  if (licence.compatible === 'no') findings.push({ id: 'licence-incompatible', severity: 'high', category: 'licence', file: '', line: 0, excerpt: '', message: `Licence ${licence.spdx} is not on the allow list (${licence.evidence})` });
  if (licence.compatible === 'unknown') findings.push({ id: 'licence-unknown', severity: 'medium', category: 'licence', file: '', line: 0, excerpt: '', message: `Licence could not be established: ${licence.evidence}` });

  const pol = input.settings.policy;
  const publisher = (input.publisher ?? '').toLowerCase();
  const denied = pol.denyPublishers.map((p) => p.toLowerCase()).includes(publisher) || pol.denyNamePatterns.some((p) => safeTest(p, String(frontmatter.name ?? '')));
  if (denied) findings.push({ id: 'policy-deny-rule', severity: 'critical', category: 'policy', file: '', line: 0, excerpt: '', message: 'Matches an explicit deny rule (publisher or name pattern)' });

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high' && f.category !== 'licence').length;
  const unreviewed = findings.filter((f) => f.category === 'unreviewed').length;
  const needsExec = executables.length > 0 || permissions.network || permissions.installation || permissions.credentials || permissions.configuration || permissions.browser || permissions.delete || permissions.api || ['mcp-server', 'hook', 'plugin', 'tool', 'extension', 'connector'].includes(input.kind);
  const tier: Tier = critical > 0 ? 'C' : needsExec || high > 0 ? 'B' : 'A';
  const official = pol.officialPublishers.map((p) => p.toLowerCase()).includes(publisher);
  const trust: Trust = denied || critical > 0 ? 'BLOCKED' : official && input.provenanceVerified ? 'OFFICIAL_VERIFIED' : 'UNKNOWN';
  const summary = `Tier ${tier}: ${critical} critical, ${high} high, ${findings.length} findings total; ${executables.length} executable file(s); licence ${licence.spdx || 'unknown'} (${licence.compatible}).`;
  return { tier, trust, licence, permissions, executables, findings, critical, high, unreviewed, entryFile: entry?.path ?? '', frontmatter, summary };
}

export interface ExtractedDependency {
  kind: 'capability' | 'package' | 'tool' | 'runtime' | 'service';
  name: string;
  spec: string | null;
  required: boolean;
  evidence: string;
}

/**
 * What a package says it needs, read from its own manifests: npm `package.json` (dependencies, peer dependencies,
 * engines), Python `requirements*.txt` and `pyproject.toml`, MCP `server.json` packages, and skill front-matter
 * (`requires`, `dependencies`). Nothing is resolved or fetched; vulnerability data is not consulted here.
 */
export function extractDependencies(files: FetchedFile[], frontmatter: Record<string, any> = {}): ExtractedDependency[] {
  const out = new Map<string, ExtractedDependency>();
  const add = (d: ExtractedDependency) => {
    const key = `${d.kind}:${d.name.toLowerCase()}`;
    if (!out.has(key)) out.set(key, d);
  };
  for (const f of files) {
    if (f.path.startsWith('.upstream/')) continue;
    const base = f.path.split('/').pop()!.toLowerCase();
    if (base === 'package.json') {
      let pkg: any;
      try {
        pkg = JSON.parse(f.content);
      } catch {
        continue;
      }
      for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) add({ kind: 'package', name: `npm:${name}`, spec: String(spec), required: true, evidence: `${f.path} dependencies` });
      for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) add({ kind: 'package', name: `npm:${name}`, spec: String(spec), required: !pkg.peerDependenciesMeta?.[name]?.optional, evidence: `${f.path} peerDependencies` });
      for (const [name, spec] of Object.entries(pkg.engines ?? {})) add({ kind: 'runtime', name, spec: String(spec), required: true, evidence: `${f.path} engines` });
    } else if (/^requirements([-_.][a-z0-9]+)?\.txt$/.test(base)) {
      for (const raw of f.content.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(line);
        if (m && !line.startsWith('-')) add({ kind: 'package', name: `pypi:${m[1].toLowerCase()}`, spec: m[3] || null, required: true, evidence: f.path });
      }
    } else if (base === 'pyproject.toml') {
      // The list ends at the line that closes it, not at the first "]": extras such as "pydantic[email]" contain one.
      const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)^\s*\]/m.exec(f.content)?.[1] ?? /^\s*dependencies\s*=\s*\[([^\n]*)\]\s*$/m.exec(f.content)?.[1] ?? '';
      for (const m of block.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^"']*)["']/g)) add({ kind: 'package', name: `pypi:${m[1].toLowerCase()}`, spec: m[3].trim() || null, required: true, evidence: `${f.path} [project] dependencies` });
      const py = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(f.content)?.[1];
      if (py) add({ kind: 'runtime', name: 'python', spec: py, required: true, evidence: `${f.path} requires-python` });
    } else if (base === 'server.json') {
      let s: any;
      try {
        s = JSON.parse(f.content);
      } catch {
        continue;
      }
      for (const p of s.packages ?? []) {
        const reg = String(p.registryType ?? p.registry_type ?? 'package');
        if (p.identifier ?? p.name) add({ kind: 'package', name: `${reg}:${p.identifier ?? p.name}`, spec: p.version ?? null, required: true, evidence: `${f.path} packages` });
      }
      for (const r of s.remotes ?? []) if (r.url) add({ kind: 'service', name: String(r.url).replace(/^https?:\/\//, '').split('/')[0], spec: r.type ?? null, required: true, evidence: `${f.path} remotes` });
    }
  }
  for (const key of ['requires', 'dependencies']) {
    const v = frontmatter[key];
    for (const item of Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []) {
      const name = String(item).trim();
      if (name) add({ kind: /^[\w.-]+\.[\w.-]+$/.test(name) ? 'capability' : 'tool', name, spec: null, required: true, evidence: `front-matter ${key}` });
    }
  }
  return [...out.values()];
}

export function pickEntry(kind: Kind, files: FetchedFile[]): FetchedFile | undefined {
  const by = (re: RegExp) => files.find((f) => re.test(f.path));
  if (kind === 'skill') return by(/^SKILL\.md$/);
  if (kind === 'mcp-server') return by(/^server\.json$/) ?? by(/^README\.md$/i);
  if (kind === 'plugin') return by(/^\.claude-plugin\/plugin\.json$/) ?? by(/^README\.md$/i);
  if (kind === 'hook') return by(/hooks\.json$/);
  return files.find((f) => !f.path.startsWith('.upstream/') && /\.(md|ya?ml|json)$/i.test(f.path)) ?? files.find((f) => !f.path.startsWith('.upstream/'));
}

const sanitizeExcerpt = (s: string) => s.replace(/[\u0000-\u001f\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').trim().slice(0, 160);
const safeTest = (pattern: string, value: string) => {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
};

/* =====================================================================
 * Scorecard. Every dimension carries its evidence. A dimension without
 * evidence is `null` (unknown), contributes 0 to the total and is listed
 * in `unknowns` — unknown is never treated as a pass.
 * ===================================================================== */

export interface Dimension {
  score: number | null;
  evidence: string;
}
export interface Scorecard {
  total: number;
  dimensions: Record<keyof Settings['policy']['weights'], Dimension>;
  unknowns: string[];
  weights: Settings['policy']['weights'];
}

export interface ScoreInput {
  kind: Kind;
  files: FetchedFile[];
  audit: AuditResult;
  provenanceVerified: boolean;
  pushedAt?: string | null;
  /** Result of functional tests, when they have been run. */
  functional?: { passed: number; total: number; detail: string } | null;
  /** Result of a model-based baseline evaluation, when one exists. */
  evaluation?: { passRate: number; baselinePassRate: number; cases: number } | null;
  hostCompatible?: boolean | null;
  settings: Settings;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function scorePackage(i: ScoreInput): Scorecard {
  const entry = i.files.find((f) => f.path === i.audit.entryFile);
  const fm = i.audit.frontmatter;
  const body = entry ? parseFrontmatter(entry.content).body : '';
  const desc = String(fm.description ?? '');
  const d = {} as Scorecard['dimensions'];

  // Functional usefulness: is it clear what this does and when to use it? (static evidence only)
  if (!entry) d.usefulness = { score: null, evidence: 'no entry file to assess' };
  else {
    let s = 30;
    const ev: string[] = [];
    if (desc.length >= 60) (s += 25), ev.push('specific description');
    else if (desc.length >= 20) (s += 10), ev.push('short description');
    if (/\b(use (this )?(skill )?when|use for|triggers?|when (the )?user|whenever)\b/i.test(desc + body.slice(0, 1500))) (s += 20), ev.push('states when to use it');
    if (/\b(do not use|don't use|not for|avoid when|out of scope)\b/i.test(desc + body)) (s += 10), ev.push('states when not to use it');
    if (body.length >= 800) (s += 15), ev.push('substantive body');
    d.usefulness = { score: clamp(s), evidence: `static: ${ev.join(', ') || 'little guidance on purpose'}` };
  }

  // Technical quality: structure and internal consistency.
  if (!entry) d.technical = { score: null, evidence: 'no entry file to assess' };
  else {
    let s = 40;
    const ev: string[] = [];
    const structural = i.audit.findings.filter((f) => f.category === 'structure').length;
    if (!structural) (s += 25), ev.push('no structural findings');
    else ev.push(`${structural} structural finding(s)`);
    if ((body.match(/^#{1,3} /gm) ?? []).length >= 2) (s += 15), ev.push('sectioned');
    const links = [...body.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1].replace(/^\.\//, '').split('#')[0]);
    const broken = links.filter((l) => l && !i.files.some((f) => f.path === l || f.path.startsWith(l.replace(/\/$/, '') + '/')));
    if (links.length && !broken.length) (s += 20), ev.push(`${links.length} internal reference(s) resolve`);
    else if (broken.length) (s -= 15), ev.push(`${broken.length} broken internal reference(s)`);
    else (s += 10), ev.push('self-contained');
    d.technical = { score: clamp(s), evidence: `static: ${ev.join(', ')}` };
  }

  // Security and trust.
  {
    const pen = i.audit.findings.reduce((n, f) => n + (f.category === 'licence' ? 0 : { critical: 100, high: 30, medium: 10, low: 3, info: 0 }[f.severity]), 0);
    d.security = { score: clamp(100 - pen), evidence: `static audit: ${i.audit.critical} critical, ${i.audit.high} high, tier ${i.audit.tier}` };
  }

  // Practical effectiveness: needs test evidence. Capped at 80 without a model-based comparison.
  if (i.evaluation) {
    const lift = i.evaluation.passRate - i.evaluation.baselinePassRate;
    d.effectiveness = { score: clamp(i.evaluation.passRate * 100 * (lift >= 0 ? 1 : 0.5)), evidence: `evaluation over ${i.evaluation.cases} case(s): ${(i.evaluation.passRate * 100).toFixed(0)}% with vs ${(i.evaluation.baselinePassRate * 100).toFixed(0)}% without` };
  } else if (i.functional) {
    d.effectiveness = { score: clamp((i.functional.passed / Math.max(1, i.functional.total)) * 80), evidence: `functional checks ${i.functional.passed}/${i.functional.total} (${i.functional.detail}); capped at 80 without a task benchmark` };
  } else d.effectiveness = { score: null, evidence: 'no functional test or evaluation has been run' };

  // Compatibility with at least one managed host.
  d.compatibility = i.hostCompatible == null ? { score: null, evidence: 'no host adapter has checked this package' } : { score: i.hostCompatible ? 100 : 0, evidence: i.hostCompatible ? 'accepted by a host adapter' : 'no managed host supports this kind/shape' };

  // Maintenance.
  if (!i.pushedAt) d.maintenance = { score: null, evidence: 'source gives no update date' };
  else {
    const days = (Date.now() - Date.parse(i.pushedAt)) / 864e5;
    d.maintenance = { score: clamp(days <= 90 ? 100 : days <= 365 ? 80 : days <= 730 ? 50 : 20), evidence: `last upstream change ${Math.round(days)} day(s) ago` };
  }

  // Documentation.
  {
    const text = i.files.filter((f) => /\.mdx?$/i.test(f.path)).map((f) => f.content).join('\n');
    let s = 20;
    if (desc.length >= 40) s += 25;
    if (/```/.test(text)) s += 20;
    if (/\b(example|examples|usage|workflow|steps?)\b/i.test(text)) s += 20;
    if (text.length > 1500) s += 15;
    d.documentation = text ? { score: clamp(s), evidence: `static: ${text.length} characters of markdown` } : { score: null, evidence: 'no markdown documentation' };
  }

  // Context efficiency of what a host would load first.
  if (!entry) d.contextEfficiency = { score: null, evidence: 'no entry file' };
  else {
    const tok = estimateTokens(entry.content);
    d.contextEfficiency = { score: tok <= 1500 ? 100 : tok <= 3500 ? 85 : tok <= 6000 ? 65 : tok <= 10000 ? 40 : 15, evidence: `entry file ≈ ${tok} tokens (estimate), description ${desc.length} chars` };
  }

  // Provenance and licensing clarity.
  {
    const lic = i.audit.licence.compatible;
    const s = (i.provenanceVerified ? 60 : 0) + (lic === 'yes' ? 40 : lic === 'no' ? 10 : 0);
    d.provenance = { score: s, evidence: `${i.provenanceVerified ? 'pinned, verifiable source' : 'source not verifiable'}; licence ${i.audit.licence.spdx || 'unknown'}` };
  }

  const w = i.settings.policy.weights;
  const sumW = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let total = 0;
  const unknowns: string[] = [];
  for (const k of Object.keys(w) as (keyof typeof w)[]) {
    if (d[k].score == null) unknowns.push(k);
    else total += (d[k].score! * w[k]) / sumW;
  }
  return { total: Number(total.toFixed(1)), dimensions: d, unknowns, weights: w };
}
