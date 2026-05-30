import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <NextThemesProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="ca-theme">
        <HeroUIProvider>
          <main className="app-bg text-foreground min-h-screen">
            <App />
          </main>
        </HeroUIProvider>
      </NextThemesProvider>
    </BrowserRouter>
  </React.StrictMode>
);
