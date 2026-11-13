#!/usr/bin/env node
// Deprecated launcher kept for one release so that configuration written under the previous product name
// (project hooks, MCP entries, scripts) keeps resolving. It forwards to the Synaptome launcher unchanged.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.stderr.write('synaptome: the "drelqavo" command is deprecated; use "synaptome"\n');
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, 'synaptome.mjs')).href);
