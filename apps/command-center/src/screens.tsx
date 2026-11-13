import { Button, DataTable, Empty, KV, Loaded, Mark, PageHeader, ago, useApp, useQuery, when } from './lib';

/* =====================================================================
 * Get started — a checklist computed from the system's real state, with the next action for each step.
 * ===================================================================== */
export function GetStarted() {
  const { go, run } = useApp();
  const o = useQuery('system.overview');
  const diag = useQuery('system.diagnostics', {}, { live: false });
  const providers = useQuery('providers.list');
  const ready = o.data && diag.data && providers.data;
  if (!ready) return <Loaded q={o} rows={6}>{() => null}</Loaded>;
  const ov: any = o.data;
  const failing = (diag.data as any[]).filter((d) => d.status === 'fail');
  const verified = (providers.data as any[]).filter((p) => p.status === 'VERIFIED');
  const steps: { done: boolean; title: string; detail: string; action?: { label: string; run(): unknown } }[] = [
    { done: !failing.length, title: 'The system checks pass', detail: failing.length ? `${failing.length} check(s) failing: ${failing.map((f) => f.label).join(', ')}` : 'database, home folder and hosts look right', action: { label: 'See checks', run: () => go('settings') } },
    { done: !!ov.inventory, title: 'Your existing skills are indexed', detail: ov.inventory ? `${ov.inventory.indexed} skill(s) already on this machine indexed and audited (read only), ${ov.inventory.flagged} flagged` : 'Synaptome has not looked at the skills already installed on this machine', action: { label: 'Index them', run: () => run('inventory.run', {}, (r: any) => `${r.indexed} indexed, ${r.flagged.length} flagged`) } },
    { done: ov.candidates.total > 0, title: 'Discovery has run at least once', detail: ov.candidates.total ? `${ov.candidates.total} candidate(s) found across sources` : 'no scan yet', action: { label: 'Open Sources', run: () => go('sources') } },
    { done: verified.length > 0, title: 'A model provider is verified', detail: verified.length ? `verified: ${verified.map((p) => p.title).join(', ')}` : 'needed for the forge, evaluations and agent teams; check one on Integrations', action: { label: 'Open Integrations', run: () => go('integrations') } },
    { done: ov.routing.decisions > 0, title: 'Routing has seen real tasks', detail: ov.routing.decisions ? `${ov.routing.decisions} routing decision(s) recorded` : 'connect a project so its prompts are routed: synaptome bridge init <project folder>', action: { label: 'Open Routing Explorer', run: () => go('routing') } },
  ];
  const done = steps.filter((s) => s.done).length;
  return (
    <>
      <PageHeader title="Get started">{done === steps.length ? 'Everything is set up.' : `${done} of ${steps.length} done. Each step is read from the system's current state.`}</PageHeader>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.title}>
            <div><Mark s={s.done ? 'succeeded' : 'pending'} label={s.done ? 'done' : 'to do'} /> <span className="name">{s.title}</span></div>
            <div className="muted">{s.detail}</div>
            {!s.done && s.action ? <div className="actions"><Button kind="quiet" onClick={s.action.run}>{s.action.label}</Button></div> : null}
          </li>
        ))}
      </ol>
    </>
  );
}

/* =====================================================================
 * Sources — where capabilities come from: health, access terms, budgets and every recent check.
 * ===================================================================== */
export function Sources() {
  const { open, selection, run } = useApp();
  const q = useQuery('sources.list');
  return (
    <>
      <PageHeader title="Sources" actions={<Button kind="quiet" onClick={() => run('sources.check', {}, 'Every source was checked')}>Check all now</Button>}>
        Where capabilities are discovered. A source is queried only when its terms allow it, it is not backing off after failures, and its daily budget is not spent.
      </PageHeader>
      <Loaded q={q} rows={6}>
        {(rows: any[]) => (
          <DataTable
            label="Discovery sources"
            rows={rows}
            rowKey={(s) => s.id}
            selected={selection?.type === 'source' ? selection.id : null}
            onOpen={(s) => open({ type: 'source', id: s.id })}
            cols={[
              { key: 't', title: 'Source', width: '26%', render: (s) => <span className="name">{s.title}{s.official ? <span className="faint"> · official</span> : null}</span> },
              { key: 'h', title: 'Health', width: '120px', render: (s) => <Mark s={s.health} /> },
              { key: 'g', title: 'May scan now', width: '30%', render: (s) => (!s.enabled ? <span className="muted">switched off</span> : s.gate.ok ? <span>yes</span> : <span className="muted">{s.gate.reason}</span>) },
              { key: 'u', title: 'Today', width: '120px', cls: 'hide-sm', render: (s) => <span className="num muted">{s.gate.today.scans} scan{s.gate.today.scans === 1 ? '' : 's'} · {s.gate.today.requests} req</span> },
              { key: 'c', title: 'Found', width: '70px', render: (s) => <span className="num">{s.candidates}</span> },
              { key: 'l', title: 'Last scan', cls: 'hide-sm', render: (s) => <span className="muted">{s.lastScanAt ? ago(s.lastScanAt) : 'never'}</span> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

export function SourceInspector({ id }: { id: string }) {
  const { run, confirm } = useApp();
  const list = useQuery('sources.list');
  const checks = useQuery('sources.checks', { id, limit: 20 });
  const s = (list.data as any[] | undefined)?.find((x) => x.id === id);
  if (!s) return <Loaded q={list} rows={4}>{() => <Empty title="Source not found" />}</Loaded>;
  const b = s.gate.budget ?? {};
  return (
    <>
      <h2>{s.title}</h2>
      <p className="muted">{s.description}</p>
      <KV items={[['Id', <span className="mono">{s.id}</span>], ['Health', <><Mark s={s.health} /> {s.healthDetail}</>], ['Enabled', s.enabled ? 'yes' : 'no'], ['Terms', s.gate.terms ? `${s.gate.terms.allowed ? 'allowed' : 'not allowed'}: ${s.gate.terms.basis}` : 'not recorded'], ['Backoff', s.gate.backoffUntil ? `${s.gate.failures} failure(s); until ${when(s.gate.backoffUntil)}` : 'none'], ['Budget', `${b.scansPerDay ?? 'no limit'} scans/day · ${b.requestsPerDay ?? 'no limit'} requests/day · ${b.maxPerScan ?? 'default'} per scan`], ['Last success', s.lastOkAt ? when(s.lastOkAt) : 'never']]} />
      <div className="actions">
        <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: `${s.enabled ? 'Switch off' : 'Switch on'} ${s.title}?`, consequences: [s.enabled ? 'It will not be scanned until switched on again.' : 'It will be scanned on the next run, within its budget.'], confirmLabel: s.enabled ? 'Switch off' : 'Switch on' }); if (ok) await run('sources.setEnabled', { id, enabled: !s.enabled }, `${s.title} ${s.enabled ? 'switched off' : 'switched on'}`); }}>{s.enabled ? 'Switch off…' : 'Switch on…'}</Button>
        <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: `Daily scan budget for ${s.title}`, confirmLabel: 'Save', input: { label: 'Scans per day (empty for no limit)', placeholder: String(b.scansPerDay ?? '') } }); if (ok) await run('sources.setBudget', { id, scansPerDay: ok.input === '' ? null : Number(ok.input), requestsPerDay: b.requestsPerDay ?? null, maxPerScan: b.maxPerScan ?? null }, 'Budget saved'); }}>Set scan budget…</Button>
      </div>
      <h3>Recent checks</h3>
      <Loaded q={checks} rows={4}>
        {(c: any[]) => (c.length ? (
          <ol className="steps">
            {c.map((x, i) => (
              <li key={i}>
                <div><Mark s={x.ok ? 'ok' : 'fail'} /> <span className="muted num">{when(x.at)}</span>{x.latencyMs != null ? <span className="faint num"> · {x.latencyMs} ms</span> : null}{x.requests ? <span className="faint num"> · {x.requests} req</span> : null}</div>
                <div className="muted">{x.detail}</div>
              </li>
            ))}
          </ol>
        ) : <Empty title="No checks recorded">Run a health check above.</Empty>)}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Notifications — things that need a person, newest first.
 * ===================================================================== */
export function Notifications() {
  const { run } = useApp();
  const q = useQuery('notifications.list', { all: true, limit: 100 });
  return (
    <>
      <PageHeader title="Notifications" actions={<Button kind="quiet" onClick={() => run('notifications.read', {}, 'All marked as read')}>Mark all read</Button>}>
        Approvals waiting, updates that change risk, sources that keep failing, publishers that changed. Each appears once, however often the cause recurs.
      </PageHeader>
      <Loaded q={q} rows={6}>
        {(rows: any[]) => (rows.length ? (
          <ol className="steps">
            {rows.map((n) => (
              <li key={n.id} className={n.readAt ? 'muted' : ''}>
                <div><Mark s={n.level === 'action' ? 'waiting' : n.level === 'warning' ? 'warn' : 'ok'} label={n.level} /> <span className="name">{n.title}</span> <span className="faint num">{ago(n.ts)}</span></div>
                <div className="muted">{n.body}</div>
                {!n.readAt ? <div className="actions"><Button kind="quiet" onClick={() => run('notifications.read', { id: n.id }, 'Marked as read')}>Mark read</Button></div> : null}
              </li>
            ))}
          </ol>
        ) : <Empty title="Nothing needs you">Notifications appear here when an approval is waiting or a source, update or publisher needs attention.</Empty>)}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Integrations — model providers (where task text can go) and host adapters (where capabilities are installed).
 * ===================================================================== */
export function Integrations() {
  const { run, confirm } = useApp();
  const providers = useQuery('providers.list');
  const adapters = useQuery('system.adapters', {}, { live: false });
  return (
    <>
      <PageHeader title="Integrations">A provider is VERIFIED only by a recorded live call. Credentials are read from the environment when a call is made and never stored.</PageHeader>
      <h2 className="sect">Model providers</h2>
      <Loaded q={providers} rows={5}>
        {(rows: any[]) => (
          <DataTable
            label="Model providers"
            rows={rows}
            rowKey={(p) => p.id}
            cols={[
              { key: 't', title: 'Provider', width: '28%', render: (p) => <span className="name">{p.title}</span> },
              { key: 's', title: 'Status', width: '120px', render: (p) => <Mark s={p.status === 'VERIFIED' ? 'VERIFIED' : p.status === 'FAILED' ? 'fail' : 'UNSUPPORTED'} label={p.status.toLowerCase()} /> },
              { key: 'w', title: 'Task text', width: '130px', render: (p) => <span className="muted">{p.location === 'local' ? 'stays on this machine' : 'leaves this machine'}</span> },
              { key: 'm', title: 'Model', width: '150px', cls: 'hide-sm', render: (p) => <span className="mono faint">{p.model ?? 'not set'}</span> },
              { key: 'l', title: 'Last check', cls: 'hide-sm', render: (p) => <span className="muted">{p.lastCheck ? `${ago(p.lastCheck.at)} — ${p.lastCheck.detail}` : 'never checked'}</span> },
              { key: 'a', title: '', width: '90px', render: (p) => <Button kind="quiet" onClick={async () => { const ok = await confirm({ title: `Check ${p.title}?`, consequences: [p.location === 'remote' ? 'Sends one short test prompt off this machine.' : 'Calls the local server once.'], confirmLabel: 'Check' }); if (ok) await run('providers.test', { id: p.id }, (r: any) => `${p.id}: ${r.ok ? 'verified' : 'not verified'} — ${r.detail}`); }}>Check…</Button> },
            ]}
          />
        )}
      </Loaded>
      <h2 className="sect">Host adapters</h2>
      <Loaded q={adapters} rows={4}>
        {(rows: any[]) => (
          <DataTable
            label="Host adapters"
            rows={rows}
            rowKey={(a) => a.id}
            cols={[
              { key: 't', title: 'Host', width: '22%', render: (a) => <span className="name">{a.title}</span> },
              { key: 's', title: 'Status', width: '150px', render: (a) => <Mark s={a.status} /> },
              { key: 'k', title: 'Installs', width: '22%', render: (a) => <span className="muted">{a.kinds.join(', ') || '—'}</span> },
              { key: 'e', title: 'Evidence', cls: 'wrap', render: (a) => <span className="muted">{a.evidence}</span> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Agents — the specialists a team is made of.
 * ===================================================================== */
export function Agents() {
  const q = useQuery('agents.list', {}, { live: false });
  return (
    <>
      <PageHeader title="Agents">Specialists run as steps of a workflow, so ordering, approvals, budgets and resume come from one place. Start a team from Workflows (“Build a small change with a specialist team”).</PageHeader>
      <Loaded q={q} rows={5}>
        {(rows: any[]) => (
          <ol className="steps">
            {rows.map((a) => (
              <li key={a.id}>
                <div><span className="name">{a.title}</span> <span className="faint mono">{a.id}</span> <Mark s={a.workspace === 'read' ? 'ok' : a.workspace === 'none' ? 'pending' : 'warn'} label={`workspace: ${a.workspace}`} /></div>
                <div>{a.role}.</div>
                <div className="muted">{a.instructions}</div>
              </li>
            ))}
          </ol>
        )}
      </Loaded>
    </>
  );
}

/* =====================================================================
 * Evaluation Lab — eval sets (with their split and authors) and every evaluation run.
 * ===================================================================== */
export function EvalLab() {
  const { open, selection } = useApp();
  const sets = useQuery('evalsets.list');
  const runs = useQuery('evals.list', { limit: 40 });
  return (
    <>
      <PageHeader title="Evaluation Lab">Promotion is decided on held-out cases only. The run that wrote a skill may not write its held-out cases; every case records its author.</PageHeader>
      <h2 className="sect">Evaluation sets</h2>
      <Loaded q={sets} rows={3}>
        {(rows: any[]) => (rows.length ? (
          <DataTable
            label="Evaluation sets"
            rows={rows}
            rowKey={(s) => s.subjectId}
            selected={selection?.type === 'evalset' ? selection.id : null}
            onOpen={(s) => open({ type: 'evalset', id: s.subjectId })}
            cols={[
              { key: 's', title: 'Subject', width: '32%', render: (s) => <span className="mono">{s.subjectId}</span> },
              { key: 't', title: 'Training', width: '20%', render: (s) => <span className="num muted">{s.train.positive}+ {s.train.negative}− {s.train.behaviour} graded</span> },
              { key: 'h', title: 'Held-out', width: '20%', render: (s) => <span className="num">{s.heldout.positive}+ {s.heldout.negative}− {s.heldout.behaviour} graded</span> },
              { key: 'a', title: 'Authors', render: (s) => <span className="muted">{s.authors.length}</span> },
            ]}
          />
        ) : <Empty title="No evaluation sets yet">Sets are created when a forge candidate is checked or cases are added with synaptome evalset add.</Empty>)}
      </Loaded>
      <h2 className="sect">Evaluation runs</h2>
      <Loaded q={runs} rows={4}>
        {(rows: any[]) => (rows.length ? (
          <DataTable
            label="Evaluation runs"
            rows={rows}
            rowKey={(r) => String(r.id)}
            cols={[
              { key: 'w', title: 'When', width: '128px', render: (r) => <span className="muted num">{when(r.createdAt)}</span> },
              { key: 's', title: 'Subject', width: '28%', render: (r) => <span className="mono">{r.subjectId}</span> },
              { key: 'u', title: 'Suite', width: '96px', render: (r) => r.suite },
              { key: 'x', title: 'Status', width: '110px', render: (r) => <Mark s={r.status} /> },
              { key: 'r', title: 'Result', render: (r) => <span className="muted num">{r.summary?.splits?.heldout ? `held-out ${r.summary.splits.heldout.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(' · ')}` : r.summary?.variants ? r.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(' · ') : r.summary?.blocker ?? ''}</span> },
            ]}
          />
        ) : <Empty title="No evaluation runs yet" />)}
      </Loaded>
    </>
  );
}

export function EvalSetInspector({ id }: { id: string }) {
  const q = useQuery('evalsets.get', { id });
  return (
    <Loaded q={q} rows={6}>
      {(d: any) => (
        <>
          <h2 className="mono">{id}</h2>
          <KV items={[['Training', `${d.summary.train.positive} positive · ${d.summary.train.negative} negative · ${d.summary.train.behaviour} graded`], ['Held-out', `${d.summary.heldout.positive} positive · ${d.summary.heldout.negative} negative · ${d.summary.heldout.behaviour} graded`], ...d.summary.authors.map((a: any) => ['Author', `${a.author} — ${a.cases} case(s) in ${a.splits.join(', ')}`] as [string, string])]} />
          <h3>Cases</h3>
          <ol className="steps">
            {d.cases.map((c: any) => (
              <li key={c.id}>
                <div><Mark s={c.split === 'heldout' ? 'waiting' : 'pending'} label={c.split === 'heldout' ? 'held-out' : 'training'} /> <span className="faint mono">{c.id} · {c.kind}</span></div>
                <div>{c.prompt}</div>
                {c.must.length ? <div className="muted mono small">must: {c.must.join(' | ')}{c.mustNot.length ? ` · must not: ${c.mustNot.join(' | ')}` : ''}</div> : null}
              </li>
            ))}
          </ol>
        </>
      )}
    </Loaded>
  );
}
