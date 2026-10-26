import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./app/App";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./features/map/prototype-map.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("FoodMap root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
