// Bundle the browser client into public/app.js. The Worker itself is bundled by wrangler.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/client/app.ts'], bundle: true, format: 'esm', target: 'es2020',
  outfile: 'public/app.js', minify: true, sourcemap: true, legalComments: 'none',
});
console.log('built public/app.js');
