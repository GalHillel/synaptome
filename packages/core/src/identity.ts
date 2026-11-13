/**
 * The single source of product identity. Every name the product shows, writes to disk, sends on the wire or
 * reads from the environment comes from here. Nothing may derive identity from the repository folder name.
 */
export const PRODUCT = {
  name: 'Synaptome',
  bin: 'synaptome',
  version: '0.2.0',
  tagline: 'One intelligence layer. Every capability. Always evolving.',
  /** Environment variables are `${envPrefix}_<NAME>`. */
  envPrefix: 'SYNAPTOME',
  /** Directory name under %LOCALAPPDATA% (or `.${dataDir}` under the user's home). */
  dataDir: 'synaptome',
  dbFile: 'synaptome.db',
  tokenHeader: 'x-synaptome-token',
  mcpName: 'synaptome',
  /** Written into every directory the product installs into a host; proves ownership before removal. */
  markerFile: '.synaptome.json',
  managedBy: 'synaptome',
  /** Per-snapshot integrity manifest in the store. */
  manifestFile: '.synaptome-manifest.json',
  /** Record of what `bridge init` added to a project, so `bridge remove` deletes exactly that. */
  bridgeFile: '.synaptome-bridge.json',
  userAgent: 'synaptome-discovery',
} as const;

/**
 * Names used before the product was called Synaptome. They exist only so that data and installations created
 * under the old name can be recognised and migrated. No new file, variable or message uses them.
 */
export const LEGACY = {
  name: 'DRELQAVO',
  envPrefix: 'DRELQAVO',
  dataDir: 'drelqavo',
  dbFile: 'drelqavo.db',
  markerFile: '.drelqavo.json',
  managedBy: 'drelqavo',
  manifestFile: '.drelqavo-manifest.json',
  bridgeFile: '.drelqavo-bridge.json',
  mcpName: 'drelqavo',
} as const;

const warned = new Set<string>();

/**
 * Reads `SYNAPTOME_<name>`. Falls back to the legacy variable for one deprecation period and says so once on
 * stderr (never stdout: that would corrupt --json output, the MCP stream and hook output).
 */
export function env(name: string): string | undefined {
  const current = process.env[`${PRODUCT.envPrefix}_${name}`];
  if (current !== undefined && current !== '') return current;
  const legacyKey = `${LEGACY.envPrefix}_${name}`;
  const legacy = process.env[legacyKey];
  if (legacy === undefined || legacy === '') return undefined;
  if (!warned.has(legacyKey)) {
    warned.add(legacyKey);
    process.stderr.write(`${PRODUCT.bin}: ${legacyKey} is deprecated; use ${PRODUCT.envPrefix}_${name}\n`);
  }
  return legacy;
}
