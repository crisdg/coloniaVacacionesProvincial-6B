import React from "react";
import { createRoot } from "react-dom/client";
import TutorInscripciones from "./TutorInscripciones";
import "./style.css";

const root = document.getElementById("tutor-root");

if (!root) {
  throw new Error("No se encontró el contenedor de la pantalla de tutor.");
}

createRoot(root).render(
  <React.StrictMode>
    <TutorInscripciones />
  </React.StrictMode>,
);
