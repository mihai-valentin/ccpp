import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cac } from 'cac';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

const cli = cac('ccpp');

cli.command('version', 'Print the ccpp version').action(() => {
  console.log(pkg.version);
});

cli.command('', 'Show help').action(() => {
  cli.outputHelp();
});

cli.help();
cli.version(pkg.version);

cli.parse();
