export default {
  base: '/',
  server: {
    open: true,
    proxy: {
      '/api': {
        target: 'https://aps-extensions.autodesk.io',
        changeOrigin: true,
        secure: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
};
