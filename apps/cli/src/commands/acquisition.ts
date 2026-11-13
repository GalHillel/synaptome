import path from 'node:path';
import type { Command } from 'commander';
import { AcquisitionError, type Deps, probeIsolation, promotionPolicy, validateRules, applyUpdate, approve, capabilityDossier, downgrade, evaluateCandidate, evaluateQueue, getInstallation, ingestInventory, inspectUpdate, install, listInstallations, readCapabilityEntry, reject, rollback, uninstall } from '@synaptome/acquisition';
import { UNSUPPORTED_HOSTS, buildAdapterRegistry } from '@synaptome/adapters';
import { buildConnectorRegistry } from '@synaptome/connectors';
import { type Sys, emit, env, facets, listCandidates, listCapabilities, setSetting } from '@synaptome/core';
import { checkUpdates, syncSources } from '@synaptome/discovery';
import { CliError, type Ctx, EXIT, action, kv, table } from '../ctx';

export function depsFor(sys: Sys, opts: { project?: string } = {}): Deps {
  const connectors = buildConnectorRegistry(sys, { claudeRoot: env('CLAUDE_ROOT') });
  syncSources(sys, connectors);
  const project = opts.project || sys.settings().hosts.claudeProject || undefined;
  return { connectors, adapters: buildAdapterRegistry({ claudeRoot: env('CLAUDE_ROOT'), projectRoot: project ? path.resolve(project) : undefined }) };
}

const CODE: Record<string, number> = { 'not-found': EXIT.notFound, blocked: EXIT.blocked, 'not-approved': EXIT.blocked, conflict: EXIT.blocked, budget: EXIT.blocked, 'not-staged': EXIT.blocked, 'needs-confirmation': EXIT.blocked, unsupported: EXIT.unavailable, invalid: EXIT.usage, failed: EXIT.error, modified: EXIT.blocked, busy: EXIT.unavailable };
/** Converts domain errors into CLI errors with stable exit codes. */
export async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AcquisitionError) throw new CliError(e.message, CODE[e.code] ?? EXIT.error, e.hint, { reason: e.code });
    throw e;
  }
}

const mark = (r: string) => ({ pass: '[pass]', fail: '[FAIL]', unknown: '[ ?? ]' })[r] ?? r;
const gateText = (g: { decision: string; checks: { label: string; result: string; evidence: string }[] }) => [`gate decision: ${g.decision}`, ...g.checks.map((c) => `  ${mark(c.result)} ${c.label} — ${c.evidence}`)].join('\n');

export function registerPolicy(program: Command) {
  const policy = program.command('policy').description('promotion policy rules and the isolation available for dynamic tests');
  policy
    .command('show')
    .description('rules in order, the default, and which isolation this machine offers')
    .option('--probe', 'probe isolation again instead of using the cached result')
    .action(
      action((ctx, opts: { probe?: boolean }) => {
        const p = ctx.sys.settings().policy;
        const iso = probeIsolation({ fresh: !!opts.probe });
        ctx.out({ rules: p.rules, defaultEffect: p.defaultEffect, isolation: iso }, () =>
          [
            p.rules.length ? table(p.rules.map((r, i) => ({ n: i + 1, id: r.id, effect: r.effect, when: Object.entries(r.when).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' '), reason: r.reason ?? '' })), [{ key: 'n' }, { key: 'id' }, { key: 'effect' }, { key: 'when', max: 50 }, { key: 'reason', max: 40 }]) : 'no rules',
            `default when no rule matches and every check passes: ${p.defaultEffect}`,
            '',
            `isolation for dynamic tests: ${iso.available.length ? iso.available.map((a) => a.detail).join('; ') : 'none found (Windows Sandbox, Docker, Podman)'}`,
            `dynamic tests implemented: ${iso.dynamicTestsImplemented ? 'yes' : 'no — packages with executable content always need a person to approve them'}`,
          ].join('\n'),
        );
      }),
    );
  policy
    .command('test <capabilityId>')
    .description('evaluate the promotion gate for one capability without recording anything')
    .option('--host <host>', 'target host', 'claude-code')
    .action(
      action((ctx, id: string, opts: { host: string }) =>
        guard(() => {
          const g = promotionPolicy(ctx.sys, depsFor(ctx.sys)).evaluate(id, opts.host) as any;
          ctx.out(g, () => `${gateText(g)}\ndecided by: ${g.rule?.explanation ?? 'built-in checks'}`);
        }),
      ),
    );
  policy
    .command('set-rules <file>')
    .description('replace the rules with the JSON list in <file>; refused if any rule is invalid')
    .action(
      action(async (ctx, file: string) => {
        const fs = await import('node:fs');
        let rules: unknown;
        try {
          rules = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e: any) {
          throw new CliError(`Cannot read ${file}: ${e.message}`, EXIT.usage);
        }
        const errors = validateRules(rules);
        if (errors.length) throw new CliError(`Rules not saved:\n  ${errors.join('\n  ')}`, EXIT.usage);
        setSetting(ctx.sys.db, 'policy.rules', rules);
        emit(ctx.sys.db, 'policy.rules', null, { count: (rules as unknown[]).length });
        ctx.out({ ok: true, rules }, () => `${(rules as unknown[]).length} rule(s) saved`);
      }),
    );
}

export function registerAcquisition(program: Command) {
  program
    .command('evaluate [candidateId]')
    .description('acquire a candidate: quarantine, audit, score, test, register, gate')
    .option('--next <n>', 'process the next N candidates from the evaluation queue')
    .action(
      action(async (ctx, candidateId: string | undefined, opts: { next?: string }) => {
        const deps = depsFor(ctx.sys);
        if (!candidateId && !opts.next) throw new CliError('Give a candidate id or --next <n>', EXIT.usage, 'see the queue with: synaptome candidates --queue');
        const reports = candidateId ? [await guard(() => evaluateCandidate(ctx.sys, deps, candidateId))] : await evaluateQueue(ctx.sys, deps, Number(opts.next) || 1);
        ctx.out({ reports }, () =>
          reports
            .map((r) => ('error' in r ? `${r.candidateId}: FAILED ${r.error}` : [`${r.candidateId} -> ${r.capabilityId ?? '(not registered)'}  state=${r.state} tier=${r.tier} trust=${r.trust} score=${r.score ?? 'n/a'}`, `  ${r.summary}`, r.unknowns.length ? `  unknown evidence: ${r.unknowns.join(', ')}` : '', r.gate ? gateText(r.gate).replace(/^/gm, '  ') : '', r.autoInstalled.length ? `  auto-installed to sandbox: ${r.autoInstalled.join(', ')}` : ''].filter(Boolean).join('\n')))
            .join('\n\n'),
        );
      }),
    );

  const skills = program.command('skills').alias('capabilities').description('browse the canonical capability registry');
  const listOpts = (c: Command) =>
    c.option('-k, --kind <kind>').option('-d, --domain <domain>').option('--status <status>').option('--trust <trust>').option('--tier <tier>').option('--origin <origin>', 'discovered | host-inventory | forge').option('--installed', 'only installed').option('--min-quality <n>').option('--sort <key>', 'relevance | quality | name | updated').option('-n, --limit <n>', 'rows', '25');
  const runList = (ctx: Ctx, q: string | undefined, o: any) => {
    const r = listCapabilities(ctx.sys, { q, kind: o.kind, domain: o.domain, status: o.status, trust: o.trust, tier: o.tier, origin: o.origin, installed: o.installed ? true : undefined, minQuality: o.minQuality ? Number(o.minQuality) : undefined, sort: o.sort, limit: Number(o.limit) || 25 });
    ctx.out(r, () => `${r.total} capability(ies)${q ? ` matching "${q}"` : ''}\n` + table(r.items.map((c) => ({ id: c.id, kind: c.kind, domain: c.domain, status: c.status, tier: c.tier, q: c.quality == null ? '' : c.quality.toFixed(0), installed: c.installedHosts.join(' '), description: c.description })), [{ key: 'id', max: 44 }, { key: 'kind' }, { key: 'domain' }, { key: 'status' }, { key: 'tier' }, { key: 'q' }, { key: 'installed', max: 22 }, { key: 'description', max: 60 }]));
  };
  listOpts(skills.command('search <query>').description('full-text search')).action(action((ctx, query: string, o: any) => runList(ctx, query, o)));
  listOpts(skills.command('list', { isDefault: true }).description('list with filters')).action(action((ctx, o: any) => runList(ctx, undefined, o)));
  skills.command('facets').description('counts per kind, domain, status, trust, tier').action(action((ctx) => { const fct = facets(ctx.sys); ctx.out(fct, () => Object.entries(fct).map(([k, v]) => `${k}: ${v.map((x) => `${x.v}=${x.n}`).join('  ')}`).join('\n')); }));

  program
    .command('inspect <capabilityId>')
    .description('full dossier: metadata, provenance, audit findings, score evidence, gate, installs')
    .option('--content', 'print the entry file')
    .action(
      action((ctx, id: string, opts: { content?: boolean }) => {
        const d = capabilityDossier(ctx.sys, id);
        if (!d) throw new CliError(`No capability "${id}"`, EXIT.notFound, 'find ids with: synaptome skills search <text>');
        const c = d.capability;
        const entry = opts.content ? readCapabilityEntry(ctx.sys, id) : null;
        ctx.out({ ...d, entry }, () =>
          [
            kv([['id', c.id], ['name', c.name], ['kind / domain', `${c.kind} / ${c.domain}`], ['status', `${c.status}   (approved ≠ installed ≠ activated)`], ['trust / tier', `${c.trust} / ${c.tier}`], ['publisher', c.publisher], ['source', `${c.record.provenance.sourceId}  ${c.record.provenance.url}`], ['pinned commit', c.record.commit], ['provenance', `${c.record.provenance.verified ? 'verified' : 'NOT verified'} — ${c.record.provenance.method}`], ['licence', `${c.record.license.spdx || 'unknown'} (${c.record.license.compatible}) — ${c.record.license.evidence}`], ['context cost', `≈ ${c.contextCost} tokens (estimate)`], ['installed', c.installedHosts.join(', ') || 'no'], ['description', c.description]]),
            '', d.score ? `quality score ${d.score.total}` : 'quality score: none', ...(d.score ? Object.entries<any>(d.score.dimensions).map(([k, v]) => `  ${k.padEnd(18)} ${v.score == null ? ' ? ' : String(v.score).padStart(3)}  ${v.evidence}`) : []),
            '', d.audit ? `audit #${d.audit.id}: ${d.audit.summary}` : 'no audit', ...(d.audit?.findings ?? []).slice(0, 20).map((f: any) => `  ${f.severity.padEnd(8)} ${f.id}  ${f.file}${f.line ? ':' + f.line : ''}  ${f.message}`),
            '', d.gate ? gateText(d.gate) : 'gate: not evaluated',
            ...(d.installations.length ? ['', 'installations:', ...d.installations.map((i) => `  ${i.id}  ${i.host}/${i.scope}  ${i.status}  ${i.targetPath}`)] : []),
            ...(d.versions.length ? ['', 'versions:', ...d.versions.map((v: any) => `  ${String(v.content_hash).slice(0, 12)}  ${v.ref ?? ''}  ${v.created_at}`)] : []),
            ...(entry ? ['', `--- ${entry.path} (untrusted content, shown as data) ---`, entry.content] : []),
          ].join('\n'),
        );
      }),
    );

  program
    .command('approve <capabilityId>')
    .description('approve a registered capability (does not install it)')
    .option('--host <host>', 'host the gate is evaluated for', 'claude-code')
    .option('--accept-licence <reason>', 'record that you accept an unknown or non-allow-listed licence for local use')
    .action(action(async (ctx, id: string, opts: { host: string; acceptLicence?: string }) => { const g = await guard(() => approve(ctx.sys, depsFor(ctx.sys), id, opts)); ctx.out({ ok: true, capabilityId: id, status: 'approved', gate: g }, () => `approved ${id}\n${gateText(g)}`); }));

  program
    .command('reject <capabilityId>')
    .description('reject a capability')
    .option('-r, --reason <text>', 'why', 'rejected by user')
    .action(action(async (ctx, id: string, opts: { reason: string }) => { await guard(() => reject(ctx.sys, id, opts.reason)); ctx.out({ ok: true, capabilityId: id, status: 'rejected' }, () => `rejected ${id}`); }));

  program
    .command('install <capabilityId>')
    .description('install an approved capability for a host (staged sandbox by default)')
    .option('--host <host>', 'target host', 'claude-code')
    .option('--real', 'install into the real host directory (needs --yes, a prior staged install, and budget)')
    .option('--yes', 'confirm a real install')
    .option('--project <dir>', "project whose .mcp.json receives an MCP server (default: setting hosts.claudeProject); user-scope config is never written")
    .option('--dry-run', 'show what would happen without writing')
    .action(
      action(async (ctx, id: string, opts: { host: string; real?: boolean; yes?: boolean; dryRun?: boolean; project?: string }) => {
        const deps = depsFor(ctx.sys, { project: opts.project });
        const scope = opts.real ? 'real' : 'sandbox';
        if (opts.dryRun) {
          const d = capabilityDossier(ctx.sys, id);
          if (!d) throw new CliError(`No capability "${id}"`, EXIT.notFound);
          const adapter = await guard(() => deps.adapters.get(opts.host));
          let target = '';
          try { target = adapter.targetFor(d.capability as any, scope, ctx.sys.paths.sandboxHosts); } catch (e: any) { target = `(unavailable: ${e.message})`; }
          const plan = { capabilityId: id, host: opts.host, scope, target, status: d.capability.status, wouldProceed: d.capability.status === 'approved', files: d.capability.record.fileCount, adapter: adapter.status };
          ctx.out({ dryRun: true, ...plan }, () => `dry run — nothing written\n${kv(Object.entries(plan))}`);
          return;
        }
        const inst = await guard(() => install(ctx.sys, deps, id, { host: opts.host, scope, confirmReal: !!opts.yes }));
        ctx.out({ ok: true, installation: inst }, () => `installed ${id}\n${kv([['installation', inst.id], ['host / scope', `${inst.host} / ${inst.scope}`], ['target', inst.targetPath], ['verified', inst.verifyDetail], ['rollback', `synaptome rollback ${inst.id}`]])}`);
      }),
    );

  program
    .command('downgrade <capabilityId>')
    .description('install an earlier version that was installed and verified before (see versions with: synaptome inspect <id>)')
    .requiredOption('--to <contentHash>', 'the version to return to: its content hash, or at least its first 8 characters')
    .option('--host <host>', 'target host', 'claude-code')
    .option('--real', 'downgrade the real host directory (needs --yes and a staged install of that version)')
    .option('--yes', 'confirm a real downgrade')
    .action(
      action(async (ctx, id: string, opts: { to: string; host: string; real?: boolean; yes?: boolean }) => {
        const inst = await guard(() => downgrade(ctx.sys, depsFor(ctx.sys), id, { host: opts.host, scope: opts.real ? 'real' : 'sandbox', contentHash: opts.to, confirmReal: !!opts.yes }));
        ctx.out({ ok: true, installation: inst }, () => `installed earlier version ${inst.contentHash.slice(0, 12)} of ${id}\n${kv([['installation', inst.id], ['target', inst.targetPath], ['verified', inst.verifyDetail], ['undo', `synaptome rollback ${inst.id}`]])}`);
      }),
    );

  for (const [name, fn, desc] of [['rollback', rollback, 'undo an installation (puts back exactly what it replaced, if anything)'], ['uninstall', uninstall, 'remove an installation; or, with --everything, undo everything Synaptome created on this machine']] as const) {
    const cmd = program
      .command(`${name} ${name === 'uninstall' ? '[installationId]' : '<installationId>'}`)
      .description(desc)
      .option('--force', 'proceed even though the installed files were edited afterwards (a copy of the edited files is kept first)');
    if (name === 'uninstall')
      cmd
        .option('--everything', 'roll back every installation and disconnect every project this home made (lists only, without --yes)')
        .option('--yes', 'with --everything: do it')
        .option('--delete-data', 'with --everything --yes: also delete the home folder (registry, history, backups)');
    cmd.action(
        action(async (ctx, id: string | undefined, opts: { force?: boolean; everything?: boolean; yes?: boolean; deleteData?: boolean }) => {
          if (name === 'uninstall' && opts.everything) {
            if (id) throw new CliError('Give an installation id or --everything, not both', EXIT.usage);
            const { uninstallEverything } = await import('./setup');
            return uninstallEverything(ctx, opts);
          }
          if (!id) throw new CliError(`Missing installation id`, EXIT.usage, `list them with: synaptome installs${name === 'uninstall' ? '   (or remove everything: synaptome uninstall --everything)' : ''}`);
          if (opts.yes || opts.deleteData) throw new CliError('--yes and --delete-data only apply with --everything', EXIT.usage);
          const r = await guard(() => fn(ctx.sys, depsFor(ctx.sys), id, { force: !!opts.force }));
          ctx.out({ ok: true, installation: r }, () =>
            [`${r.status.replace('_', ' ')}: ${id}`, `  target ${r.targetPath} ${r.restored ? `restored to installation ${r.restored} (from ${r.restoredFrom})` : r.restoredFrom ? `restored to what was there before (from ${r.restoredFrom})` : 'removed'}`, ...(r.preserved ? [`  your edited files were copied to ${r.preserved}`] : [])].join('\n'),
          );
        }),
      );
  }

  program
    .command('installs')
    .description('installation queue and history')
    .option('--all', 'include skills that were already on the host before Synaptome')
    .option('--status <status>')
    .action(
      action((ctx, opts: { all?: boolean; status?: string }) => {
        const rows = listInstallations(ctx.sys, { managedOnly: !opts.all, status: opts.status });
        const pending = listCapabilities(ctx.sys, { status: 'registered', origin: 'discovered', limit: 100 }).items;
        const ready = listCapabilities(ctx.sys, { status: 'approved', installed: false, limit: 100 }).items;
        ctx.out({ pendingApproval: pending, approvedNotInstalled: ready, installations: rows }, () =>
          [`pending approval (${pending.length}):`, table(pending.map((c) => ({ id: c.id, tier: c.tier, q: c.quality ?? '', name: c.name })), [{ key: 'id', max: 44 }, { key: 'tier' }, { key: 'q' }, { key: 'name', max: 40 }]), '', `approved, not installed (${ready.length}):`, table(ready.map((c) => ({ id: c.id, tier: c.tier })), [{ key: 'id', max: 44 }, { key: 'tier' }]), '', `installations (${rows.length}):`, table(rows.map((r) => ({ ...r, when: r.createdAt.slice(0, 19).replace('T', ' ') })), [{ key: 'id' }, { key: 'capabilityId', title: 'capability', max: 36 }, { key: 'host' }, { key: 'scope' }, { key: 'status' }, { key: 'when' }])].join('\n'),
        );
      }),
    );

  program
    .command('installation <id>')
    .description('one installation record')
    .action(action((ctx, id: string) => { const i = getInstallation(ctx.sys, id); if (!i) throw new CliError(`No installation "${id}"`, EXIT.notFound); ctx.out(i, () => kv(Object.entries(i))); }));

  program
    .command('inventory')
    .description('index the skills already installed for Claude Code (read-only) and audit them')
    .action(
      action(async (ctx) => {
        if (!ctx.json) process.stderr.write('indexing local Claude Code skills (read-only)...\n');
        const r = await ingestInventory(ctx.sys, depsFor(ctx.sys));
        ctx.out(r, () => [`scanned ${r.scanned}, indexed ${r.indexed}, unchanged ${r.unchanged}, failed ${r.failed}`, `tiers: A=${r.tiers.A} B=${r.tiers.B} C=${r.tiers.C}`, ...(r.flagged.length ? ['', 'flagged for review (critical findings; nothing was changed on disk):', ...r.flagged.slice(0, 30).map((x) => `  ${x.id}\n    ${x.reasons.join('\n    ')}`)] : [])].join('\n'));
      }),
    );

  program
    .command('audit')
    .description('security overview: blocked items, quarantine, critical findings, trust levels')
    .action(
      action((ctx) => {
        const blockedCands = listCandidates(ctx.sys, { state: 'blocked', limit: 100 }).items;
        const blockedCaps = listCapabilities(ctx.sys, { status: 'blocked', limit: 200 }).items;
        const recent = ctx.sys.db.all<any>('SELECT id, subject_type, subject_id, tier, trust, critical, summary, created_at FROM audits ORDER BY id DESC LIMIT 15');
        const fct = facets(ctx.sys);
        ctx.out({ blockedCandidates: blockedCands, blockedCapabilities: blockedCaps, trust: fct.trust, tiers: fct.tier, recentAudits: recent, adapters: [...depsFor(ctx.sys).adapters.list().map((a) => ({ id: a.id, status: a.status, evidence: a.statusEvidence })), ...UNSUPPORTED_HOSTS.map((h) => ({ id: h.id, status: h.status, evidence: h.reason }))] }, () =>
          [`trust: ${fct.trust.map((x) => `${x.v}=${x.n}`).join('  ') || '-'}`, `tiers: ${fct.tier.map((x) => `${x.v}=${x.n}`).join('  ') || '-'}`, '', `quarantined and blocked candidates (${blockedCands.length}):`, table(blockedCands.map((c) => ({ id: c.id, name: c.name, source: c.sourceId })), [{ key: 'id' }, { key: 'name', max: 40 }, { key: 'source' }]), '', `blocked capabilities (${blockedCaps.length}):`, table(blockedCaps.slice(0, 20).map((c) => ({ id: c.id, origin: c.origin })), [{ key: 'id', max: 50 }, { key: 'origin' }]), '', 'recent audits:', table(recent, [{ key: 'id' }, { key: 'subject_type', title: 'type' }, { key: 'subject_id', title: 'subject', max: 20 }, { key: 'tier' }, { key: 'critical', title: 'crit' }, { key: 'summary', max: 70 }])].join('\n'),
        );
      }),
    );

  const update = program.command('update').description('update management (nothing is applied without an explicit command)');
  update.command('check', { isDefault: true }).description('ask sources whether acquired capabilities changed upstream').action(
    action(async (ctx) => {
      const r = await checkUpdates(ctx.sys, depsFor(ctx.sys).connectors);
      ctx.out({ checked: r.length, changed: r.filter((x) => x.changed).length, results: r }, () => (r.length ? table(r.map((x) => ({ ...x, changed: x.changed ? 'UPDATE' : '' })), [{ key: 'id' }, { key: 'name', max: 30 }, { key: 'changed' }, { key: 'detail', max: 70 }]) : 'no acquired capabilities to check yet'));
    }),
  );
  update.command('inspect <candidateId>').description('stage and audit the new upstream version; show the diff and risk changes').action(
    action(async (ctx, id: string) => {
      const r = await guard(() => inspectUpdate(ctx.sys, depsFor(ctx.sys), id));
      ctx.out(r, () => kv([['verdict', r.verdict], ['reasons', r.reasons.join('; ') || 'none'], ['ref', `${r.fromRef?.slice(0, 10)} -> ${r.toRef?.slice(0, 10)}`], ['tier', `${r.tier.from} -> ${r.tier.to}`], ['licence', `${r.licence.from || '?'} -> ${r.licence.to || '?'}`], ['added', r.files.added.join(', ') || '-'], ['removed', r.files.removed.join(', ') || '-'], ['changed', r.files.changed.join(', ') || '-'], ['new permissions', r.permissionsAdded.join(', ') || 'none']]));
    }),
  );
  update.command('apply <candidateId>').description('re-run acquisition at the new upstream version (previous version is kept for rollback)').action(
    action(async (ctx, id: string) => {
      const r = await guard(() => applyUpdate(ctx.sys, depsFor(ctx.sys), id));
      ctx.out(r, () => `${r.candidateId} -> ${r.capabilityId}: ${r.summary}`);
    }),
  );
}
