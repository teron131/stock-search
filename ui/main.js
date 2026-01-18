import { html } from "https://esm.sh/htm@3.1.1/preact";
import { render } from "https://esm.sh/preact@10.19.6";

import { App } from "./preact/App.js";

const root = document.getElementById("preact-root");
if (!root) {
  throw new Error("Missing #preact-root");
}

render(html`<${App} />`, root);
