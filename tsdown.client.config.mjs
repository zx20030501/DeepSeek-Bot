/**
 * DSH client-modules expects a closure-factory bundle, not a browser ESM file.
 * The loader supplies `require`, so React and DSH runtime modules keep their
 * shared identity with the Harness shell.
 */
export default {
  entry: { client: 'src/client.tsx' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-runtime/client',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-hermes-bot", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
