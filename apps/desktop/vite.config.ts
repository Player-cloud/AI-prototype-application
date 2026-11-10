import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and loads the built files from dist/.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Don't watch the Rust side: its build folder is huge and Windows locks files there (EBUSY noise).
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { outDir: 'dist', target: 'es2022' },
});
