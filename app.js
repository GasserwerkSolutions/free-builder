"use strict";

(async function loadBuilder() {
  for (const src of ["state.js", "website.js", "ui-core.js", "ui-content.js", "ui-actions.js"]) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }
})().catch((error) => {
  console.error(error);
  const status = document.getElementById("saveStatus");
  if (status) status.textContent = "Builder konnte nicht geladen werden";
});
