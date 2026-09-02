import "@anvil/design/tokens.css";
import "@fontsource/hanken-grotesk/latin-500.css";
import "@fontsource/hanken-grotesk/latin-600.css";
import "@fontsource/hanken-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createConsoleApi } from "./api.js";
import { App } from "./app.js";

const root = document.getElementById("root");
if (!root) throw new Error("the console page has no #root");
createRoot(root).render(
  <StrictMode>
    <App api={createConsoleApi()} />
  </StrictMode>,
);
