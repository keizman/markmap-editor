import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = !watch;

/** @type {esbuild.BuildOptions[]} */
const configs = [
  {
    entryPoints: { extension: 'src/extension.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    outdir: 'dist',
    sourcemap: !production,
    minify: production,
  },
  {
    entryPoints: { webview: 'src/webview/main.ts' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    outdir: 'dist',
    sourcemap: !production,
    minify: production,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'text' },
  },
];

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('Watching for changes...');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
  console.log('Built dist/extension.js, dist/webview.js, dist/webview.css');
}
