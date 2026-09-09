import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

// Agent dual-mode: an agent driving a browser passes ?agent (or mode=agent).
// Mark <html> so the stylesheet can enlarge tap targets for reliable clicking.
const q = new URLSearchParams(location.search);
if (q.has("agent") || q.get("mode") === "agent") {
  document.documentElement.setAttribute("data-agent", "");
}

createRoot(document.getElementById("app")!).render(<App />);
