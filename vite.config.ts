import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  base: "/GS1Parser/",
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    host: true,
  },
  optimizeDeps: {
    exclude: ["gs1encoder"],
  },
});
