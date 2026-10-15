import { build } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['backend/unblock_helper.cjs'],
  outfile: 'dist/unblock_helper.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  legalComments: 'eof',
  metafile: true,
});
for (const license of ['COPYING', 'COPYING.LESSER']) {
  copyFileSync(new URL(`../node_modules/@unblockneteasemusic/server/${license}`, import.meta.url), new URL(`../dist/UnblockNeteaseMusic-${license}`, import.meta.url));
}
const packages = new Set();
for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== root && !existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory);
  if (directory !== root) packages.add(directory);
}
const notices = [...packages].sort().map(directory => {
  const info = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const licenses = readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  return `${info.name} ${info.version} (${info.license || 'see license'})\n${licenses.map(name => readFileSync(path.join(directory, name), 'utf8')).join('\n')}`;
});
writeFileSync(new URL('../dist/UnblockNeteaseMusic-NOTICES.txt', import.meta.url), notices.join('\n\n---\n\n'));
