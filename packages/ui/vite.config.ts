import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Mokie serves this UI under /_admin/ on its single port. */
const mokie = `http://localhost:${process.env.MOKIE_PORT ?? 8080}`;

/** dev only: `/` and `/_admin` → `/_admin/`, like the Mokie server does */
const adminRedirect: Plugin = {
  name: 'mokie-admin-redirect',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/' || req.url === '/_admin') {
        res.writeHead(302, { location: '/_admin/' });
        return res.end();
      }
      next();
    });
  },
};

export default defineConfig({
  base: '/_admin/',
  plugins: [react(), adminRedirect],
  server: {
    port: 5173,
    // admin API + flow pages are served by the Mokie server
    proxy: {
      '/_admin/api': { target: mokie, changeOrigin: true },
      '/__mokie': { target: mokie, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
