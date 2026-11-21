import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Local-first: `npm run dev` serves on http://localhost:5173. WebSerial needs a
// secure context, and localhost counts as one.
export default defineConfig({
  plugins: [preact()],
  server: { port: 5173, strictPort: true },
});
