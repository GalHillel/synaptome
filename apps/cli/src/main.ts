import { Command } from 'commander';
import { PRODUCT } from '@synaptome/core';
import { registerAcquisition, registerPolicy } from './commands/acquisition';
import { registerDiscovery } from './commands/discovery';
import { registerForge } from './commands/forge';
import { registerMigrate } from './commands/migrate';
import { registerRouting } from './commands/routing';
import { registerSetup } from './commands/setup';
import { registerUpgrade } from './commands/upgrade';
import { registerSystem } from './commands/system';
import { registerUi } from './commands/ui';
import { registerAgents } from './commands/agents';
import { registerProviders } from './commands/providers';
import { registerWorkflow } from './commands/workflow';

export function buildProgram(): Command {
  const program = new Command(PRODUCT.bin)
    .description(`${PRODUCT.name} — ${PRODUCT.tagline}`)
    .version(PRODUCT.version)
    .option('--home <dir>', `${PRODUCT.name} home directory (default: the ${PRODUCT.envPrefix}_HOME variable, else the per-user data directory)`)
    .option('--json', 'machine-readable JSON output')
    .showHelpAfterError('(run with --help for usage)');
  registerSystem(program);
  registerSetup(program);
  registerUpgrade(program);
  registerDiscovery(program);
  registerAcquisition(program);
  registerPolicy(program);
  registerRouting(program);
  registerForge(program);
  registerUi(program);
  registerMigrate(program);
  registerWorkflow(program);
  registerProviders(program);
  registerAgents(program);
  return program;
}

export async function main(argv: string[]) {
  const program = buildProgram();
  await program.parseAsync(argv);
}
