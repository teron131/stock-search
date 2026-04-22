import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "ui", "dist");
const publicDir = path.join(projectRoot, "public");

async function main() {
	await rm(publicDir, { recursive: true, force: true });
	await mkdir(publicDir, { recursive: true });

	for (const child of await readdir(distDir, { withFileTypes: true })) {
		if (child.name === "index.html") {
			continue;
		}
		const sourcePath = path.join(distDir, child.name);
		const targetPath = path.join(publicDir, child.name);
		await cp(sourcePath, targetPath, { recursive: true });
	}

	console.log(`Prepared Vercel public assets in ${publicDir}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
