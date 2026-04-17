import { defineConfig } from "vite";

const backendTarget = process.env.VITE_BACKEND_URL || "http://localhost:8000";
const proxyPaths = [
	"/portfolio",
	"/industries",
	"/stock",
	"/color-standards",
	"/realtime-config",
];

const proxy = Object.fromEntries(
	proxyPaths.map((path) => [
		path,
		{
			target: backendTarget,
			changeOrigin: false,
		},
	]),
);

export default defineConfig({
	root: "ui",
	server: {
		host: "localhost",
		port: 5173,
		proxy,
	},
	preview: {
		host: "localhost",
		port: 4173,
		proxy,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
