import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";

const demoUrl = new URL(window.location.href);
demoUrl.searchParams.set("demo", "1");
window.history.replaceState({}, "", demoUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
