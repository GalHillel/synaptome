import { type ViewDef, mark, dim, mid, strong, H, P, KV, BLANK } from '../kit';

const workspaceMark = (w: string) => mark(w === 'read' ? 'ok' : w === 'none' ? 'pending' : 'warn', w);

/** Agents: the specialists a team is made of. They run as steps of a workflow; start a team from Workflows. */
export const view: ViewDef = {
  id: 'agents', title: 'Agents', filterHint: 'filter by name or role', empty: 'No specialist agents are defined.',
  columns: [{ title: 'Agent', width: 18 }, { title: 'Workspace', width: 17 }, { title: 'Role', width: 0 }],
  async load(api, f) {
    const q = f.toLowerCase();
    return (await api.call('agents.list'))
      .filter((a: any) => !q || `${a.id} ${a.title} ${a.role}`.toLowerCase().includes(q))
      .map((a: any) => ({ id: a.id, raw: a, cells: [strong(a.title), workspaceMark(a.workspace), mid(a.role)] }));
  },
  async inspect(_api, item) {
    const a = item.raw;
    return [
      [strong(a.title)], P(a.id, 'dim'), BLANK, P(`${a.role}.`), BLANK,
      [{ t: 'workspace     ', c: 'dim' }, workspaceMark(a.workspace)],
      P(a.workspace === 'read' ? '              reads the working directory, changes nothing' : a.workspace === 'edit' ? '              may change files inside the working directory' : a.workspace === 'edit-and-test' ? '              may change files and run the project tests' : '              no access to files', 'dim'),
      KV('capabilities', (a.capabilities ?? []).join(', ') || 'none'),
      BLANK, H('Instructions'), P(a.instructions, 'mid'),
      BLANK, [dim('Start a team from Workflows: "Build a small change with a specialist team".')],
    ];
  },
  actions: () => [],
};
