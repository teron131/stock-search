import { html } from "https://esm.sh/htm@3.1.1/preact";
import { render } from "https://esm.sh/preact@10.19.6";

import { App } from "./preact/App.js?v=20260416e";

const root = document.getElementById("preact-root");
if (!root) {
	throw new Error("Missing #preact-root");
}

render(html`<${App} />`, root);

// Slide Menu Logic
document.addEventListener("DOMContentLoaded", () => {
	const menuOpenBtn = document.getElementById("menu-open-btn");
	const menuCloseBtn = document.getElementById("menu-close-btn");
	const slideMenu = document.getElementById("slide-menu");
	const menuOverlay = document.getElementById("menu-overlay");

	function openMenu() {
		slideMenu.classList.add("open");
		menuOverlay.classList.add("active");
	}

	function closeMenu() {
		slideMenu.classList.remove("open");
		menuOverlay.classList.remove("active");
	}

	if (menuOpenBtn) menuOpenBtn.addEventListener("click", openMenu);
	if (menuCloseBtn) menuCloseBtn.addEventListener("click", closeMenu);
	if (menuOverlay) menuOverlay.addEventListener("click", closeMenu);

	// Handle navigation clicks
	const navItems = document.querySelectorAll(".nav-item");
	navItems.forEach((item) => {
		item.addEventListener("click", () => {
			closeMenu();
			const view = item.dataset.view;
			if (view) {
				// Add your view switching logic here if not handled by Preact
			}
		});
	});
});
