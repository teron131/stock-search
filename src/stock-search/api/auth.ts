import { createHmac, randomBytes } from "node:crypto";

import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { appConfig } from "./config.js";
import {
	AUTH_CALLBACK,
	AUTH_LOGIN,
	AUTH_LOGOUT,
	AUTH_SESSION,
	DASHBOARD_PAGE_PATHS,
	PUBLIC_STATIC_PREFIXES,
	ROOT,
} from "./route-paths.js";
import { sanitizeNextPath } from "../utils.js";
import type { Context, Next } from "hono";

type SessionUser = {
	email: string;
	name?: string | null;
	sub?: string | null;
};

const SESSION_COOKIE = "stock_search_session";
const STATE_COOKIE = "stock_search_auth_state";
const NEXT_COOKIE = "stock_search_auth_next";
const PUBLIC_STATIC_EXTENSIONS = new Set([
	".avif",
	".bmp",
	".css",
	".gif",
	".ico",
	".jpeg",
	".jpg",
	".js",
	".json",
	".map",
	".png",
	".svg",
	".txt",
	".webmanifest",
	".webp",
	".woff",
	".woff2",
]);

function isConfigured(): boolean {
	return Boolean(
		appConfig.authSecret &&
			appConfig.authGoogleId &&
			appConfig.authGoogleSecret &&
			appConfig.allowedEmail,
	);
}

function signPayload(value: string): string {
	return createHmac("sha256", appConfig.authSecret).update(value).digest("base64url");
}

function encodeSession(user: SessionUser): string {
	const payload = Buffer.from(JSON.stringify(user)).toString("base64url");
	return `${payload}.${signPayload(payload)}`;
}

function decodeSession(cookieValue?: string): SessionUser | null {
	if (!cookieValue || !cookieValue.includes(".")) {
		return null;
	}
	const [payload, signature] = cookieValue.split(".", 2);
	if (signPayload(payload) !== signature) {
		return null;
	}
	try {
		const decoded = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as SessionUser;
		const email = String(decoded.email ?? "").trim().toLowerCase();
		if (!email || email !== appConfig.allowedEmail) {
			return null;
		}
		return {
			email,
			name: decoded.name ?? null,
			sub: decoded.sub ?? null,
		};
	} catch {
		return null;
	}
}

export function getCurrentUser(c: Context): SessionUser | null {
	return decodeSession(getCookie(c, SESSION_COOKIE));
}

export function clearAuthCookies(c: Context): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	deleteCookie(c, STATE_COOKIE, { path: "/" });
	deleteCookie(c, NEXT_COOKIE, { path: "/" });
}

function setSessionCookie(c: Context, user: SessionUser): void {
	setCookie(c, SESSION_COOKIE, encodeSession(user), {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: appConfig.authEnabled,
		maxAge: 7 * 24 * 60 * 60,
	});
}

export function isPublicRequestPath(pathname: string): boolean {
	if (
		pathname === AUTH_LOGIN ||
		pathname === AUTH_CALLBACK ||
		pathname === AUTH_LOGOUT ||
		pathname === AUTH_SESSION ||
		pathname === "/favicon.ico"
	) {
		return true;
	}
	if (PUBLIC_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		return true;
	}
	const suffix = pathname.includes(".")
		? pathname.slice(pathname.lastIndexOf(".")).toLowerCase()
		: "";
	return PUBLIC_STATIC_EXTENSIONS.has(suffix);
}

export async function authGuard(c: Context, next: Next): Promise<void | Response> {
	if (!appConfig.authEnabled || isPublicRequestPath(c.req.path)) {
		return next();
	}
	if (!isConfigured()) {
		return c.text("Authentication is not fully configured.", 503);
	}
	const currentUser = getCurrentUser(c);
	if (currentUser) {
		return next();
	}
	if ((DASHBOARD_PAGE_PATHS as readonly string[]).includes(c.req.path)) {
		const url = new URL(c.req.url);
		const nextPath = sanitizeNextPath(`${url.pathname}${url.search}`);
		return c.redirect(
			`${AUTH_LOGIN}?next=${encodeURIComponent(nextPath)}`,
			307,
		);
	}
	return c.json({ detail: "Authentication required" }, 401);
}

function buildGoogleAuthorizeUrl(requestUrl: string, state: string): string {
	const currentUrl = new URL(requestUrl);
	const redirectUri = `${currentUrl.origin}${AUTH_CALLBACK}`;
	const params = new URLSearchParams({
		client_id: appConfig.authGoogleId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid email profile",
		state,
		prompt: "select_account",
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleLogin(c: Context): Promise<Response> {
	const nextPath = sanitizeNextPath(c.req.query("next"));
	if (!appConfig.authEnabled) {
		return c.redirect(nextPath, 307);
	}
	if (!isConfigured()) {
		return c.text("Authentication is not fully configured.", 503);
	}
	const state = randomBytes(16).toString("hex");
	setCookie(c, STATE_COOKIE, state, {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: appConfig.authEnabled,
		maxAge: 10 * 60,
	});
	setCookie(c, NEXT_COOKIE, nextPath, {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: appConfig.authEnabled,
		maxAge: 10 * 60,
	});
	return c.redirect(buildGoogleAuthorizeUrl(c.req.url, state), 307);
}

export async function handleCallback(c: Context): Promise<Response> {
	if (!appConfig.authEnabled) {
		return c.redirect(ROOT, 307);
	}
	if (!isConfigured()) {
		return c.text("Authentication is not fully configured.", 503);
	}

	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");
	if (error) {
		clearAuthCookies(c);
		return c.text(`Google sign-in failed: ${error}`, 400);
	}
	if (!code || !state) {
		clearAuthCookies(c);
		return c.text("Missing Google OAuth callback parameters.", 400);
	}

	const expectedState = getCookie(c, STATE_COOKIE);
	const nextPath = sanitizeNextPath(getCookie(c, NEXT_COOKIE));
	if (!expectedState || state !== expectedState) {
		clearAuthCookies(c);
		return c.text("Invalid OAuth state.", 400);
	}

	const currentUrl = new URL(c.req.url);
	const redirectUri = `${currentUrl.origin}${AUTH_CALLBACK}`;

	try {
		const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: appConfig.authGoogleId,
				client_secret: appConfig.authGoogleSecret,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
			}),
		});
		if (!tokenResponse.ok) {
			clearAuthCookies(c);
			return c.text("Failed to verify Google account.", 502);
		}
		const tokenPayload = (await tokenResponse.json()) as {
			access_token?: string;
		};
		if (!tokenPayload.access_token) {
			clearAuthCookies(c);
			return c.text("Missing Google access token.", 502);
		}
		const userInfoResponse = await fetch(
			"https://openidconnect.googleapis.com/v1/userinfo",
			{
				headers: {
					authorization: `Bearer ${tokenPayload.access_token}`,
				},
			},
		);
		if (!userInfoResponse.ok) {
			clearAuthCookies(c);
			return c.text("Failed to verify Google account.", 502);
		}
		const userInfo = (await userInfoResponse.json()) as {
			email?: string;
			email_verified?: boolean;
			name?: string;
			sub?: string;
		};
		const email = String(userInfo.email ?? "").trim().toLowerCase();
		if (!email) {
			clearAuthCookies(c);
			return c.text("Google account is missing an email.", 403);
		}
		if (!userInfo.email_verified) {
			clearAuthCookies(c);
			return c.text("Google email is not verified.", 403);
		}
		if (email !== appConfig.allowedEmail) {
			clearAuthCookies(c);
			return c.text("Google account is not allowed.", 403);
		}
		setSessionCookie(c, {
			email,
			name: userInfo.name ?? null,
			sub: userInfo.sub ?? null,
		});
		deleteCookie(c, STATE_COOKIE, { path: "/" });
		deleteCookie(c, NEXT_COOKIE, { path: "/" });
		return c.redirect(nextPath, 307);
	} catch {
		clearAuthCookies(c);
		return c.text("Failed to verify Google account.", 502);
	}
}

export async function handleLogout(c: Context): Promise<Response> {
	clearAuthCookies(c);
	return c.redirect(appConfig.authEnabled ? AUTH_LOGIN : ROOT, 307);
}

export async function handleSession(c: Context): Promise<Response> {
	const currentUser = getCurrentUser(c);
	c.header("Cache-Control", "no-store");
	return c.json({
		enabled: appConfig.authEnabled,
		authenticated: currentUser !== null,
		email: currentUser?.email ?? null,
	});
}
