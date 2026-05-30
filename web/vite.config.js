import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev`, proxy API + the public endpoint to the Node backend (8787).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
