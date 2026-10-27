import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const tiStreamPaths: Plugin = {
  name: "ti-stream-paths",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        res.statusCode = 302;
        res.setHeader("Location", "/ti-stream");
        res.end();
        return;
      }
      if (url.pathname === "/ti-stream") {
        req.url = `/ti-stream/${url.search}`;
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        res.statusCode = 302;
        res.setHeader("Location", "/ti-stream");
        res.end();
        return;
      }
      if (url.pathname === "/ti-stream") {
        req.url = `/ti-stream/${url.search}`;
      }
      next();
    });
  },
};

export default defineConfig({
  base: "/ti-stream/",
  plugins: [react(), tiStreamPaths],
  server: {
    port: 5173,
  },
});
