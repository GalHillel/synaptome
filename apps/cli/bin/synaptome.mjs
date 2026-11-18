#!/usr/bin/env node
// Synaptome launcher: silences Node's experimental-feature notices (they would corrupt the TUI and
// --json output), registers the TypeScript loader, then hands over to the CLI.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) : warning?.name;
  if (type === 'ExperimentalWarning') return;
  return emitWarning.call(process, warning, ...rest);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
process.env.TSX_TSCONFIG_PATH ??= path.join(root, 'tsconfig.json');
process.env.SYNAPTOME_ROOT ??= root;
// The command a host should run to reach this installation (written into project bridge files).
process.env.SYNAPTOME_LAUNCHER ??= fileURLToPath(import.meta.url);
// The development checkout never shares data with an installed package: without --home or SYNAPTOME_HOME it uses
// the checkout's own home. Done through argv, not the environment, so processes it starts are not affected.
const argHome = process.argv.slice(2).some((a) => a === '--home' || a.startsWith('--home='));
if (!argHome && !process.env.SYNAPTOME_HOME && !process.env.DRELQAVO_HOME) process.argv.splice(2, 0, '--home', path.join(root, '.synaptome-dev'));
globalThis.__SYNAPTOME_INSTALL__ = { kind: 'development', root };

const { register } = await import('tsx/esm/api');
register();
const { main } = await import(pathToFileURL(path.join(here, '..', 'src', 'main.ts')).href);
await main(process.argv);
