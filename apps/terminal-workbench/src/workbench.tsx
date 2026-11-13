import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { watchEvents } from '@synaptome/core';
import type { Api } from '@synaptome/service';
import { ABOUT, type Action, BLANK, GLOBAL_ACTIONS, GLYPH, H, type Item, type Line, P, type Seg, type Tone, VIEWS } from './model';
import { clip, fitLine, pad, wrapLine } from './text';
import { NO_COLOR, THEMES } from './theme';

/** State whose latest value is also available synchronously (before the next render). */
function useSync<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T | ((prev: T) => T)) => {
    ref.current = typeof next === 'function' ? (next as (p: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref] as const;
}

/* ---------- app ---------- */

const NO_ROWS: Item[] = [];
type Mode = 'browse' | 'filter' | 'palette' | 'actions' | 'input' | 'confirm' | 'help' | 'output';
export interface WorkbenchProps {
  api: Api;
  theme?: string;
  size?: { columns: number; rows: number };
  onQuit?: () => void;
  /** How often to look for events committed by other processes (ms); 0 turns live updates off (tests). */
  pollMs?: number;
  /** Mouse reports are on (the caller enabled SGR mouse mode): click to select, click again to open, wheel to scroll. */
  mouse?: boolean;
  /** The view to open first (by id); Overview when absent. */
  initialView?: string;
  /** Called once, when the first view has loaded its rows (the first frame with data). */
  onReady?: () => void;
  /** Called after each render with the frame's text, one string per terminal row (diagnostics and the terminal matrix). */
  onFrame?: (lines: string[]) => void;
}

/** SGR mouse reports, as Ink delivers them (the leading ESC removed): `[<button;column;row` then M (press) or m (release). */
const MOUSE_RE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
export function parseMouse(input: string): { button: number; x: number; y: number; press: boolean }[] | null {
  if (!input.includes('[<')) return null;
  const out = [...input.matchAll(MOUSE_RE)].map((m) => ({ button: Number(m[1]), x: Number(m[2]) - 1, y: Number(m[3]) - 1, press: m[4] === 'M' }));
  return out.length ? out : null;
}

export function Workbench({ api, theme: themeProp, size, onQuit, pollMs = 250, mouse = false, onReady, onFrame, initialView }: WorkbenchProps) {
  const { stdout } = useStdout();
  const [dims, setDims] = useState(size ?? { columns: stdout?.columns ?? 100, rows: stdout?.rows ?? 30 });
  useEffect(() => {
    if (size || !stdout) return;
    const on = () => setDims({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', on);
    return () => void stdout.off('resize', on);
  }, [stdout, size]);
  const W = Math.max(40, dims.columns);
  const HGT = Math.max(12, dims.rows);

  const [theme, setTheme] = useState(themeProp && THEMES[themeProp] ? themeProp : 'auto');
  const pal = THEMES[theme];
  // The view index is read synchronously by key handlers, so two quick Tabs move two views.
  const [vi, setVi, viRef] = useSync(Math.max(0, VIEWS.findIndex((v) => v.id === initialView)));
  const view = VIEWS[vi];
  const [filters, setFilters] = useState<Record<string, string>>({});
  const filter = filters[view.id] ?? '';
  // Rows remember which view they were loaded for, so rows of the previous view are never selected, inspected or
  // acted on while the next view loads (ids can repeat across views: a source id appears in Overview and Sources).
  const [loaded, setLoaded] = useState<{ view: string; rows: Item[] }>({ view: '', rows: [] });
  const items = loaded.view === view.id ? loaded.rows : NO_ROWS;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [inspector, setInspector] = useState<Line[]>([]);
  const [showInspector, setShowInspector] = useState(false);
  const [inspScroll, setInspScroll] = useState(0);
  // Keys can arrive faster than React re-renders (paste, key repeat), so interaction state is also
  // readable synchronously through refs; the key handler never acts on a stale value.
  const [mode, setMode, modeRef] = useSync<Mode>('browse');
  const [text, setText, textRef] = useSync('');
  const [menu, setMenu, menuRef] = useSync<Action[]>([]);
  const [menuSel, setMenuSel, menuSelRef] = useSync(0);
  const [pending, setPending, pendingRef] = useSync<{ action: Action; input: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null);
  const [busy, setBusy] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [rev, setRev] = useState(0);
  const [ticker, setTicker] = useState('');
  const lastEvent = useRef<number | null>(null);

  const selectable = useMemo(() => items.map((it, i) => (it.section ? -1 : i)).filter((i) => i >= 0), [items]);
  const current: Item | null = items[sel] && !items[sel].section ? items[sel] : null;

  // Load the active view; keep the selection on the same item when data refreshes.
  const selId = useRef<string | null>(null);
  selId.current = current?.id ?? selId.current;
  const readyFired = useRef(false);
  useEffect(() => {
    let dead = false;
    setLoading(true);
    view
      .load(api, filter)
      .then((rows) => {
        if (dead) return;
        // Ink re-renders after each state update here (no batching in promise callbacks), and each render records the
        // selected id; so the selection is decided before the rows change, never from a render that mixed the two.
        const want = view.takeFocus?.(api) ?? selId.current;
        const keep = rows.findIndex((r) => !r.section && r.id === want);
        setSel(keep >= 0 ? keep : Math.max(0, rows.findIndex((r) => !r.section)));
        setLoaded({ view: view.id, rows });
        setError('');
      })
      .catch((e) => !dead && setError(e?.message ?? String(e)))
      .finally(() => {
        if (dead) return;
        setLoading(false);
        if (!readyFired.current) (readyFired.current = true), onReady?.();
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vi, filter, rev]);

  useEffect(() => {
    if (!current) return setInspector([]);
    let dead = false;
    const t = setTimeout(() => {
      view.inspect(api, current).then((l) => !dead && setInspector(l)).catch((e) => !dead && setInspector([P(`Could not load details: ${e?.message ?? e}`, 'danger')]));
    }, 60);
    return () => {
      dead = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, vi, rev]);
  useEffect(() => setInspScroll(0), [current?.id, vi]);

  // Live events from the shared append-only log (the same one the Web UI streams): this process's events arrive at
  // once, other processes' within `pollMs` (an idle check is one SQLite pragma read). A burst of events, such as a
  // scan, reloads the view at most once per 150 ms; the ticker always shows the newest event.
  useEffect(() => {
    if (!pollMs) return;
    let reload: ReturnType<typeof setTimeout> | null = null;
    const stop = watchEvents(api.sys.db, (rows) => {
      const e = rows[rows.length - 1];
      lastEvent.current = e.id;
      setTicker(`${e.ts.slice(11, 19)} ${e.type} ${e.subject ?? ''} via ${e.origin ?? '?'}`);
      if (!reload) reload = setTimeout(() => ((reload = null), setRev((r) => r + 1)), 150);
    }, { intervalMs: pollMs });
    return () => {
      stop();
      if (reload) clearTimeout(reload);
    };
  }, [api, pollMs]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  // Three panes need room; a default 120-column terminal gets navigation + a full-width list,
  // with the inspector one key away.
  const layout = W >= 132 ? 'wide' : W >= 78 ? 'medium' : 'narrow';
  const navW = layout === 'wide' ? 19 : layout === 'medium' ? 16 : 0;
  const inspW = layout === 'wide' ? Math.min(52, Math.floor(W * 0.36)) : 0;
  const bodyH = HGT - 4;

  const move = useCallback(
    (delta: number) => {
      if (!selectable.length) return;
      const at = selectable.indexOf(sel);
      const next = selectable[Math.max(0, Math.min(selectable.length - 1, (at < 0 ? 0 : at) + delta))];
      setSel(next);
    },
    [selectable, sel],
  );
  const switchView = (i: number) => {
    setVi((i + VIEWS.length) % VIEWS.length);
    setMarked(new Set());
    setShowInspector(false);
    selId.current = null;
  };

  const execute = async (action: Action, input: string) => {
    setMode('browse');
    setBusy(action.label);
    try {
      const msg = await action.run(api, input);
      if (msg.startsWith('\n')) {
        setOutput(msg.slice(1).split(/\r?\n/));
        setInspScroll(0);
        setMode('output');
      } else setToast({ text: msg, tone: 'ok' });
      setMarked(new Set());
      setRev((r) => r + 1);
    } catch (e: any) {
      setToast({ text: `${e?.message ?? e}${e?.hint ? ` — ${e.hint}` : ''}`, tone: 'danger' });
    } finally {
      setBusy('');
      setPending(null);
    }
  };
  const begin = (action: Action) => {
    if (action.go) {
      const i = VIEWS.findIndex((v) => v.id === action.go);
      setMode('browse');
      if (i >= 0) switchView(i);
      return;
    }
    setPending({ action, input: '' });
    setText('');
    if (action.input) setMode('input');
    else if (action.confirm) setMode('confirm');
    else void execute(action, '');
  };
  const openMenu = (list: Action[]) => {
    if (!list.length) return setToast({ text: 'No actions for this item', tone: 'mid' });
    setMenu(list);
    setMenuSel(0);
    setText('');
    setMode('actions');
  };
  const paletteActions: Action[] = useMemo(
    () => [
      ...VIEWS.map((v, i) => ({ label: `Go to ${v.title}`, hint: i < 9 ? `key ${i + 1}` : 'Tab or left/right', run: async () => (switchView(i), `opened ${v.title}`) })),
      ...GLOBAL_ACTIONS,
      { label: 'Run diagnostics', hint: 'shown in Overview', run: async () => (switchView(0), setRev((r) => r + 1), 'diagnostics refreshed') },
      ...['dark', 'light', 'auto'].map((t) => ({ label: `Theme: ${t}`, hint: 'appearance', run: async (a: Api) => (setTheme(t), await a.call('settings.set', { key: 'ui.theme', value: t }), `theme ${t}`) })),
      { label: 'Quit', hint: 'q', run: async () => (onQuit?.(), 'bye') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onQuit],
  );
  const filteredMenu = mode === 'palette' ? paletteActions.filter((a) => !text || `${a.label} ${a.hint ?? ''}`.toLowerCase().includes(text.toLowerCase())) : menu;

  // Mouse: only presses and the wheel are reported (no motion). A report is never treated as typed text.
  const onMouse = (events: NonNullable<ReturnType<typeof parseMouse>>) => {
    for (const e of events) {
      if (!e.press || e.button & 32) continue; // releases and motion
      const wheel = e.button & 64 ? (e.button & 1 ? 1 : -1) : 0;
      const left = (e.button & 3) === 0 && !wheel;
      const bodyRow = e.y - 2;
      const listX = navW ? navW + 1 : 0;
      const inspX = listX + listW + 1;
      const m = modeRef.current;
      if (m === 'help' || m === 'output') {
        if (wheel) setInspScroll((s) => Math.max(0, s + wheel * 3));
        continue;
      }
      if (m !== 'browse' || bodyRow < 0 || bodyRow >= bodyH) continue;
      if (navW && e.x < navW) {
        const k = navStart + bodyRow - 1;
        if (left && bodyRow >= 1 && VIEWS[k]) switchView(k);
        else if (wheel) switchView(viRef.current + wheel);
        continue;
      }
      const inInspector = (inspW && e.x >= inspX) || (showInspector && layout !== 'wide');
      if (inInspector) {
        if (wheel) setInspScroll((s) => Math.max(0, s + wheel * 3));
        continue;
      }
      if (e.x < listX) continue;
      if (wheel) {
        move(wheel * 3);
        continue;
      }
      const rowsH = bodyH - 2;
      const start = Math.max(0, Math.min(sel - Math.floor(rowsH / 2), items.length - rowsH));
      const i = start + bodyRow - 2;
      if (!left || bodyRow < 2 || !items[i] || items[i].section) continue;
      if (i === sel) {
        // A second click on the selected row does what Enter does.
        if (layout === 'wide') openMenu(view.actions(current, items.filter((it) => marked.has(it.id))));
        else setShowInspector(true);
      } else setSel(i);
    }
  };

  useInput((input, key) => {
    const mouseEvents = parseMouse(input);
    if (mouseEvents) return mouse ? onMouse(mouseEvents) : undefined;
    if (key.ctrl && input === 'c') return onQuit?.();
    const mode = modeRef.current;
    const text = textRef.current;
    const menu = menuRef.current;
    const menuSel = menuSelRef.current;
    const pending = pendingRef.current;
    const filteredMenu = mode === 'palette' ? paletteActions.filter((a) => !text || `${a.label} ${a.hint ?? ''}`.toLowerCase().includes(text.toLowerCase())) : menu;
    const typing = mode === 'filter' || mode === 'input' || mode === 'palette';
    if (typing) {
      if (key.escape) {
        if (mode === 'filter') setFilters((f) => ({ ...f, [view.id]: '' }));
        setPending(null);
        return setMode('browse');
      }
      if (key.return) {
        if (mode === 'filter') return setMode('browse');
        if (mode === 'palette') {
          const a = filteredMenu[menuSel];
          return a ? begin(a) : undefined;
        }
        if (mode === 'input' && pending) {
          if (pending.action.input?.required && !text.trim()) return setToast({ text: 'A value is required', tone: 'warn' });
          const next = { action: pending.action, input: text.trim() };
          setPending(next);
          return pending.action.confirm ? setMode('confirm') : void execute(next.action, next.input);
        }
        return;
      }
      if (mode === 'palette' && (key.upArrow || key.downArrow)) return setMenuSel((s) => Math.max(0, Math.min(filteredMenu.length - 1, s + (key.downArrow ? 1 : -1))));
      const apply = (fn: (s: string) => string) => {
        if (mode === 'filter') setFilters((f) => ({ ...f, [view.id]: fn(f[view.id] ?? '') }));
        else (setText(fn), setMenuSel(0));
      };
      if (key.backspace || key.delete) return apply((s) => [...s].slice(0, -1).join(''));
      if (input && !key.ctrl && !key.meta) return apply((s) => s + input.replace(/[\r\n]/g, ''));
      return;
    }
    if (mode === 'confirm') {
      if (input === 'y' || input === 'Y') return pending && void execute(pending.action, pending.input);
      if (input === 'n' || input === 'N' || key.escape || key.return) return (setPending(null), setMode('browse'));
      return;
    }
    if (mode === 'actions') {
      if (key.escape) return setMode('browse');
      if (key.upArrow || input === 'k') return setMenuSel((s) => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') return setMenuSel((s) => Math.min(menu.length - 1, s + 1));
      if (key.return) return menu[menuSel] && begin(menu[menuSel]);
      return;
    }
    if (mode === 'help' || mode === 'output') {
      if (key.downArrow || input === 'j') return setInspScroll((s) => s + 1);
      if (key.upArrow || input === 'k') return setInspScroll((s) => Math.max(0, s - 1));
      if (key.pageDown) return setInspScroll((s) => s + bodyH - 2);
      if (key.pageUp) return setInspScroll((s) => Math.max(0, s - bodyH + 2));
      if (key.escape || key.return || input === 'q' || input === '?') return (setInspScroll(0), setMode('browse'));
      return;
    }
    // browse
    if (input === 'q') return onQuit?.();
    if (input === '?') return (setInspScroll(0), setMode('help'));
    if (input === '/') return setMode('filter');
    if (input === ':' || (key.ctrl && input === 'k') || (key.ctrl && input === 'p')) return (setText(''), setMenuSel(0), setMode('palette'));
    if (input === 't') {
      // Saved as the shared ui.theme setting, so the next start (and the Web Command Center's default) follows it.
      const next = ({ auto: 'dark', dark: 'light', light: 'auto' } as Record<string, string>)[theme] ?? 'auto';
      setTheme(next);
      void api.call('settings.set', { key: 'ui.theme', value: next }).catch(() => setToast({ text: 'theme changed for this session only (could not save it)', tone: 'warn' }));
      return;
    }
    if (input === 'r') return (setRev((r) => r + 1), setToast({ text: 'refreshed', tone: 'mid' }));
    if (/^[1-9]$/.test(input) && VIEWS[Number(input) - 1]) return switchView(Number(input) - 1);
    if (key.tab) return switchView(viRef.current + (key.shift ? -1 : 1));
    if (showInspector && layout !== 'wide') {
      if (key.escape || input === 'i' || key.leftArrow || input === 'h') return setShowInspector(false);
      if (key.downArrow || input === 'j') return setInspScroll((s) => s + 1);
      if (key.upArrow || input === 'k') return setInspScroll((s) => Math.max(0, s - 1));
      if (key.pageDown) return setInspScroll((s) => s + bodyH - 2);
      if (key.pageUp) return setInspScroll((s) => Math.max(0, s - bodyH + 2));
      if (input === 'a') return openMenu(view.actions(current, items.filter((i) => marked.has(i.id))));
      return;
    }
    if (key.downArrow || input === 'j') return move(1);
    if (key.upArrow || input === 'k') return move(-1);
    if (key.pageDown) return move(bodyH - 4);
    if (key.pageUp) return move(-(bodyH - 4));
    if (input === 'g') return move(-99999);
    if (input === 'G') return move(99999);
    if (key.leftArrow || input === 'h') return switchView(viRef.current - 1);
    if (key.rightArrow || input === 'l') return switchView(viRef.current + 1);
    if (input === ']') return setInspScroll((s) => s + 5);
    if (input === '[') return setInspScroll((s) => Math.max(0, s - 5));
    if (input === ' ' && current) return setMarked((m) => (m.has(current.id) ? new Set([...m].filter((x) => x !== current.id)) : new Set([...m, current.id])));
    if (input === 'a') return openMenu(view.actions(current, items.filter((i) => marked.has(i.id))));
    if (input === 'i') return layout === 'wide' ? undefined : setShowInspector(true);
    if (key.return) return layout === 'wide' ? openMenu(view.actions(current, items.filter((i) => marked.has(i.id)))) : current && setShowInspector(true);
    if (key.escape && filter) return setFilters((f) => ({ ...f, [view.id]: '' }));
  });

  /* ---------- drawing: the whole screen is a grid of exactly W x HGT cells ---------- */

  const rule = (w: number): Line => [{ t: GLYPH.rule.repeat(w), c: 'dim' }];
  const listW = W - navW - (navW ? 1 : 0) - (inspW ? inspW + 1 : 0);

  function listPane(w: number, h: number): Line[] {
    const out: Line[] = [];
    // Choose columns that fit: optional ones give way first.
    let cols = view.columns.map((c, i) => ({ ...c, i }));
    const fixed = () => cols.reduce((n, c) => n + c.width + 1, 2);
    while (fixed() > w - 14 && cols.some((c) => c.optional)) cols.splice(cols.map((c) => !!c.optional).lastIndexOf(true), 1);
    const flex = Math.max(8, w - 2 - cols.reduce((n, c) => n + c.width, 0) - (cols.length - 1)) / Math.max(1, cols.filter((c) => !c.width).length);
    const widths = cols.map((c) => c.width || Math.floor(flex));
    const title = `${view.title}${filter ? `  /${filter}` : ''}`;
    const count = loading && !items.length ? 'loading…' : `${selectable.length ? selectable.indexOf(sel) + 1 : 0}/${selectable.length}${marked.size ? `  ${marked.size} marked` : ''}`;
    out.push(fitLine([{ t: title, b: true, c: 'fg' }, { t: ' '.repeat(Math.max(1, w - stringWidth(title) - stringWidth(count))) }, { t: count, c: 'dim' }], w));
    out.push(fitLine([{ t: '  ' }, ...cols.flatMap((c, k) => [{ t: pad(c.title.toUpperCase(), widths[k], c.right), c: 'dim' as Tone }, { t: ' ' }])], w));
    const rowsH = h - 2;
    if (error) return [...out, ...wrapLine([{ t: `Could not load ${view.title}: ${error}`, c: 'danger' }], w), fitLine([{ t: 'Press r to try again.', c: 'mid' }], w)].slice(0, h);
    if (!loading && !selectable.length) return [...out, BLANK, ...wrapLine([{ t: filter ? `Nothing matches "${filter}". Press Esc to clear the filter.` : view.empty, c: 'mid' }], w)].slice(0, h);
    const start = Math.max(0, Math.min(sel - Math.floor(rowsH / 2), items.length - rowsH));
    for (const [idx, it] of items.slice(start, start + rowsH).entries()) {
      const i = start + idx;
      if (it.section) {
        out.push(fitLine([{ t: ' ' }, ...(it.cells as Seg[])], w));
        continue;
      }
      const isSel = i === sel;
      const lead: Seg = { t: `${isSel ? GLYPH.sel : marked.has(it.id) ? GLYPH.mark : ' '} `, c: 'accent', b: true };
      const cells: Line = cols.flatMap((c, k) => {
        const cell = it.cells[c.i] ?? '';
        const s: Seg = typeof cell === 'string' ? { t: cell } : cell;
        return [{ ...s, t: pad(s.t, widths[k], c.right) }, { t: ' ' }];
      });
      out.push(fitLine([lead, ...cells], w).map((s) => ({ ...s, sel: isSel }) as Seg & { sel: boolean }));
    }
    return out;
  }

  function inspectorPane(w: number, h: number, lines: Line[], heading: string): Line[] {
    const wrapped = lines.flatMap((l) => wrapLine(l, w - 1));
    const max = Math.max(0, wrapped.length - (h - 1));
    const at = Math.min(inspScroll, max);
    const more = wrapped.length > h - 1 ? `  ${at + 1}-${Math.min(wrapped.length, at + h - 1)}/${wrapped.length}` : '';
    return [fitLine([{ t: heading, c: 'dim' }, { t: more, c: 'dim' }], w), ...wrapped.slice(at, at + h - 1).map((l) => fitLine(l, w))];
  }

  function overlay(w: number, h: number): Line[] | null {
    if (mode === 'help') {
      const now = view.actions(current, items.filter((i) => marked.has(i.id)));
      const about: Line[] = [H(view.title), ...wrapLine([{ t: ABOUT[view.id] ?? '', c: 'mid' }], w), BLANK, ...(now.length ? [P(`a  on the selected item: ${now.map((x) => x.label).slice(0, 6).join(', ')}${now.length > 6 ? ', …' : ''}`, 'mid')] : [P('a  no actions for the selected item', 'dim')]), BLANK];
      const mouseLines: Line[] = mouse ? [BLANK, H('Mouse'), P('click a row to select it, click it again to open it, click a view name to switch, wheel to scroll; Shift+drag selects text', 'mid')] : [];
      return inspectorPane(w, h, [...about, ...[H('Keyboard'), BLANK, ...[['up/down  j k', 'move'], ['PgUp PgDn  g G', 'page, top, bottom'], ['left/right  h l  Tab  1-9', `switch view (${VIEWS.length} views; : opens any by name)`], ['Enter', layout === 'wide' ? 'actions for the selected item' : 'open the inspector'], ['i  /  Esc', 'inspector (narrow layouts) / back'], ['[  ]', 'scroll the inspector'], ['a', 'actions for the selection'], ['Space', 'mark several items for one action'], ['/', `filter: ${view.filterHint}`], [':  or Ctrl+K', 'command palette'], ['r', 'refresh'], ['t', 'theme: auto, dark, light'], ['?', 'this help'], ['q  or Ctrl+C', 'quit']].map(([k, v]) => [{ t: pad(k, 28), b: true }, { t: v, c: 'mid' as Tone }] as Line), ...mouseLines, BLANK, P('Esc closes this help.', 'dim')]], 'Help   j/k scroll   Esc close');
    }
    if (mode === 'palette' || mode === 'actions') {
      const head: Line[] = mode === 'palette' ? [[{ t: 'Command ', c: 'accent', b: true }, { t: `${text}▏` }], rule(w)] : [[{ t: `Actions${current ? ` for ${typeof current.cells[0] === 'string' ? current.cells[0] : (current.cells.find((c) => typeof c !== 'string' && c.b) as Seg | undefined)?.t ?? ''}` : ''}`, c: 'accent', b: true }], rule(w)];
      const list = filteredMenu;
      const rows = h - head.length - 1;
      const start = Math.max(0, Math.min(menuSel - Math.floor(rows / 2), list.length - rows));
      const body = list.length ? list.slice(start, start + rows).map((a, k) => { const on = start + k === menuSel; return fitLine([{ t: on ? `${GLYPH.sel} ` : '  ', c: 'accent', b: true }, { t: pad(a.label, Math.min(44, w - 4)), b: on }, { t: ` ${a.hint ?? ''}`, c: 'dim' }], w).map((s) => ({ ...s, sel: on }) as Seg); }) : [fitLine([{ t: `  No command matches "${text}".`, c: 'mid' }], w)];
      return [...head.map((l) => fitLine(l, w)), ...body, fitLine([{ t: 'Enter run   Esc close', c: 'dim' }], w)].slice(0, h);
    }
    if (mode === 'input' && pending) return ([H(pending.action.label), BLANK, ...wrapLine([{ t: pending.action.input!.label, c: 'mid' }], w), BLANK, [{ t: '> ', c: 'accent', b: true }, { t: `${text}▏` }], BLANK, P('Enter continue   Esc cancel', 'dim')] as Line[]).map((l) => fitLine(l, w)).slice(0, h);
    if (mode === 'confirm' && pending) return ([H(`Confirm: ${pending.action.label}`), BLANK, P('What this does', 'dim'), ...(pending.action.confirm ?? []).flatMap((c) => wrapLine([{ t: `- ${c}`, c: /REAL|Failed|fail|unknown|Remove/.test(c) ? 'warn' : 'fg' }], w)), ...(pending.input ? [BLANK, P(`Note: ${pending.input}`, 'mid')] : []), BLANK, [{ t: 'y', c: 'accent', b: true }, { t: ' confirm     ' }, { t: 'n', c: 'accent', b: true }, { t: ' or Esc cancel' }]] as Line[]).map((l) => fitLine(l, w)).slice(0, h);
    if (mode === 'output') return inspectorPane(w, h, output.map((l) => P(l)), 'Output (shown as data)   Esc close');
    return null;
  }

  const screen: Line[] = [];
  const health = toast ? { t: clip(toast.text, Math.max(10, W - 34)), c: toast.tone } : busy ? { t: `working: ${busy}…`, c: 'accent' as Tone } : { t: '', c: 'dim' as Tone };
  screen.push(fitLine([{ t: ' SYNAPT', b: true }, { t: 'O', c: 'accent', b: true }, { t: 'ME', b: true }, { t: `  Terminal Workbench  `, c: 'dim' }, ...(layout === 'narrow' ? [{ t: `‹ ${vi + 1} ${view.title} ›`.replace('‹', '<').replace('›', '>'), c: 'accent' as Tone, b: true }] : []), { t: ' '.repeat(Math.max(1, W - 47 - (layout === 'narrow' ? view.title.length + 6 : 0))) }, { t: `theme ${theme}`, c: 'dim' }], W));
  screen.push(fitLine(rule(W), W));
  const over = overlay(listW + (layout === 'wide' ? 0 : 0), bodyH);
  const main = over ?? (showInspector && layout !== 'wide' ? inspectorPane(listW, bodyH, inspector.length ? inspector : [P('Nothing selected.', 'mid')], 'Inspector   Esc back   a actions') : listPane(listW, bodyH));
  const side = inspW ? inspectorPane(inspW, bodyH, inspector.length ? inspector : [P(current ? 'Loading…' : 'Select an item to inspect it.', 'mid')], 'INSPECTOR') : [];
  // The view list scrolls with the current view when the terminal is too short to show every view.
  const navRows = bodyH - 1;
  const navStart = VIEWS.length <= navRows ? 0 : Math.max(0, Math.min(vi - Math.floor(navRows / 2), VIEWS.length - navRows));
  for (let r = 0; r < bodyH; r++) {
    const row: Line = [];
    if (navW) {
      const k = navStart + r - 1;
      const v = r > 0 && r <= navRows ? VIEWS[k] : undefined;
      if (r === 0) row.push(...fitLine([{ t: ' VIEWS', c: 'dim' }, { t: VIEWS.length > navRows ? `  ${vi + 1}/${VIEWS.length}` : '', c: 'dim' }], navW));
      else if (v) row.push(...fitLine([{ t: k === vi ? `${GLYPH.sel}` : ' ', c: 'accent', b: true }, { t: k < 9 ? `${k + 1} ` : '  ', c: 'dim' }, { t: v.title, b: k === vi, c: k === vi ? 'fg' : 'mid' }], navW));
      else row.push({ t: ' '.repeat(navW) });
      row.push({ t: GLYPH.vrule, c: 'dim' });
    }
    row.push(...(main[r] ?? [{ t: ' '.repeat(listW) }]));
    if (inspW) row.push({ t: GLYPH.vrule, c: 'dim' }, ...(side[r] ?? [{ t: ' '.repeat(inspW) }]));
    screen.push(fitLine(row, W));
  }
  screen.push(fitLine([{ t: ' ' }, health.t ? health : { t: ticker || 'no new events', c: 'dim' }], W));
  const hints = mode === 'browse' ? (layout === 'narrow' ? '/ filter  a actions  Enter inspect  : commands  ? help  q quit' : `${GLYPH.sel} move j/k  views 1-9  / filter  a actions  Space mark  : commands  t theme  ? help  q quit`) : mode === 'filter' ? `filter: ${filter}▏   Enter keep   Esc clear` : 'Esc cancel';
  screen.push(fitLine([{ t: ' ' }, { t: hints, c: mode === 'filter' ? 'accent' : 'dim' }], W));

  const frameText = screen.slice(0, HGT).map((l) => l.map((s) => s.t).join(''));
  useEffect(() => {
    onFrame?.(frameText); // a block body: whatever the callback returns must not become this effect's cleanup
  });
  const color = (c?: Tone) => (NO_COLOR ? undefined : pal[c ?? 'fg'] || undefined);
  return (
    <Box flexDirection="column" width={W} height={HGT}>
      {screen.slice(0, HGT).map((line, r) => (
        <Text key={r} wrap="truncate-end">
          {line.map((s, k) => {
            const on = (s as any).sel;
            return (
              <Text key={k} color={color(s.c)} bold={s.b || on} dimColor={!NO_COLOR && theme === 'auto' && s.c === 'mid'} inverse={on && (NO_COLOR || !pal.sel)} backgroundColor={NO_COLOR ? undefined : on && pal.sel ? pal.sel : pal.bg}>
                {s.t}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}
