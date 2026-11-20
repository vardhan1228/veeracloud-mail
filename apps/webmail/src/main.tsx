import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider, initTheme } from "@havins/ui";
import "./index.css";
import { App } from "./App";

initTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
