import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

function normalizeBasePath(value) {
	const trimmed = String(value || "").trim();
	if (!trimmed || trimmed === "/") {
		return "";
	}
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** @param {string} phase */
export default function createNextConfig(phase) {
	const isDev = phase === PHASE_DEVELOPMENT_SERVER;
	const backend =
		process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
	const basePath = isDev
		? ""
		: normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

	/** @type {import('next').NextConfig} */
	const config = {
		...(isDev ? {} : { output: "export" }),
		...(basePath ? { basePath } : {}),
		trailingSlash: true,
		images: {
			unoptimized: true,
		},
	};

	if (isDev) {
		config.rewrites = async () => [
			{
				source: "/api-proxy/:path*",
				destination: `${backend}/:path*`,
			},
		];
	}

	return config;
}
