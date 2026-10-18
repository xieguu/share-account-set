import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.pages');
const withinRoot = relative(root, output);
if (withinRoot !== '.pages' || isAbsolute(withinRoot)) throw new Error('Invalid Pages output directory');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'app'), { recursive: true });

// Explicit asset lists prevent server files, profiles and credentials entering the artifact.
for (const name of ['index.html', 'pages.css', 'pages.js', 'favicon.svg', '.nojekyll', 'images/dashboard.png', 'images/remote-window.png']) {
  await mkdir(dirname(join(output, name)), { recursive: true });
  await cp(join(root, 'docs', name), join(output, name));
}
for (const name of ['index.html', 'app.js', 'connection.js', 'viewer.html', 'viewer.js', 'base.css', 'style.css', 'viewer.css', 'favicon.svg']) {
  await cp(join(root, 'public', name), join(output, 'app', name));
}
await writeFile(join(output, 'app', 'connection-config.json'), '{"requireBackend":true}\n');
console.log('Pages built: .pages/ (landing) + .pages/app/ (workspace)');
