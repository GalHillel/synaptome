import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type AppContext, Button, type ConfirmOptions, Ctx, DataTable, KV, type LiveEvent, Loaded, Mark, Quality, type Selection, Tier, call, openEventStream, useApp, useDebounced, useQuery, when } from './lib';
import { Graph } from './graph';
import { GetStarted, Agents, EvalLab, EvalSetInspector, Integrations, Notifications, SourceInspector, Sources } from './screens';
import { Activity, Decision, Discovery, Forge, Library, Overview, Queue, Routing, RunInspector, Security, Settings, Workflows } from './views';

const VIEWS = [
  { id: 'overview', title: 'Overview', group: 'Workspace' },
  { id: 'start', title: 'Get started', group: 'Workspace' },
  { id: 'library', title: 'Capability Library', group: 'Registry' },
  { id: 'graph', title: 'Capability Graph', group: 'Registry' },
  { id: 'discovery', title: 'Discovery', group: 'Registry' },
  { id: 'sources', title: 'Sources', group: 'Registry' },
  { id: 'queue', title: 'Installation Queue', group: 'Registry' },
  { id: 'security', title: 'Security', group: 'Registry' },
  { id: 'routing', title: 'Routing Explorer', group: 'Intelligence' },
  { id: 'forge', title: 'Skill Forge', group: 'Intelligence' },
  { id: 'workflows', title: 'Workflows', group: 'Intelligence' },
  { id: 'agents', title: 'Agents', group: 'Intelligence' },
  { id: 'evals', title: 'Evaluation Lab', group: 'Intelligence' },
  { id: 'notifications', title: 'Notifications', group: 'System' },
  { id: 'integrations', title: 'Integrations', group: 'System' },
  { id: 'activity', title: 'Activity', group: 'System' },
  { id: 'settings', title: 'Settings', group: 'System' },
];
const pct = (n: number) => `${Math.round(n * 100)}%`;

/* ---------- inspectors ---------- */

function Tabs({ tabs, value, onChange }: { tabs: string[]; value: string; onChange(t: string): void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={value === t} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}
function InspectorFrame({ title, id, status, actions, children }: { title: string; id: string; status?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { open } = useApp();
  return (
    <>
      <div className="insp-head">
        <div className="row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{title}</h2>
            <div className="mono id">{id}</div>
          </div>
          <button className="btn quiet" aria-label="Close inspector" onClick={() => open(null)}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        {status ? <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>{status}</div> : null}
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
    </>
  );
}
const Findings = ({ items }: { items: any[] }) =>
  items.length ? (
    <>
      {items.map((f, i) => (
        <div className="finding" key={i}>
          <Mark s={f.severity === 'critical' || f.severity === 'high' ? 'fail' : f.severity === 'medium' ? 'warn' : 'unknown'} label={f.severity} /> {f.message}
          <code>
            {f.file}
            {f.line ? `:${f.line}` : ''} {f.excerpt ? `— ${f.excerpt}` : ''}
          </code>
        </div>
      ))}
    </>
  ) : (
    <p className="muted">No findings.</p>
  );
const GateChecks = ({ gate }: { gate: any }) =>
  gate ? (
    <>
      <p>
        Decision: <Mark s={gate.decision} /> <span className="faint">by {gate.decidedBy}, {when(gate.at)}</span>
      </p>
      {gate.checks.map((c: any) => (
        <div className="check" key={c.id}>
          <Mark s={c.result === 'unknown' ? 'warn' : c.result} label={c.result} />
          <div>
            {c.label}
            <small>{c.evidence}</small>
          </div>
        </div>
      ))}
    </>
  ) : (
    <p className="muted">The promotion gate has not been evaluated for this capability.</p>
  );

function CapabilityInspector({ id }: { id: string }) {
  const { run, confirm } = useApp();
  const [tab, setTab] = useState('Summary');
  const q = useQuery('capabilities.get', { id, content: tab === 'Content' });
  return (
    <Loaded q={q} rows={10}>
      {(d) => {
        const c = d.capability;
        const r = c.record;
        const managed = d.installations.filter((i: any) => i.status === 'installed' && i.scope !== 'external');
        const approve = async () => {
          const lic = r.license.compatible;
          const ok = await confirm({ title: `Approve ${c.name}?`, body: <p>Approval makes it installable and routable. It does not install anything.</p>, consequences: (d.gate?.checks ?? []).filter((x: any) => x.result !== 'pass').map((x: any) => `${x.result === 'fail' ? 'Failed' : 'Unknown'}: ${x.label} — ${x.evidence}`), confirmLabel: 'Approve', input: lic === 'yes' ? undefined : { label: `Licence is ${lic === 'no' ? r.license.spdx + ' (not on the allow list)' : 'unknown'}. State why you accept it for local use`, required: true } });
          if (ok) await run('capabilities.approve', { id, acceptLicence: ok.input || undefined }, `${c.name} approved`);
        };
        return (
          <InspectorFrame
            title={c.name}
            id={c.id}
            status={
              <>
                <Mark s={c.status} /> <Tier t={c.tier} /> <Mark s={c.trust} /> <Quality q={c.quality} />
              </>
            }
            actions={
              <>
                {c.status === 'registered' && c.origin !== 'host-inventory' ? <Button kind="primary" onClick={approve}>Approve…</Button> : null}
                {c.status === 'registered' && c.origin !== 'host-inventory' ? <Button onClick={async () => { const ok = await confirm({ title: `Reject ${c.name}?`, consequences: ['It will not be routed or installed.'], confirmLabel: 'Reject', danger: true, input: { label: 'Reason', placeholder: 'optional' } }); if (ok) await run('capabilities.reject', { id, reason: ok.input }, `${c.name} rejected`); }}>Reject…</Button> : null}
                {c.status === 'approved' && !managed.length ? <Button kind="primary" onClick={() => run('capabilities.install', { id }, (x: any) => `Staged in sandbox: ${x.targetPath}`)}>Install to sandbox</Button> : null}
                {managed.map((i: any) => (
                  <Button key={i.id} onClick={async () => { const ok = await confirm({ title: `Roll back ${c.name}?`, consequences: [`Removes ${i.targetPath}`, i.previousId ? 'Restores the previous version' : 'The capability stays approved', i.scope === 'real' ? 'This changes a real host directory' : 'Sandbox host only'], confirmLabel: 'Roll back', danger: true }); if (ok) await run('installations.rollback', { id: i.id }, 'Rolled back'); }}>
                    Roll back {i.scope}…
                  </Button>
                ))}
              </>
            }
          >
            <Tabs tabs={['Summary', 'Evidence', 'Security', 'Gate', 'History', 'Content']} value={tab} onChange={setTab} />
            <div className="insp-body" role="tabpanel">
              {tab === 'Summary' ? (
                <>
                  <p>{c.description}</p>
                  {c.status === 'blocked' ? <div className="note danger">Blocked by the security audit. It is excluded from routing and cannot be approved.</div> : null}
                  {c.origin === 'host-inventory' ? <div className="note">Already on this host before Synaptome. Indexed read-only; Synaptome does not manage or remove it.</div> : null}
                  <KV
                    items={[
                      ['Kind / domain', `${c.kind} / ${c.domain}`],
                      ['Publisher', c.publisher],
                      ['Source', r.provenance.url ? <span className="mono">{r.provenance.url}</span> : ''],
                      ['Pinned commit', r.commit ? <span className="mono">{r.commit}</span> : ''],
                      ['Provenance', <><Mark s={r.provenance.verified ? 'pass' : 'warn'} label={r.provenance.verified ? 'verified' : 'not verified'} /> <span className="muted">{r.provenance.method}</span></>],
                      ['Licence', <><span className="mono">{r.license.spdx || 'unknown'}</span> <Mark s={r.license.compatible === 'yes' ? 'pass' : r.license.compatible === 'no' ? 'fail' : 'warn'} label={r.license.compatible === 'yes' ? 'allowed' : r.license.compatible === 'no' ? 'not on allow list' : 'unknown'} /><div className="muted">{r.license.evidence}</div></>],
                      ['Context cost', `≈ ${c.contextCost} tokens (estimate)`],
                      ['Platforms', r.platforms.join(', ')],
                      ['Permissions', Object.entries(r.permissions).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none beyond reading its own files'],
                      ['Executables', r.executables.join(', ')],
                      ['Tags', c.tags.map((t: string) => <span key={t} className="tag">{t}</span>)],
                      ['Known weaknesses', r.weaknesses.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{r.weaknesses.map((w: string) => <li key={w}>{w}</li>)}</ul> : ''],
                      ['Installed', d.installations.filter((i: any) => i.status === 'installed').map((i: any) => `${i.host} (${i.scope})`).join(', ') || 'no'],
                    ]}
                  />
                </>
              ) : null}
              {tab === 'Evidence' ? (
                d.score ? (
                  <>
                    <p>Score <strong className="num">{d.score.total}</strong> of 100. A dimension without evidence counts as zero and is listed as unknown.</p>
                    {Object.entries<any>(d.score.dimensions).map(([k, v]) => (
                      <div className="check" key={k}>
                        <span className="num">{v.score == null ? <Mark s="warn" label="unknown" /> : <strong>{v.score}</strong>}</span>
                        <div>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}<small>{v.evidence}</small></div>
                      </div>
                    ))}
                    {r.benchmarks.length ? <div className="note ok">Benchmark: {r.benchmarks.map((b: any) => `${pct(b.withSkill)} with vs ${pct(b.baseline)} without over ${b.cases} cases (${b.runner})`).join('; ')}</div> : null}
                    {d.evals.length ? <><h3>Evaluation runs</h3><DataTable label="Evaluation runs" rows={d.evals} rowKey={(e: any) => String(e.id)} cols={[{ key: 's', title: 'Suite', width: '90px', render: (e: any) => e.suite }, { key: 'r', title: 'Runner', render: (e: any) => <span className="muted">{e.runner}</span> }, { key: 'st', title: 'Status', width: '100px', render: (e: any) => e.status }]} /></> : null}
                  </>
                ) : (
                  <p className="muted">Not scored yet.</p>
                )
              ) : null}
              {tab === 'Security' ? d.audit ? <><p className="muted">{d.audit.summary}</p><Findings items={d.audit.findings} /></> : <p className="muted">No audit recorded.</p> : null}
              {tab === 'Gate' ? <GateChecks gate={d.gate} /> : null}
              {tab === 'History' ? (
                <>
                  <h3>Installations</h3>
                  {d.installations.length ? <DataTable label="Installations" rows={d.installations} rowKey={(i: any) => i.id} cols={[{ key: 'h', title: 'Host / scope', width: '44%', render: (i: any) => `${i.host} / ${i.scope}` }, { key: 's', title: 'Status', render: (i: any) => <Mark s={i.status} /> }, { key: 'w', title: 'When', width: '120px', render: (i: any) => <span className="muted num">{when(i.createdAt)}</span> }]} /> : <p className="muted">Never installed.</p>}
                  <h3>Versions</h3>
                  {d.versions.length ? <DataTable label="Versions" rows={d.versions} rowKey={(v: any) => v.content_hash} cols={[{ key: 'h', title: 'Snapshot', width: '130px', render: (v: any) => <span className="mono">{v.content_hash.slice(0, 12)}</span> }, { key: 'r', title: 'Upstream ref', render: (v: any) => <span className="mono faint">{(v.ref ?? '').slice(0, 12)}</span> }, { key: 'w', title: 'Stored', width: '120px', render: (v: any) => <span className="muted num">{when(v.created_at)}</span> }]} /> : <p className="muted">No stored snapshot (host inventory entries are read in place).</p>}
                  {d.relations.length ? <><h3>Relations</h3>{d.relations.map((x: any, i: number) => <div key={i} className="mono">{x.src} —{x.rel}→ {x.dst}</div>)}</> : null}
                </>
              ) : null}
              {tab === 'Content' ? d.entry ? <><div className="note">Shown as data. Capability text is never treated as instructions by Synaptome.</div><pre className="doc">{d.entry.content}</pre></> : <p className="muted">No readable entry file.</p> : null}
            </div>
          </InspectorFrame>
        );
      }}
    </Loaded>
  );
}

function CandidateInspector({ id }: { id: string }) {
  const { run, open } = useApp();
  const q = useQuery('candidates.get', { id });
  return (
    <Loaded q={q} rows={10}>
      {(c) => (
        <InspectorFrame
          title={c.name}
          id={c.id}
          status={<><Mark s={c.state} /> <span className="muted">{c.kind} · {c.sourceId} · rank {c.rank.toFixed(0)}</span></>}
          actions={
            <>
              {['queued', 'discovered', 'audited'].includes(c.state) && c.sourceId !== 'local-claude' ? <Button kind="primary" onClick={() => run('candidates.evaluate', { id }, (r: any) => r.summary)} title="Download into quarantine, audit, score, test and run the promotion gate">Evaluate</Button> : null}
              {c.capabilityId ? <Button onClick={() => open({ type: 'capability', id: c.capabilityId })}>Open capability</Button> : null}
              {c.updateAvailable ? <Button onClick={() => run('updates.inspect', { id }, (r: any) => `Update verdict: ${r.verdict}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`)}>Inspect update</Button> : null}
            </>
          }
        >
          <div className="insp-body">
            <p>{c.description || <span className="faint">No description supplied by the source.</span>}</p>
            {c.state === 'blocked' ? <div className="note danger">Blocked in quarantine. It was not registered and cannot be approved.</div> : null}
            {c.duplicateOf ? <div className="note warn">Duplicate of {c.duplicateOf}. Kept as a separate record; nothing was merged.</div> : null}
            <KV
              items={[
                ['Source', `${c.sourceId} — ${c.externalId}`],
                ['Location', c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.url}</a> : ''],
                ['Pinned ref', c.ref ? <span className="mono">{c.ref}</span> : ''],
                ['Publisher', c.publisher],
                ['Licence', <><span className="mono">{c.licenseSpdx ?? 'unknown'}</span><div className="muted">{c.licenseEvidence}</div></>],
                ['Popularity', c.stars != null ? `${c.stars} (weak evidence)` : ''],
                ['Last upstream change', when(c.pushedAt)],
                ['Next step', c.recommendedAction],
                ['Update', c.updateAvailable ? 'upstream changed since the audit' : 'none detected'],
              ]}
            />
            <h3>Why this rank</h3>
            <p className="muted">Rank orders the evaluation queue. It is not a quality score.</p>
            {c.rankReasons.map((r: string) => <div key={r} className="mono">{r}</div>)}
            {c.overlap.length ? <><h3>Possible overlap</h3>{c.overlap.map((o: any) => <div key={o.id}>{o.name} <span className="muted">({o.similarity}) {o.basis}</span></div>)}</> : null}
            {c.audit ? <><h3>Audit</h3><p className="muted">{c.audit.summary}</p><Findings items={c.audit.findings} /></> : null}
            {c.files.length ? <><h3>Files in quarantine <span className="n">{c.files.length}</span></h3>{c.files.slice(0, 40).map((f: any) => <div key={f.path} className="mono">{f.path} <span className="faint">{f.size} b</span></div>)}</> : null}
          </div>
        </InspectorFrame>
      )}
    </Loaded>
  );
}

function ForgeInspector({ id }: { id: string }) {
  const { run, confirm } = useApp();
  const q = useQuery('forge.get', { id });
  return (
    <Loaded q={q} rows={10}>
      {(c) => {
        const r = c.record;
        const final = ['promoted', 'rejected'].includes(c.state);
        return (
          <InspectorFrame
            title={c.name}
            id={c.id}
            status={<><Mark s={c.state} /> <span className="muted">gap: {c.gap} · author: {r.author}</span></>}
            actions={
              final ? null : (
                <>
                  <Button onClick={() => run('forge.check', { id }, (x: any) => `Checks finished: ${x.state}`)}>Run checks</Button>
                  <Button kind="primary" onClick={() => run('forge.decide', { id }, (x: any) => `Decision: ${x.decision.verdict}`)} title="Promote, reject or hold according to the recorded evidence">Decide on evidence</Button>
                  <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: `Reject ${c.name}?`, confirmLabel: 'Reject', danger: true, input: { label: 'Reason', required: true } }); if (ok) await run('forge.decide', { id, reject: ok.input }, 'Rejected'); }}>Reject…</Button>
                </>
              )
            }
          >
            <div className="insp-body">
              {c.decision ? <div className={`note ${c.decision.verdict === 'promote' ? 'ok' : c.decision.verdict === 'reject' ? 'danger' : 'warn'}`}><strong>{c.decision.verdict.toUpperCase()}</strong> — {when(c.decision.at)}<ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{c.decision.reasons.map((x: string) => <li key={x}>{x}</li>)}</ul></div> : null}
              <h3>Structure</h3>
              {r.lint ? <><Mark s={r.lint.ok ? 'pass' : 'fail'} label={r.lint.ok ? 'passes' : 'fails'} />{r.lint.problems.map((p: string) => <div key={p} className="muted">– {p}</div>)}</> : <p className="muted">Not checked.</p>}
              <h3>Security screening</h3>
              {r.audit ? <p><Tier t={r.audit.tier} /> <span className="muted">{r.audit.summary}</span></p> : <p className="muted">Not screened.</p>}
              <h3>Activation tests</h3>
              {r.activation ? (
                <>
                  <p className="muted">Routes for {pct(r.activation.positiveRate)} of its own tasks; stays out of {pct(r.activation.negativeRate)} of unrelated ones.</p>
                  {[...r.activation.positives.map((p: any) => ({ ...p, expect: 'should route' })), ...r.activation.negatives.map((p: any) => ({ ...p, expect: 'should not route' }))].map((p: any) => (
                    <div className="check" key={p.expect + p.prompt}><Mark s={p.passed ? 'pass' : 'fail'} label={p.passed ? 'pass' : 'fail'} /><div>{p.prompt}<small>{p.expect}</small></div></div>
                  ))}
                </>
              ) : <p className="muted">Not tested.</p>}
              <h3>Baseline comparison</h3>
              {r.baseline ? r.baseline.status === 'blocked' ? <div className="note warn">Blocked ({r.baseline.runner}): {r.baseline.blocker}</div> : (
                <>
                  <KV items={[['Runner', <span className="mono">{r.baseline.runner}</span>], ...r.baseline.summary.variants.map((v: any) => [v.variant, `${v.passed} of ${v.total} cases pass`] as [string, ReactNode]), ['Lift', String(r.baseline.summary.lift)]]} />
                  <p className="muted">{r.baseline.summary.note}</p>
                </>
              ) : <p className="muted">Not run.</p>}
              <h3>Alternatives considered</h3>
              {r.alternatives.length ? r.alternatives.map((a: any) => <div key={a.id}>{a.name} <span className="muted">— {a.where}, {a.note}</span></div>) : <p className="muted">None found.</p>}
              <h3>Workspace</h3>
              <div className="mono">{c.path}</div>
            </div>
          </InspectorFrame>
        );
      }}
    </Loaded>
  );
}

function DecisionInspector({ id }: { id: string }) {
  const q = useQuery('routing.decision', { id: Number(id) });
  return <Loaded q={q}>{(d) => <InspectorFrame title={`Decision #${d.id}`} id={`${d.origin} · ${when(d.createdAt)} · ${d.strategy}`}><div className="insp-body"><Decision d={d} /></div></InspectorFrame>}</Loaded>;
}

/* ---------- overlays ---------- */

function Palette({ onClose, actions }: { onClose(): void; actions: { label: string; hint: string; run(): void }[] }) {
  const { open } = useApp();
  const [text, setText] = useState('');
  const [i, setI] = useState(0);
  const q = useDebounced(text, 160);
  const found = useQuery(q.trim().length >= 2 ? 'capabilities.list' : null, { q, limit: 6 }, { live: false });
  const items = useMemo(() => {
    const t = text.trim().toLowerCase();
    const base = actions.filter((a) => !t || a.label.toLowerCase().includes(t) || a.hint.toLowerCase().includes(t));
    const caps = (found.data?.items ?? []).map((c: any) => ({ label: c.name, hint: `capability · ${c.status}`, run: () => open({ type: 'capability', id: c.id }) }));
    return [...base, ...caps];
  }, [text, actions, found.data]);
  useEffect(() => setI(0), [text]);
  const pick = (k: number) => {
    const it = items[k];
    if (it) (onClose(), it.run());
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={`pal-${i}`}
          placeholder="Type a command or search capabilities"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(items.length - 1, x + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            else if (e.key === 'Enter') (e.preventDefault(), pick(i));
            else if (e.key === 'Escape') onClose();
          }}
        />
        <ul id="palette-list" role="listbox">
          {items.length ? items.map((it, k) => (
            <li key={k} id={`pal-${k}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => pick(k)}>
              {it.label}
              <small>{it.hint}</small>
            </li>
          )) : <li aria-disabled="true"><span className="muted">No command or capability matches “{text}”.</span></li>}
        </ul>
        <footer><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></footer>
      </div>
    </div>
  );
}

function ConfirmDialog({ o, done }: { o: ConfirmOptions; done(r: false | { input: string }): void }) {
  const [input, setInput] = useState('');
  const blocked = !!o.input?.required && !input.trim();
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <form className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" onSubmit={(e) => (e.preventDefault(), !blocked && done({ input }))} onKeyDown={(e) => e.key === 'Escape' && done(false)}>
        <h2 id="dlg-title">{o.title}</h2>
        <div className="body">
          {o.body}
          {o.consequences?.length ? <><div className="faint" style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 11 }}>What this does</div><ul>{o.consequences.filter(Boolean).map((c) => <li key={c}>{c}</li>)}</ul></> : null}
          {o.input ? <label style={{ display: 'block' }}>{o.input.label}<textarea className="field" rows={2} autoFocus placeholder={o.input.placeholder} value={input} onChange={(e) => setInput(e.target.value)} /></label> : null}
        </div>
        <footer>
          <button type="button" className="btn" onClick={() => done(false)} autoFocus={!o.input}>Cancel</button>
          <button type="submit" className={`btn ${o.danger ? 'danger' : 'primary'}`} disabled={blocked}>{o.confirmLabel}</button>
        </footer>
      </form>
    </div>
  );
}

const Help = ({ onClose }: { onClose(): void }) => (
  <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="dialog help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <h2>Keyboard</h2>
      <div className="body">
        <dl>
          {[['Ctrl K', 'Command palette'], ['/', 'Search the library'], ['1 – 9', 'Switch view'], ['j  k  ↑  ↓', 'Move through a table'], ['Enter', 'Open the selected row'], ['Esc', 'Close inspector or dialog'], ['t', 'Cycle theme'], ['?', 'This help']].map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}><dt><kbd>{k}</kbd></dt><dd style={{ margin: 0 }}>{v}</dd></div>
          ))}
        </dl>
      </div>
      <footer><button className="btn" autoFocus onClick={onClose}>Close</button></footer>
    </div>
  </div>
);

/* ---------- shell ---------- */

function App() {
  const initial = VIEWS.some((v) => v.id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  const [view, setView] = useState(initial);
  const [params, setParams] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [rev, setRev] = useState(0);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [online, setOnline] = useState(true);
  const [authLost, setAuthLost] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; detail?: string; error?: boolean }[]>([]);
  const [dialog, setDialog] = useState<{ o: ConfirmOptions; resolve(r: false | { input: string }): void } | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setThemeState] = useState(() => localStorage.getItem('synaptome-theme') ?? 'auto');
  const searchRef = useRef<HTMLInputElement>(null);

  // First run (no interface has been opened on this home yet): open Get started, once, then record that it was shown.
  useEffect(() => {
    if (location.hash) return;
    call('system.settings')
      .then((s: any) => {
        if (s?.ui?.onboarded) return;
        setView('start');
        return call('settings.set', { key: 'ui.onboarded', value: true });
      })
      .catch(() => undefined);
  }, []);

  const setTheme = useCallback((t: string) => {
    setThemeState(t);
    localStorage.setItem('synaptome-theme', t);
    call('settings.set', { key: 'ui.theme', value: t }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const go = useCallback((v: string, p: Record<string, string> = {}) => {
    setView(v);
    setParams(p);
    setNavOpen(false);
    history.replaceState(null, '', `#${v}`);
  }, []);
  const toast = useCallback((message: string, detail?: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, detail, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 5000);
  }, []);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<false | { input: string }>((resolve) => setDialog({ o, resolve })), []);
  const run = useCallback(
    async (name: string, args: unknown, ok: string | ((r: any) => string)) => {
      try {
        const r = await call(name, args);
        toast(typeof ok === 'function' ? ok(r) : ok);
        setRev((x) => x + 1);
        return r;
      } catch (e: any) {
        toast(e.message, e.hint, true);
        return undefined;
      }
    },
    [toast],
  );

  // Live event stream: resumable, shared with the CLI and the terminal workbench.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start from recent history so the activity list is never empty just because the page is new.
    call<LiveEvent[]>('system.events', { limit: 40 }).then((past) => setEvents((list) => [...list, ...past.filter((p) => !list.some((l) => l.id === p.id))])).catch(() => undefined);
    const close = openEventStream({
      onEvent: (e) => {
        setEvents((list) => (list.some((l) => l.id === e.id) ? list : [e, ...list].slice(0, 200)));
        clearTimeout(timer);
        timer = setTimeout(() => setRev((x) => x + 1), 250);
      },
      onStatus: setOnline,
      onAuthLost: () => setAuthLost(true),
    });
    return () => (close(), clearTimeout(timer));
  }, []);

  const cycleTheme = useCallback(() => setTheme({ auto: 'light', light: 'dark', dark: 'auto' }[theme] ?? 'auto'), [theme, setTheme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return e.preventDefault(), setPalette(true);
      if (e.key === 'Escape') {
        if (palette) setPalette(false);
        else if (help) setHelp(false);
        else if (!dialog && selection) setSelection(null);
        return;
      }
      const el = e.target as HTMLElement;
      if (palette || help || dialog || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
      if (e.key === '/') (e.preventDefault(), searchRef.current?.focus());
      else if (e.key === '?') setHelp(true);
      else if (e.key === 't') cycleTheme();
      else if (/^[1-9]$/.test(e.key) && VIEWS[Number(e.key) - 1]) go(VIEWS[Number(e.key) - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, help, dialog, selection, go, cycleTheme]);

  const ctx: AppContext = { rev, events, online, view, params, go, selection, open: setSelection, toast, confirm, run };
  return (
    <Ctx.Provider value={ctx}>
      <Shell {...{ view, navOpen, setNavOpen, searchRef, theme, cycleTheme, setPalette, setHelp, setTheme, authLost }} />
      {palette ? <PaletteHost onClose={() => setPalette(false)} setTheme={setTheme} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {dialog ? <ConfirmDialog o={dialog.o} done={(r) => (dialog.resolve(r), setDialog(null))} /> : null}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.message}
            {t.detail ? <small>{t.detail}</small> : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function PaletteHost({ onClose, setTheme }: { onClose(): void; setTheme(t: string): void }) {
  const { go, run } = useApp();
  const actions = useMemo(
    () => [
      ...VIEWS.map((v, i) => ({ label: `Go to ${v.title}`, hint: `view · ${i + 1}`, run: () => go(v.id) })),
      { label: 'Scan for new capabilities', hint: 'broad discovery on GitHub and the MCP registry', run: () => void run('scan.run', { mode: 'broad' }, (r: any) => r.reports.map((x: any) => `${x.sourceId}: ${x.added} new`).join(' · ')) },
      { label: 'Check for updates', hint: 'ask sources about acquired capabilities', run: () => void run('updates.check', {}, (r: any[]) => `${r.filter((x) => x.changed).length} update(s) among ${r.length} checked`) },
      { label: 'Evaluate next queued candidate', hint: 'quarantine, audit, score, gate', run: () => void run('queue.evaluateNext', { n: 1 }, (r: any[]) => (r[0] ? r[0].summary ?? r[0].error : 'The evaluation queue is empty')) },
      { label: 'Index local host inventory', hint: 'read-only audit of skills already installed', run: () => void run('inventory.run', {}, (r: any) => `${r.indexed} indexed, ${r.unchanged} unchanged, ${r.flagged.length} flagged`) },
      { label: 'Check source health', hint: 'probe every discovery source', run: () => void run('sources.check', {}, 'Source health checked') },
      { label: 'Route a task', hint: 'open the Routing Explorer', run: () => go('routing') },
      { label: 'Theme: light', hint: 'appearance', run: () => setTheme('light') },
      { label: 'Theme: dark', hint: 'appearance', run: () => setTheme('dark') },
      { label: 'Theme: automatic', hint: 'appearance', run: () => setTheme('auto') },
    ],
    [go, run, setTheme],
  );
  return <Palette onClose={onClose} actions={actions} />;
}

function Shell({ view, navOpen, setNavOpen, searchRef, theme, cycleTheme, setPalette, setHelp, setTheme, authLost }: any) {
  const { go, selection, params, events, online } = useApp();
  const o = useQuery('system.overview');
  const diag = useQuery('system.diagnostics', {}, { live: false });
  const counts: Record<string, [number, boolean]> = o.data ? { library: [o.data.capabilities.total, false], discovery: [o.data.candidates.byState.queued ?? 0, false], queue: [o.data.pendingApproval, o.data.pendingApproval > 0], security: [o.data.security.blocked, false], routing: [o.data.routing.openGaps, false], forge: [o.data.forge.candidates, false] } : {};
  const fails = (diag.data ?? []).filter((d: any) => d.status === 'fail').length;
  const warns = (diag.data ?? []).filter((d: any) => d.status === 'warn').length;
  const groups = [...new Set(VIEWS.map((v) => v.group))];
  const last = events[0];
  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <div className="topbar" role="banner">
        <button className="btn quiet navtoggle" aria-label="Toggle navigation" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>Menu</button>
        <span className="wordmark">SYNAPT<i>O</i>ME</span>
        <span className="sub">Command Center</span>
        <div className="search">
          <input ref={searchRef} type="search" aria-label="Search the capability library" placeholder="Search capabilities" value={view === 'library' ? params.q ?? '' : ''} onChange={(e) => go('library', { q: e.target.value })} onFocus={() => view !== 'library' && go('library', {})} />
          <kbd>/</kbd>
        </div>
        <button className="btn" onClick={() => setPalette(true)}>Commands <kbd>Ctrl K</kbd></button>
        <span className="spacer" />
        <span className={`lamp ${!online || fails ? 'fail' : warns ? 'warn' : 'ok'}`} title={(diag.data ?? []).filter((d: any) => d.status !== 'ok').map((d: any) => `${d.label}: ${d.detail}`).join('\n')}>
          {!online ? 'offline' : fails ? `${fails} check${fails > 1 ? 's' : ''} failing` : warns ? `healthy · ${warns} notice${warns > 1 ? 's' : ''}` : 'healthy'}
        </span>
        <button className="btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Activate to change`}><span className="hide-sm">Theme: </span>{theme}</button>
        <button className="btn quiet hide-sm" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">?</button>
      </div>
      <div className="banner">{authLost ? <div className="offline" role="alert">This page belongs to an earlier start of the service and can no longer receive updates. <button className="btn quiet" onClick={() => location.reload()}>Reload</button></div> : !online ? <div className="offline" role="alert">The local service is not responding. What you see may be stale. Restart it with <span className="mono">synaptome dashboard</span>, then reload this page.</div> : null}</div>
      <nav className={`nav ${navOpen ? 'open' : ''}`} aria-label="Primary">
        {groups.map((g) => (
          <div key={g}>
            <h2>{g}</h2>
            {VIEWS.filter((v) => v.group === g).map((v) => (
              <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => go(v.id)}>
                <span className="key" aria-hidden="true">{VIEWS.indexOf(v) + 1}</span>
                {v.title}
                {counts[v.id] && counts[v.id][0] > 0 ? <span className={`count ${counts[v.id][1] ? 'alert' : ''}`}>{counts[v.id][0]}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className={`main ${selection ? 'with-inspector' : ''}`}>
        <main id="main" className="view" tabIndex={-1}>
          {view === 'overview' ? <Overview /> : view === 'start' ? <GetStarted /> : view === 'library' ? <Library /> : view === 'graph' ? <Graph /> : view === 'discovery' ? <Discovery /> : view === 'queue' ? <Queue /> : view === 'security' ? <Security /> : view === 'routing' ? <Routing /> : view === 'forge' ? <Forge /> : view === 'workflows' ? <Workflows /> : view === 'agents' ? <Agents /> : view === 'evals' ? <EvalLab /> : view === 'sources' ? <Sources /> : view === 'notifications' ? <Notifications /> : view === 'integrations' ? <Integrations /> : view === 'activity' ? <Activity /> : <Settings theme={theme} setTheme={setTheme} />}
        </main>
        {selection ? (
          <aside className="inspector" aria-label="Inspector">
            {selection.type === 'capability' ? <CapabilityInspector key={selection.id} id={selection.id} /> : selection.type === 'candidate' ? <CandidateInspector key={selection.id} id={selection.id} /> : selection.type === 'forge' ? <ForgeInspector key={selection.id} id={selection.id} /> : selection.type === 'run' ? <RunInspector key={selection.id} id={selection.id} /> : selection.type === 'source' ? <SourceInspector key={selection.id} id={selection.id} /> : selection.type === 'evalset' ? <EvalSetInspector key={selection.id} id={selection.id} /> : <DecisionInspector key={selection.id} id={selection.id} />}
          </aside>
        ) : null}
      </div>
      <div className="statusbar" role="contentinfo">
        <span>{o.data ? `home ${o.data.home}` : ''}</span>
        <span className="ticker" aria-live="off">{last ? `${last.ts.slice(11, 19)}  ${last.type}  ${last.subject ?? ''}  via ${last.origin ?? '?'}` : 'waiting for events'}</span>
        <span><kbd>?</kbd> shortcuts</span>
        <span>{o.data ? `v${o.data.product.version}` : ''}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
