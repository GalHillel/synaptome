import { useEffect, useState } from 'react';
import { Button, type Col, DataTable, Empty, KV, Loaded, Mark, PageHeader, Quality, Tier, ago, useApp, useDebounced, useQuery, when } from './lib';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const sum = (o: Record<string, number> = {}) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';

/* =====================================================================
 * Overview — every figure is read from the database; nothing is decorative.
 * ===================================================================== */
export function Overview() {
  const { go, events } = useApp();
  const q = useQuery('system.overview');
  const diag = useQuery('system.diagnostics', {}, { live: false });
  return (
    <>
      <PageHeader title="Overview">What the system knows and what needs a decision.</PageHeader>
      <Loaded q={q}>
        {(o) => (
          <>
            <dl className="ledger">
              {(
                [
                  ['Capabilities', o.capabilities.total, sum(o.capabilities.byStatus), 'library'],
                  ['Pending approval', o.pendingApproval, 'registered, awaiting a decision', 'queue'],
                  ['Managed installs', o.installations.active, `${o.installations.real} in real host dirs · ${o.installations.external} pre-existing`, 'queue'],
                  ['Candidates', o.candidates.total, sum(o.candidates.byState), 'discovery'],
                  ['Blocked', o.security.blocked, `${o.security.criticalAudits} audits with critical findings`, 'security'],
                  ['Routing decisions', o.routing.decisions, `${o.routing.activations} activations · ${o.routing.openGaps} open gaps`, 'routing'],
                  ['Forge candidates', o.forge.candidates, `${o.forge.evalRuns} evaluation runs recorded`, 'forge'],
                  ['Updates available', o.candidates.updates, 'upstream changed since audit', 'discovery'],
                ] as const
              ).map(([label, value, note, view]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="num"><button onClick={() => go(view)} aria-label={`${label}: ${value}. Open ${view}`}>{value}</button></dd>
                  <dd className="ledger-note">{note}</dd>
                </div>
              ))}
            </dl>
            <div className="cols">
              <section>
                <h2 className="sect">Discovery sources</h2>
                <DataTable
                  label="Discovery sources"
                  rows={o.sources}
                  rowKey={(s: any) => s.id}
                  cols={[
                    { key: 'id', title: 'Source', render: (s: any) => <span className="name">{s.title}</span> },
                    { key: 'h', title: 'Health', width: '120px', render: (s: any) => <Mark s={s.health} /> },
                    { key: 'l', title: 'Last scan', width: '110px', render: (s: any) => <span className="muted">{ago(s.last_scan_at)}</span> },
                  ]}
                />
                <p className="muted">
                  {o.lastScan ? `Last scan #${o.lastScan.id}: ${o.lastScan.source_id}, ${o.lastScan.mode}, ${o.lastScan.found} found, ${o.lastScan.added} new.` : 'No scan has run yet.'}{' '}
                  <a href="#discovery" onClick={(e) => (e.preventDefault(), go('discovery'))}>
                    Open Discovery
                  </a>
                </p>
              </section>
              <section>
                <h2 className="sect">Recent activity</h2>
                {events.length ? (
                  <DataTable
                    label="Recent events"
                    rows={events.slice(0, 9)}
                    rowKey={(e: any) => String(e.id)}
                    cols={[
                      { key: 't', title: 'When', width: '88px', render: (e: any) => <span className="muted num">{e.ts.slice(11, 19)}</span> },
                      { key: 'e', title: 'Event', width: '42%', render: (e: any) => <span className="mono">{e.type}</span> },
                      { key: 's', title: 'Subject', render: (e: any) => <span className="muted">{e.subject}</span> },
                    ]}
                  />
                ) : (
                  <p className="muted">Nothing has happened since this page was opened. Events appear here live.</p>
                )}
              </section>
            </div>
          </>
        )}
      </Loaded>
      <h2 className="sect">
        Diagnostics <button className="btn quiet" onClick={diag.reload}>Run again</button>
      </h2>
      <Loaded q={diag} rows={4}>
        {(d: any[]) => (
          <DataTable
            label="Diagnostics"
            rows={d}
            rowKey={(x) => x.id}
            cols={[
              { key: 's', title: 'Result', width: '90px', render: (x) => <Mark s={x.status} label={x.status === 'ok' ? 'ok' : x.status === 'warn' ? 'warning' : 'failed'} /> },
              { key: 'l', title: 'Check', width: '230px', render: (x) => x.label },
              { key: 'd', title: 'Detail', render: (x) => <span className="muted">{x.detail}</span> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Capability Library
 * ===================================================================== */
export function Library() {
  const { params, go, open, selection } = useApp();
  const [f, setF] = useState<Record<string, string>>({ kind: '', domain: '', status: '', trust: '', tier: '', origin: '', installed: '', sort: '' });
  const q = useDebounced(params.q ?? '');
  const facets = useQuery('capabilities.facets');
  const list = useQuery('capabilities.list', { q, ...f, installed: f.installed === '' ? undefined : f.installed === 'yes', limit: 120 });
  const sel = (key: string, label: string) => (
    <select className="field" aria-label={label} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
      <option value="">{label}: all</option>
      {(facets.data?.[key] ?? []).map((x: any) => (
        <option key={x.v} value={x.v}>
          {x.v} ({x.n})
        </option>
      ))}
    </select>
  );
  const cols: Col<any>[] = [
    { key: 'n', title: 'Capability', width: '25%', render: (c) => <span className="name">{c.name}</span> },
    { key: 'k', title: 'Kind', width: '78px', cls: 'hide-sm', render: (c) => <span className="muted">{c.kind}</span> },
    { key: 'd', title: 'Domain', width: '104px', cls: 'hide-sm', render: (c) => <span className="muted">{c.domain}</span> },
    { key: 's', title: 'Status', width: '112px', render: (c) => <Mark s={c.status} /> },
    { key: 't', title: 'Tier', width: '48px', render: (c) => <Tier t={c.tier} /> },
    { key: 'q', title: 'Quality', width: '108px', render: (c) => <Quality q={c.quality} /> },
    { key: 'i', title: 'Installed', width: '112px', cls: 'hide-sm', render: (c) => (c.installedHosts.length ? <Mark s="installed" label={c.installedHosts.map((h: string) => h.split(':')[1]).join(', ')} /> : <span className="faint">no</span>) },
    { key: 'desc', title: 'Description', cls: 'hide-sm', render: (c) => <span className="muted">{c.description}</span> },
  ];
  return (
    <>
      <PageHeader title="Capability Library">The canonical registry. Registered is not approved; approved is not installed.</PageHeader>
      <div className="toolbar" role="search">
        <input className="field grow" type="search" placeholder="Search names, descriptions, tags and content" aria-label="Search capabilities" value={params.q ?? ''} onChange={(e) => go('library', { q: e.target.value })} />
        {sel('kind', 'Kind')}
        {sel('domain', 'Domain')}
        {sel('status', 'Status')}
        {sel('trust', 'Trust')}
        {sel('tier', 'Tier')}
        {sel('origin', 'Origin')}
        <select className="field" aria-label="Installed" value={f.installed} onChange={(e) => setF({ ...f, installed: e.target.value })}>
          <option value="">Installed: any</option>
          <option value="yes">installed</option>
          <option value="no">not installed</option>
        </select>
        <select className="field" aria-label="Sort" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
          <option value="">Sort: {q ? 'relevance' : 'name'}</option>
          <option value="quality">quality</option>
          <option value="updated">recently updated</option>
          <option value="name">name</option>
        </select>
      </div>
      <Loaded q={list} rows={12}>
        {(r) =>
          r.items.length ? (
            <>
              <p className="muted" aria-live="polite">
                {r.total} capabilit{r.total === 1 ? 'y' : 'ies'}
                {r.total > r.items.length ? `, showing the first ${r.items.length}` : ''}
              </p>
              <DataTable label="Capabilities" rows={r.items} cols={cols} rowKey={(c) => c.id} selected={selection?.type === 'capability' ? selection.id : null} onOpen={(c) => open({ type: 'capability', id: c.id })} />
            </>
          ) : (
            <Empty title={q || Object.values(f).some(Boolean) ? 'Nothing matches these filters' : 'The registry is empty'}>
              {q || Object.values(f).some(Boolean) ? 'Clear a filter or search for a broader term.' : 'Run a scan in Discovery, or index the skills already on this machine with “synaptome inventory”.'}
            </Empty>
          )
        }
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Discovery
 * ===================================================================== */
export function Discovery() {
  const { run, open, selection } = useApp();
  const sources = useQuery('sources.list');
  const [state, setState] = useState('');
  const [text, setText] = useState('');
  const cands = useQuery('candidates.list', { state, q: useDebounced(text), limit: 120 });
  const scans = useQuery('scans.list', { limit: 8 });
  const [mode, setMode] = useState('broad');
  const [query, setQuery] = useState('');
  const start = () => {
    const repo = /^[\w.-]+\/[\w.-]+$/.test(query.trim()) && mode === 'repo' ? query.trim() : undefined;
    return run('scan.run', mode === 'repo' ? { repo: repo ?? query.trim() } : { mode, query: query.trim() || undefined }, (r: any) => r.reports.map((x: any) => `${x.sourceId}: ${x.status}, ${x.added} new`).join(' · '));
  };
  return (
    <>
      <PageHeader title="Discovery" actions={<Button onClick={() => run('sources.check', {}, 'Source health checked')}>Check sources</Button>}>
        Find capabilities across sources. Results are ranked for triage; quality is only assigned after audit.
      </PageHeader>
      <Loaded q={sources} rows={3}>
        {(s: any[]) => (
          <DataTable
            label="Sources"
            rows={s}
            rowKey={(x) => x.id}
            cols={[
              { key: 't', title: 'Source', width: '210px', render: (x) => <span className="name">{x.title}</span> },
              { key: 'h', title: 'Health', width: '120px', render: (x) => <Mark s={x.health} /> },
              { key: 'c', title: 'Candidates', width: '90px', cls: 'r', render: (x) => <span className="num">{x.candidates}</span> },
              { key: 'l', title: 'Last scan', width: '110px', render: (x) => <span className="muted">{ago(x.lastScanAt)}</span> },
              { key: 'd', title: 'Detail', cls: 'hide-sm', render: (x) => <span className="muted">{x.healthDetail ?? x.description}</span> },
            ]}
          />
        )}
      </Loaded>
      <h2 className="sect">Start a scan</h2>
      <form className="toolbar" onSubmit={(e) => (e.preventDefault(), void start())}>
        <select className="field" aria-label="Scan mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="broad">Broad discovery</option>
          <option value="incremental">Incremental (changes since last scan)</option>
          <option value="need">Need-driven (search for a topic)</option>
          <option value="repo">One GitHub repository</option>
        </select>
        <input className="field grow" aria-label={mode === 'repo' ? 'Repository' : 'Query'} placeholder={mode === 'repo' ? 'owner/name' : mode === 'need' ? 'what are you looking for?' : 'optional topic'} value={query} onChange={(e) => setQuery(e.target.value)} required={mode === 'need' || mode === 'repo'} />
        <Button kind="primary" onClick={start} disabled={(mode === 'need' || mode === 'repo') && !query.trim()}>
          Scan GitHub and MCP registry
        </Button>
      </form>
      <h2 className="sect">
        Candidates <span className="n">{cands.data?.total ?? ''}</span>
      </h2>
      <div className="toolbar">
        <input className="field grow" type="search" placeholder="Filter candidates" aria-label="Filter candidates" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="field" aria-label="State" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">State: all</option>
          {['queued', 'discovered', 'quarantined', 'audited', 'registered', 'blocked', 'rejected'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <Button onClick={() => run('queue.evaluateNext', { n: 3 }, (r: any[]) => `${r.length} candidate(s) evaluated`)} title="Quarantine, audit, score and gate the three highest-ranked queued candidates">
          Evaluate next 3 in queue
        </Button>
      </div>
      <Loaded q={cands} rows={10}>
        {(r) =>
          r.items.length ? (
            <DataTable
              label="Candidates"
              rows={r.items}
              rowKey={(c: any) => c.id}
              selected={selection?.type === 'candidate' ? selection.id : null}
              onOpen={(c: any) => open({ type: 'candidate', id: c.id })}
              cols={[
                { key: 'r', title: 'Rank', width: '52px', cls: 'r', render: (c: any) => <span className="num">{c.rank.toFixed(0)}</span> },
                { key: 'n', title: 'Candidate', width: '26%', render: (c: any) => <span className="name">{c.name}</span> },
                { key: 'k', title: 'Kind', width: '92px', render: (c: any) => <span className="muted">{c.kind}</span> },
                { key: 's', title: 'State', width: '118px', render: (c: any) => <Mark s={c.state} /> },
                { key: 'src', title: 'Source', width: '110px', cls: 'hide-sm', render: (c: any) => <span className="muted">{c.sourceId}</span> },
                { key: 'l', title: 'Licence', width: '98px', cls: 'hide-sm', render: (c: any) => (c.licenseSpdx ? <span className="mono">{c.licenseSpdx}</span> : <span className="faint">unknown</span>) },
                { key: 'a', title: 'Next step', cls: 'hide-sm', render: (c: any) => <span className="muted">{c.updateAvailable ? 'update available · ' : ''}{c.recommendedAction}</span> },
              ]}
            />
          ) : (
            <Empty title="No candidates yet">Start a scan above. Discovered capabilities appear here, ranked, with a recommended next step.</Empty>
          )
        }
      </Loaded>
      <h2 className="sect">Scan history</h2>
      <Loaded q={scans} rows={3}>
        {(s: any[]) =>
          s.length ? (
            <DataTable
              label="Scan history"
              rows={s}
              rowKey={(x) => String(x.id)}
              cols={[
                { key: 'w', title: 'Started', width: '128px', render: (x) => <span className="muted num">{when(x.started_at)}</span> },
                { key: 's', title: 'Source', width: '120px', render: (x) => x.source_id },
                { key: 'm', title: 'Mode', width: '96px', render: (x) => <span className="muted">{x.mode}</span> },
                { key: 'st', title: 'Result', width: '110px', render: (x) => <Mark s={x.status} /> },
                { key: 'f', title: 'Found / new', width: '100px', cls: 'r', render: (x) => <span className="num">{x.found} / {x.added}</span> },
                { key: 'q', title: 'Query or error', cls: 'hide-sm', render: (x) => <span className="muted">{x.error ?? x.query ?? ''}</span> },
              ]}
            />
          ) : (
            <p className="muted">No scans recorded.</p>
          )
        }
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Installation Queue
 * ===================================================================== */
export function Queue() {
  const { open, run, confirm } = useApp();
  const q = useQuery('queue.get');
  const approve = async (c: any) => {
    const lic = c.record.license.compatible;
    const ok = await confirm({
      title: `Approve ${c.name}?`,
      body: <p>Approval makes it installable and routable. It does not install anything.</p>,
      consequences: [`Tier ${c.tier}; quality ${c.quality ?? 'not scored'}`, ...(c.gate?.checks ?? []).filter((x: any) => x.result !== 'pass').map((x: any) => `${x.result === 'fail' ? 'Failed' : 'Unknown'}: ${x.label} — ${x.evidence}`)],
      confirmLabel: 'Approve',
      input: lic === 'yes' ? undefined : { label: `Licence is ${lic === 'no' ? c.record.license.spdx + ' (not on the allow list)' : 'unknown'}. State why you accept it for local use`, required: true },
    });
    if (ok) await run('capabilities.approve', { id: c.id, acceptLicence: ok.input || undefined }, `${c.name} approved`);
  };
  const rejectIt = async (c: any) => {
    const ok = await confirm({ title: `Reject ${c.name}?`, consequences: ['It stays in the registry as rejected and will not be routed or installed.'], confirmLabel: 'Reject', danger: true, input: { label: 'Reason', placeholder: 'optional' } });
    if (ok) await run('capabilities.reject', { id: c.id, reason: ok.input }, `${c.name} rejected`);
  };
  const undo = async (i: any, kind: 'rollback' | 'uninstall') => {
    const ok = await confirm({ title: `${kind === 'rollback' ? 'Roll back' : 'Uninstall'} ${i.name ?? i.capabilityId}?`, consequences: [`Removes ${i.targetPath}`, kind === 'rollback' && i.previousId ? `Restores the previous version (${i.previousId})` : 'The capability stays approved in the registry', i.scope === 'real' ? 'This changes a real host directory' : 'This only affects the staged sandbox host'], confirmLabel: kind === 'rollback' ? 'Roll back' : 'Uninstall', danger: true });
    if (ok) await run(`installations.${kind}`, { id: i.id }, (r: any) => `${r.status.replace('_', ' ')}: ${i.name ?? i.capabilityId}`);
  };
  return (
    <>
      <PageHeader title="Installation Queue">Review, approve, install per host, and undo. Real host installs are never automatic.</PageHeader>
      <Loaded q={q} rows={8}>
        {(d) => (
          <>
            <div className="note">
              Real-install budget: <strong>{d.realBudget.used} of {d.realBudget.limit}</strong> used. Installs made here go to the staged sandbox host. A real install needs the CLI with <span className="mono">--real --yes</span>, a verified staged install of the same version, and free budget.
            </div>
            <h2 className="sect">
              Pending approval <span className="n">{d.pendingApproval.length + d.forgePending.length}</span>
            </h2>
            {d.pendingApproval.length + d.forgePending.length ? (
              <DataTable
                label="Pending approval"
                rows={[...d.pendingApproval, ...d.forgePending]}
                rowKey={(c: any) => c.id}
                onOpen={(c: any) => open({ type: 'capability', id: c.id })}
                cols={[
                  { key: 'n', title: 'Capability', width: '24%', render: (c: any) => <span className="name">{c.name}</span> },
                  { key: 't', title: 'Tier', width: '48px', render: (c: any) => <Tier t={c.tier} /> },
                  { key: 'q', title: 'Quality', width: '108px', render: (c: any) => <Quality q={c.quality} /> },
                  { key: 'g', title: 'Gate', width: '150px', render: (c: any) => (c.gate ? <Mark s={c.gate.decision} /> : <span className="faint">not evaluated</span>) },
                  { key: 'w', title: 'Why it is waiting', cls: 'hide-sm', render: (c: any) => <span className="muted">{(c.gate?.checks ?? []).filter((x: any) => x.result !== 'pass').map((x: any) => x.label).join('; ') || (c.origin === 'forge' ? 'forge candidate under evaluation' : '')}</span> },
                  {
                    key: 'a', title: 'Decision', width: '170px',
                    render: (c: any) => (
                      <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 6 }}>
                        <Button onClick={() => approve(c)} disabled={c.gate?.decision === 'blocked' && c.record.license.compatible !== 'no'}>Approve…</Button>
                        <Button kind="quiet" onClick={() => rejectIt(c)}>Reject…</Button>
                      </span>
                    ),
                  },
                ]}
              />
            ) : (
              <Empty title="Nothing is waiting for a decision">Candidates arrive here after evaluation when the promotion gate cannot approve them automatically.</Empty>
            )}
            <h2 className="sect">
              Approved, not installed <span className="n">{d.approvedNotInstalled.length}</span>
            </h2>
            {d.approvedNotInstalled.length ? (
              <DataTable
                label="Approved, not installed"
                rows={d.approvedNotInstalled}
                rowKey={(c: any) => c.id}
                onOpen={(c: any) => open({ type: 'capability', id: c.id })}
                cols={[
                  { key: 'n', title: 'Capability', width: '30%', render: (c: any) => <span className="name">{c.name}</span> },
                  { key: 't', title: 'Tier', width: '48px', render: (c: any) => <Tier t={c.tier} /> },
                  { key: 'd', title: 'Description', cls: 'hide-sm', render: (c: any) => <span className="muted">{c.description}</span> },
                  { key: 'a', title: '', width: '170px', render: (c: any) => <span onClick={(e) => e.stopPropagation()}><Button onClick={() => run('capabilities.install', { id: c.id }, (r: any) => `Staged in sandbox: ${r.targetPath}`)}>Install to sandbox</Button></span> },
                ]}
              />
            ) : (
              <p className="muted">Every approved capability is installed somewhere, or none is approved yet.</p>
            )}
            <h2 className="sect">
              Installations <span className="n">{d.installations.length}</span>
            </h2>
            {d.installations.length ? (
              <DataTable
                label="Installations"
                rows={d.installations}
                rowKey={(i: any) => i.id}
                onOpen={(i: any) => open({ type: 'capability', id: i.capabilityId })}
                cols={[
                  { key: 'n', title: 'Capability', width: '24%', render: (i: any) => <span className="name">{i.name ?? i.capabilityId}</span> },
                  { key: 'h', title: 'Host / scope', width: '170px', render: (i: any) => <span className="muted">{i.host} / <strong>{i.scope}</strong></span> },
                  { key: 's', title: 'Status', width: '120px', render: (i: any) => <Mark s={i.status} /> },
                  { key: 'w', title: 'When', width: '128px', cls: 'hide-sm', render: (i: any) => <span className="muted num">{when(i.createdAt)}</span> },
                  { key: 'p', title: 'Target', cls: 'hide-sm', render: (i: any) => <span className="mono faint">{i.targetPath}</span> },
                  { key: 'a', title: '', width: '178px', render: (i: any) => (i.status === 'installed' ? <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 6 }}><Button onClick={() => undo(i, 'rollback')}>Roll back…</Button><Button kind="quiet" onClick={() => undo(i, 'uninstall')}>Uninstall…</Button></span> : null) },
                ]}
              />
            ) : (
              <Empty title="No managed installations">Approve a capability, then install it to the sandbox host.</Empty>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Security
 * ===================================================================== */
export function Security() {
  const { open } = useApp();
  const q = useQuery('security.get');
  const adapters = useQuery('system.adapters', {}, { live: false });
  return (
    <>
      <PageHeader title="Security">Everything imported is untrusted until audited. Blocked items stay in quarantine.</PageHeader>
      <Loaded q={q} rows={8}>
        {(d) => (
          <>
            <dl className="ledger">
              <div><dt>Blocked candidates</dt><dd className="num">{d.blockedCandidates.length}</dd><dd className="ledger-note">held in quarantine, never registered</dd></div>
              <div><dt>Blocked capabilities</dt><dd className="num">{d.blockedCapabilities.length}</dd><dd className="ledger-note">already on the host; excluded from routing</dd></div>
              <div><dt>Risk tiers</dt><dd className="num" style={{ fontSize: 18 }}>{d.tiers.map((t: any) => `${t.v} ${t.n}`).join(' · ') || '—'}</dd><dd className="ledger-note">A declarative · B needs approval · C blocked</dd></div>
              <div><dt>Trust</dt><dd style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>{d.trust.map((t: any) => `${t.n} ${t.v.toLowerCase().replace(/_/g, ' ')}`).join(' · ') || '—'}</dd></div>
            </dl>
            <h2 className="sect">Critical findings <span className="n">{d.criticalAudits.length}</span></h2>
            {d.criticalAudits.length ? (
              <DataTable
                label="Critical findings"
                rows={d.criticalAudits}
                rowKey={(a: any) => String(a.id)}
                onOpen={(a: any) => open(a.subject_type === 'candidate' || a.subject_type === 'update' ? { type: 'candidate', id: a.subject_id } : { type: 'capability', id: a.subject_id.startsWith('c-') ? '' : a.subject_id })}
                cols={[
                  { key: 'n', title: 'Subject', width: '22%', render: (a: any) => <span className="name">{a.name ?? a.subject_id}</span> },
                  { key: 't', title: 'Origin', width: '96px', render: (a: any) => <span className="muted">{a.subject_type}</span> },
                  { key: 'f', title: 'Finding', cls: 'wrap', render: (a: any) => a.findings.map((f: any, i: number) => <div key={i}>{f.message} <span className="mono faint">{f.file}{f.line ? `:${f.line}` : ''}</span></div>) },
                ]}
              />
            ) : (
              <Empty title="No critical findings recorded">Audits run automatically when a candidate is evaluated or the host inventory is indexed.</Empty>
            )}
            <h2 className="sect">Recent audits</h2>
            <DataTable
              label="Recent audits"
              rows={d.recentAudits}
              rowKey={(a: any) => String(a.id)}
              cols={[
                { key: 'w', title: 'When', width: '128px', render: (a: any) => <span className="muted num">{when(a.created_at)}</span> },
                { key: 'n', title: 'Subject', width: '24%', render: (a: any) => a.name ?? a.subject_id },
                { key: 't', title: 'Tier', width: '48px', render: (a: any) => <Tier t={a.tier} /> },
                { key: 's', title: 'Summary', cls: 'hide-sm', render: (a: any) => <span className="muted">{a.summary}</span> },
              ]}
            />
          </>
        )}
      </Loaded>
      <h2 className="sect">Host adapters</h2>
      <Loaded q={adapters} rows={4}>
        {(a: any[]) => (
          <DataTable
            label="Host adapters"
            rows={a}
            rowKey={(x) => x.id}
            cols={[
              { key: 't', title: 'Host', width: '180px', render: (x) => <span className="name">{x.title}</span> },
              { key: 's', title: 'Adapter status', width: '170px', render: (x) => <Mark s={x.status} /> },
              { key: 'd', title: 'Detected', width: '90px', render: (x) => (x.detected.present ? 'yes' : <span className="faint">no</span>) },
              { key: 'e', title: 'Evidence', cls: 'hide-sm', render: (x) => <span className="muted">{x.evidence}</span> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Routing Explorer
 * ===================================================================== */
export function Routing() {
  const { run, open, selection } = useApp();
  const [task, setTask] = useState('');
  const [discover, setDiscover] = useState(false);
  const [result, setResult] = useState<any>(null);
  const history = useQuery('routing.decisions', { limit: 25 });
  const gaps = useQuery('routing.gaps');
  const go = async () => {
    const r = await run('routing.route', { task, discover }, (d: any) => `Decision #${d.id}: ${d.selected.length} selected, ${d.gaps.length} gap(s)`);
    if (r) setResult(r);
  };
  return (
    <>
      <PageHeader title="Routing Explorer">Describe a task and see which capabilities would be used, why, and what is missing.</PageHeader>
      <form onSubmit={(e) => (e.preventDefault(), void go())}>
        <textarea className="field" rows={3} aria-label="Task" placeholder="e.g. Build an interactive WebGL product configurator with three.js" value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && void go()} />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <Button kind="primary" onClick={go} disabled={!task.trim()}>Route task</Button>
          <label className="inline"><input type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} /> search sources when a gap is found</label>
          <span className="faint">Ctrl+Enter</span>
        </div>
      </form>
      {result ? <Decision d={result} /> : null}
      <div className="cols">
        <section>
          <h2 className="sect">History</h2>
          <Loaded q={history} rows={5}>
            {(h: any[]) =>
              h.length ? (
                <DataTable
                  label="Routing history"
                  rows={h}
                  rowKey={(d) => String(d.id)}
                  selected={selection?.type === 'decision' ? selection.id : null}
                  onOpen={(d) => open({ type: 'decision', id: String(d.id) })}
                  cols={[
                    { key: 'i', title: '#', width: '44px', cls: 'r', render: (d) => <span className="num">{d.id}</span> },
                    { key: 'o', title: 'Via', width: '56px', render: (d) => <span className="muted">{d.origin}</span> },
                    { key: 's', title: 'Sel.', width: '44px', cls: 'r', render: (d) => <span className="num">{d.selected.length}</span> },
                    { key: 't', title: 'Task', render: (d) => d.task },
                  ]}
                />
              ) : (
                <p className="muted">No task has been routed yet.</p>
              )
            }
          </Loaded>
        </section>
        <section>
          <h2 className="sect">Capability gaps</h2>
          <Loaded q={gaps} rows={3}>
            {(g: any[]) =>
              g.length ? (
                <DataTable
                  label="Capability gaps"
                  rows={g}
                  rowKey={(x) => String(x.id)}
                  cols={[
                    { key: 't', title: 'Missing', width: '40%', render: (x) => <span className="name">{x.term}</span> },
                    { key: 'd', title: 'Domain', width: '90px', render: (x) => <span className="muted">{x.domain}</span> },
                    { key: 'h', title: 'Hits', width: '48px', cls: 'r', render: (x) => <span className="num">{x.hits}</span> },
                    { key: 's', title: 'Status', render: (x) => <span className="muted">{x.status}</span> },
                  ]}
                />
              ) : (
                <p className="muted">No gaps recorded. A gap appears when a task needs something the registry cannot supply.</p>
              )
            }
          </Loaded>
        </section>
      </div>
    </>
  );
}

export function Decision({ d }: { d: any }) {
  const { open } = useApp();
  return (
    <section aria-label="Routing decision">
      <h3>Decision #{d.id}</h3>
      <KV
        items={[
          ['Task', d.task],
          ['Classified as', `${d.analysis.complexity}${d.analysis.sensitivity === 'elevated' ? ' · elevated sensitivity' : ''}`],
          ['Domains', d.analysis.domains.map((x: any) => `${x.id} (${x.matched.join(', ')})`).join(' · ') || 'none recognised'],
        ]}
      />
      <h3>Selected <span className="n">{d.selected.length}</span></h3>
      {d.selected.length ? (
        <DataTable
          label="Selected capabilities"
          rows={d.selected}
          rowKey={(s: any) => s.capabilityId}
          onOpen={(s: any) => open({ type: 'capability', id: s.capabilityId })}
          cols={[
            { key: 'r', title: 'Role', width: '130px', render: (s: any) => <span className="muted">{s.role}</span> },
            { key: 'n', title: 'Capability', width: '24%', render: (s: any) => <span className="name">{s.name}</span> },
            { key: 's', title: 'Score', width: '60px', cls: 'r', render: (s: any) => <span className="num">{s.score.toFixed(2)}</span> },
            { key: 'w', title: 'Why', cls: 'wrap', render: (s: any) => <span className="muted">{s.reasons.join(' · ')}</span> },
          ]}
        />
      ) : (
        <div className="note">Nothing selected. The task proceeds without added capabilities.</div>
      )}
      {d.gaps.length ? d.gaps.map((g: any) => <div key={g.term} className="note warn"><strong>Gap in {g.domain}:</strong> {g.term} — {g.reason}</div>) : null}
      {d.excluded.length ? (
        <>
          <h3>Excluded</h3>
          <DataTable label="Excluded capabilities" rows={d.excluded} rowKey={(e: any) => e.capabilityId} cols={[{ key: 'n', title: 'Capability', width: '30%', render: (e: any) => e.name }, { key: 'r', title: 'Reason', render: (e: any) => <span className="muted">{e.reason}</span> }]} />
        </>
      ) : null}
      {d.plan.length ? (
        <>
          <h3>Plan</h3>
          <DataTable label="Plan" rows={d.plan} rowKey={(p: any) => String(p.step)} cols={[{ key: 's', title: 'Step', width: '50px', render: (p: any) => p.step }, { key: 'g', title: 'Stage', width: '100px', render: (p: any) => p.stage }, { key: 'c', title: 'Capabilities', width: '40%', render: (p: any) => <span className="mono">{p.capabilityIds.join(', ')}</span> }, { key: 'v', title: 'Verify', render: (p: any) => <span className="muted">{p.verify}</span> }]} />
        </>
      ) : null}
      {d.discovery?.length ? <div className="note">Need-driven discovery: {d.discovery.map((r: any) => `${r.sourceId} “${r.query}” → ${r.added} new`).join(' · ')}</div> : null}
      {d.activations?.length ? (
        <>
          <h3>Activations</h3>
          <DataTable label="Activations" rows={d.activations} rowKey={(a: any) => String(a.id)} cols={[{ key: 'c', title: 'Capability', width: '36%', render: (a: any) => a.name ?? a.capability_id }, { key: 'h', title: 'Host', width: '110px', render: (a: any) => a.host }, { key: 'w', title: 'Served', width: '128px', render: (a: any) => <span className="num muted">{when(a.served_at)}</span> }, { key: 'o', title: 'Outcome', render: (a: any) => (a.outcome ? <Mark s={a.outcome} /> : <span className="faint">not reported</span>) }]} />
        </>
      ) : null}
    </section>
  );
}

/* =====================================================================
 * Skill Forge
 * ===================================================================== */
export function Forge() {
  const { open, selection } = useApp();
  const q = useQuery('forge.list');
  const evals = useQuery('evals.list', { limit: 20 });
  return (
    <>
      <PageHeader title="Skill Forge">Gaps become candidate skills. A candidate is promoted only on measured evidence.</PageHeader>
      <Loaded q={q} rows={3}>
        {(f: any[]) =>
          f.length ? (
            <DataTable
              label="Forge candidates"
              rows={f}
              rowKey={(c) => c.id}
              selected={selection?.type === 'forge' ? selection.id : null}
              onOpen={(c) => open({ type: 'forge', id: c.id })}
              cols={[
                { key: 'n', title: 'Candidate', width: '26%', render: (c) => <span className="name">{c.name}</span> },
                { key: 's', title: 'State', width: '150px', render: (c) => <Mark s={c.state} /> },
                { key: 'g', title: 'Gap', width: '22%', render: (c) => <span className="muted">{c.gap}</span> },
                { key: 'a', title: 'Activation', width: '130px', cls: 'hide-sm', render: (c) => (c.record.activation ? <span className="num">{pct(c.record.activation.positiveRate)} / {pct(c.record.activation.negativeRate)}</span> : <span className="faint">not tested</span>) },
                { key: 'b', title: 'Baseline', cls: 'hide-sm', render: (c) => (c.record.baseline?.summary ? <span className="num">{c.record.baseline.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(' · ')}</span> : c.record.baseline ? <span className="muted">blocked</span> : <span className="faint">not run</span>) },
              ]}
            />
          ) : (
            <Empty title="No forge candidates">Open a draft for a recorded gap with <span className="mono">synaptome forge new &lt;gap&gt;</span>. Gaps are listed in the Routing Explorer.</Empty>
          )
        }
      </Loaded>
      <h2 className="sect">Evaluation runs</h2>
      <Loaded q={evals} rows={4}>
        {(e: any[]) =>
          e.length ? (
            <DataTable
              label="Evaluation runs"
              rows={e}
              rowKey={(x) => String(x.id)}
              cols={[
                { key: 'w', title: 'When', width: '128px', render: (x) => <span className="muted num">{when(x.createdAt)}</span> },
                { key: 's', title: 'Subject', width: '26%', render: (x) => <span className="mono">{x.subjectId}</span> },
                { key: 'u', title: 'Suite', width: '96px', render: (x) => x.suite },
                { key: 'st', title: 'Status', width: '110px', render: (x) => <Mark s={x.status === 'completed' ? 'completed' : 'held'} label={x.status} /> },
                { key: 'r', title: 'Runner and result', cls: 'hide-sm', render: (x) => <span className="muted">{x.runner} — {x.suite === 'baseline' && x.summary.variants ? x.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(', ') : x.suite === 'activation' ? `positives ${pct(x.summary.positiveRate)}, negatives ${pct(x.summary.negativeRate)}` : x.summary.detail ?? x.summary.blocker ?? ''}</span> },
              ]}
            />
          ) : (
            <p className="muted">No evaluation has been recorded.</p>
          )
        }
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Activity (execution history, live)
 * ===================================================================== */
export function Activity() {
  const [type, setType] = useState('');
  const q = useQuery('system.events', { limit: 200, type: useDebounced(type) });
  return (
    <>
      <PageHeader title="Activity">Append-only event log shared by the CLI, the terminal workbench and this page.</PageHeader>
      <div className="toolbar">
        <input className="field grow" type="search" aria-label="Filter by event type" placeholder="Filter by type prefix, e.g. scan. install. route. forge." value={type} onChange={(e) => setType(e.target.value)} />
      </div>
      <Loaded q={q} rows={12}>
        {(e: any[]) =>
          e.length ? (
            <DataTable
              label="Events"
              rows={e}
              rowKey={(x) => String(x.id)}
              cols={[
                { key: 'i', title: '#', width: '56px', cls: 'r', render: (x) => <span className="num faint">{x.id}</span> },
                { key: 'w', title: 'When', width: '150px', render: (x) => <span className="muted num">{x.ts.slice(0, 19).replace('T', ' ')}</span> },
                { key: 't', title: 'Event', width: '210px', render: (x) => <span className="mono">{x.type}</span> },
                { key: 'o', title: 'Via', width: '64px', render: (x) => <span className="muted">{x.origin}</span> },
                { key: 's', title: 'Subject', width: '22%', render: (x) => x.subject },
                { key: 'p', title: 'Detail', cls: 'hide-sm', render: (x) => <span className="mono faint">{x.payload ? JSON.stringify(x.payload) : ''}</span> },
              ]}
            />
          ) : (
            <Empty title="No events match">Clear the filter to see everything.</Empty>
          )
        }
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Settings
 * ===================================================================== */
export function Settings({ theme, setTheme }: { theme: string; setTheme(t: string): void }) {
  const { run } = useApp();
  const q = useQuery('system.settings');
  const sources = useQuery('sources.list');
  const schedule = useQuery('system.schedule', {}, { live: false });
  const [threshold, setThreshold] = useState('');
  useEffect(() => {
    if (q.data) setThreshold(String(q.data.policy.autoInstallThreshold));
  }, [q.data?.policy.autoInstallThreshold]);
  return (
    <>
      <PageHeader title="Settings">Policy, sources and appearance. Changes apply to every interface.</PageHeader>
      <Loaded q={q} rows={6}>
        {(s) => (
          <>
            <h2 className="sect">Appearance</h2>
            <div className="formrow">
              <div>Theme<small>Automatic follows the operating system.</small></div>
              <div role="radiogroup" aria-label="Theme" className="toolbar" style={{ margin: 0 }}>
                {['auto', 'light', 'dark'].map((t) => (
                  <label key={t} className="inline"><input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} /> {t === 'auto' ? 'Automatic' : t[0].toUpperCase() + t.slice(1)}</label>
                ))}
              </div>
            </div>
            <h2 className="sect">Installation policy</h2>
            <div className="formrow">
              <div>Automatic promotion<small>Applies only to Tier A capabilities that pass every gate check.</small></div>
              <div className="toolbar" style={{ margin: 0 }}>
                <select className="field" aria-label="Automatic installation" value={s.policy.autoInstall} onChange={(e) => run('settings.set', { key: 'policy.autoInstall', value: e.target.value }, 'Policy updated')}>
                  <option value="sandbox">Approve and stage in the sandbox host</option>
                  <option value="off">Approve only; never install automatically</option>
                </select>
              </div>
            </div>
            <div className="formrow">
              <div>Minimum quality score<small>One condition of several. Unknown evidence never passes.</small></div>
              <form className="toolbar" style={{ margin: 0 }} onSubmit={(e) => (e.preventDefault(), void run('settings.set', { key: 'policy.autoInstallThreshold', value: Number(threshold) }, 'Threshold updated'))}>
                <input className="field" style={{ width: 80 }} type="number" min={50} max={100} aria-label="Minimum quality score" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                <Button onClick={() => run('settings.set', { key: 'policy.autoInstallThreshold', value: Number(threshold) }, 'Threshold updated')} disabled={Number(threshold) === s.policy.autoInstallThreshold || !(Number(threshold) >= 50 && Number(threshold) <= 100)}>Save</Button>
              </form>
            </div>
            <div className="formrow">
              <div>Real-install budget<small>How many capabilities may live in real host directories.</small></div>
              <div><strong className="num">{s.hosts.realInstallBudget}</strong> <span className="muted">— change it deliberately from the CLI: <span className="mono">synaptome config set hosts.realInstallBudget &lt;n&gt;</span></span></div>
            </div>
            <div className="formrow">
              <div>Allowed licences</div>
              <div>{s.policy.allowedLicenses.map((l: string) => <span key={l} className="tag">{l}</span>)}</div>
            </div>
            <h2 className="sect">Discovery sources</h2>
            <Loaded q={sources} rows={3}>
              {(list: any[]) => (
                <>
                  {list.map((x) => (
                    <div className="formrow" key={x.id}>
                      <div>{x.title}<small>{x.description}</small></div>
                      <label className="inline">
                        <input type="checkbox" checked={x.enabled} onChange={(e) => run('settings.set', { key: 'discovery.disabledSources', value: e.target.checked ? s.discovery.disabledSources.filter((d: string) => d !== x.id) : [...s.discovery.disabledSources, x.id] }, `${x.title} ${e.target.checked ? 'enabled' : 'disabled'}`)} /> enabled
                      </label>
                    </div>
                  ))}
                </>
              )}
            </Loaded>
          </>
        )}
      </Loaded>
      <h2 className="sect">Scheduled scans</h2>
      <Loaded q={schedule} rows={2}>
        {(p) => (
          <>
            <div className="note">Not registered. Synaptome never creates background tasks silently. These are the visible Task Scheduler entries <span className="mono">synaptome schedule --install --yes</span> would create:</div>
            <DataTable label="Schedule plan" rows={p.plan} rowKey={(t: any) => t.name} cols={[{ key: 'n', title: 'Task', width: '240px', render: (t: any) => t.name }, { key: 's', title: 'Runs', width: '80px', render: (t: any) => t.schedule }, { key: 'c', title: 'Command', cls: 'wrap', render: (t: any) => <span className="mono faint">{t.windows.create}</span> }]} />
          </>
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Workflows — definitions, runs, and the steps waiting for a person.
 * ===================================================================== */
export function Workflows() {
  const { open, selection, confirm, run } = useApp();
  const defs = useQuery('workflows.list', {}, { live: false });
  const runs = useQuery('workflows.runs', { limit: 50 });
  const start = async (w: any) => {
    const required = Object.entries(w.inputs as Record<string, any>).filter(([, v]) => v.required && v.default === undefined);
    if (required.length > 1) {
      await confirm({ title: `${w.title} needs ${required.length} inputs`, body: <p>Start it from the terminal: <span className="mono">synaptome workflow run {w.id} -i key=value …</span></p>, confirmLabel: 'Close' });
      return;
    }
    const [name, spec] = (required[0] ?? []) as [string | undefined, any];
    const ok = await confirm({
      title: `Run ${w.title}?`,
      body: <p>{w.description}</p>,
      consequences: [`Permissions it may use: ${w.permissions.join(', ') || 'none'}`, 'Steps that change configuration, install into a real host, delete, publish, use credentials or run commands wait for your approval.'],
      confirmLabel: 'Start run',
      input: name ? { label: `${name}: ${spec.description || spec.type}`, required: true } : undefined,
    });
    if (!ok) return;
    const r = await run('workflows.start', { workflow: w.id, inputs: name ? { [name]: spec.type === 'number' ? Number(ok.input) : ok.input } : {} }, (x: any) => `Started ${x.runId}`);
    if (r?.runId) open({ type: 'run', id: r.runId });
  };
  return (
    <>
      <PageHeader title="Workflows">Runs survive restarts: every finished step is saved, and a run resumes from the last one. Sensitive steps wait for a person.</PageHeader>
      <Loaded q={defs} rows={2}>
        {(d: any) => (
          <DataTable
            label="Workflows"
            rows={d.workflows}
            rowKey={(w: any) => w.id}
            cols={[
              { key: 't', title: 'Workflow', width: '34%', render: (w: any) => <span className="name">{w.title}</span> },
              { key: 'i', title: 'Id', width: '22%', render: (w: any) => <span className="mono">{w.id}</span> },
              { key: 's', title: 'Steps', width: '70px', render: (w: any) => <span className="num">{w.steps.length}</span> },
              { key: 'p', title: 'Permissions', cls: 'hide-sm', render: (w: any) => <span className="muted">{w.permissions.join(', ') || 'none'}</span> },
              { key: 'r', title: '', width: '110px', render: (w: any) => <Button kind="quiet" onClick={() => start(w)}>Run…</Button> },
            ]}
          />
        )}
      </Loaded>
      <h2 className="sect">Runs</h2>
      <Loaded q={runs} rows={4}>
        {(r: any[]) =>
          r.length ? (
            <DataTable
              label="Workflow runs"
              rows={r}
              rowKey={(x) => x.id}
              selected={selection?.type === 'run' ? selection.id : null}
              onOpen={(x) => open({ type: 'run', id: x.id })}
              cols={[
                { key: 'w', title: 'Started', width: '128px', render: (x) => <span className="muted num">{when(x.createdAt)}</span> },
                { key: 'f', title: 'Workflow', width: '28%', render: (x) => <span className="mono">{x.workflowId}</span> },
                { key: 's', title: 'Status', width: '130px', render: (x) => <Mark s={x.status} /> },
                { key: 'b', title: 'By', width: '80px', cls: 'hide-sm', render: (x) => <span className="muted">{x.startedBy}</span> },
                { key: 'e', title: 'Note', render: (x) => <span className="muted">{x.error ?? ''}</span> },
              ]}
            />
          ) : (
            <Empty title="No runs yet">Start one above, or from the terminal with <span className="mono">synaptome workflow run &lt;id&gt;</span>.</Empty>
          )
        }
      </Loaded>
    </>
  );
}

function RunTrace({ id }: { id: string }) {
  const q = useQuery('workflows.trace', { id });
  if (!q.data || !q.data.calls.length) return null;
  const t = q.data;
  return (
    <>
      <h3>Agent calls</h3>
      <KV items={[['Calls', String(t.totals.calls)], ['Tokens', `${t.totals.tokens.toLocaleString()}${t.budget?.tokens ? ` of ${t.budget.tokens.toLocaleString()}` : ''}`], ['Cost', t.totals.usd === null ? 'unknown (no price configured)' : `$${t.totals.usd.toFixed(4)}`], ['Elapsed', `${Math.round(t.totals.ms / 1000)} s`]]} />
      <ol className="steps">
        {t.calls.map((c: any) => (
          <li key={c.id}>
            <div><Mark s={c.ok ? 'succeeded' : 'failed'} /> <span className="name">{c.agent}</span> <span className="faint mono">{c.step} · {c.provider}</span></div>
            <div className="muted num">{((c.inputTokens ?? 0) + (c.outputTokens ?? 0)).toLocaleString()} tokens · {Math.round((c.ms ?? 0) / 1000)} s{c.costUsd != null ? ` · $${c.costUsd.toFixed(4)}` : ''}{c.error ? ` · ${c.error}` : ''}</div>
          </li>
        ))}
      </ol>
      {Object.keys(t.board).length ? (
        <>
          <h3>Team notes</h3>
          <KV items={Object.entries(t.board).map(([k, v]: any) => [k, `${v.value} (${v.by})`] as [string, string])} />
        </>
      ) : null}
    </>
  );
}

export function RunInspector({ id }: { id: string }) {
  const { confirm, run } = useApp();
  const q = useQuery('workflows.run', { id });
  return (
    <Loaded q={q} rows={6}>
      {(v: any) => (
        <>
          <h2>{v.title}</h2>
          <KV items={[['Run', <span className="mono">{v.id}</span>], ['Status', <Mark s={v.status} />], ['Inputs', <span className="mono">{JSON.stringify(v.inputs)}</span>], ['Granted', v.granted.join(', ') || 'none'], ['Started', `${when(v.createdAt)} by ${v.startedBy}`], ...(v.error ? [['Note', v.error] as [string, string]] : [])]} />
          <div className="actions">
            {['queued', 'running', 'waiting'].includes(v.status) ? (
              <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: 'Cancel this run?', consequences: ['A running step is stopped; steps not yet started never start.'], confirmLabel: 'Cancel run', danger: true }); if (ok) await run('workflows.cancel', { id }, 'Run cancelled'); }}>Cancel run…</Button>
            ) : null}
            {v.status === 'queued' || (v.status === 'running' && !v.owner) ? <Button onClick={() => run('workflows.resume', { id }, 'Resumed')}>Resume</Button> : null}
          </div>
          <h3>Steps</h3>
          <ol className="steps">
            {v.steps.map((s: any) => (
              <li key={s.id}>
                <div><Mark s={s.status} /> <span className="name">{s.title}</span> <span className="faint mono">{s.id}{s.needs.length ? ` ← ${s.needs.join(', ')}` : ''}</span></div>
                {s.attempts > 1 ? <div className="muted">{s.attempts} attempts</div> : null}
                {s.error ? <div className={s.status === 'waiting' ? '' : 'muted'}>{s.error}</div> : null}
                {s.output != null && s.status === 'succeeded' ? <pre className="mono small">{JSON.stringify(s.output, null, 1).slice(0, 600)}</pre> : null}
                {s.approval ? <div className="muted">{s.approval.approved ? 'Approved' : 'Rejected'} by {s.approval.by} {when(s.approval.at)}{s.approval.note ? ` — ${s.approval.note}` : ''}</div> : null}
                {s.status === 'waiting' ? (
                  <div className="actions">
                    <Button onClick={async () => { const ok = await confirm({ title: `Approve "${s.title}"?`, consequences: s.permissions.length ? [`It may use: ${s.permissions.join(', ')}`] : [], confirmLabel: 'Approve', input: { label: 'Note', placeholder: 'optional' } }); if (ok) await run('workflows.approve', { id, step: s.id, approve: true, note: ok.input }, 'Approved; the run continues'); }}>Approve…</Button>
                    <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: `Reject "${s.title}"?`, consequences: ['The step fails; steps that depend on it are skipped.'], confirmLabel: 'Reject', danger: true, input: { label: 'Reason', required: true } }); if (ok) await run('workflows.approve', { id, step: s.id, approve: false, note: ok.input }, 'Rejected'); }}>Reject…</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          <RunTrace id={id} />
        </>
      )}
    </Loaded>
  );
}
