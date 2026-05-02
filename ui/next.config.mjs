import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @param {string} phase */
export default function createNextConfig(phase) {
	const isDev = phase === PHASE_DEVELOPMENT_SERVER;
	const backend = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

	/** @type {import('next').NextConfig} */
	const config = {
		...(isDev ? {} : { output: "export" }),
		trailingSlash: true,
		images: {
			unoptimized: true,
		},
	};

	if (isDev) {
		config.rewrites = async () =>
			[
				{
					source: "/api-proxy/:path*",
					destination: `${backend}/:path*`,
				},
			];
	}

	return config;
}
