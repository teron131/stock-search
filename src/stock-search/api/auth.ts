import { createHmac, randomBytes } from "node:crypto";

import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { appConfig } from "./config.js";
import {
	AUTH_CALLBACK,
	AUTH_LOGIN,
	AUTH_LOGOUT,
	AUTH_SESSION,
	COLOR_STANDARDS,
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
	iat: number;
	exp: number;
};

type GoogleTokenResponse = {
	access_token?: string;
};

type GoogleUserInfo = {
	email?: string;
	email_verified?: boolean;
	name?: string;
	sub?: string;
};

const SESSION_COOKIE = "stock_search_session";
const STATE_COOKIE = "stock_search_auth_state";
const NEXT_COOKIE = "stock_search_auth_next";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
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

function authErrorResponse(
	c: Context,
	message: string,
	status: 400 | 403 | 502,
): Response {
	clearAuthCookies(c);
	return c.text(message, status);
}

function signPayload(value: string): string {
	return createHmac("sha256", appConfig.authSecret).update(value).digest("base64url");
}

function nowUnixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function encodeSession(
	user: Omit<SessionUser, "iat" | "exp">,
	currentUnixSeconds = nowUnixSeconds(),
): string {
	const payload = Buffer.from(
		JSON.stringify({
			...user,
			iat: currentUnixSeconds,
			exp: currentUnixSeconds + SESSION_MAX_AGE_SECONDS,
		} satisfies SessionUser),
	).toString("base64url");
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
		const issuedAt = Number(decoded.iat);
		const expiresAt = Number(decoded.exp);
		const currentUnixSeconds = nowUnixSeconds();
		if (
			!email ||
			email !== appConfig.allowedEmail ||
			!Number.isFinite(issuedAt) ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= currentUnixSeconds ||
			issuedAt > currentUnixSeconds + CLOCK_SKEW_SECONDS ||
			expiresAt <= issuedAt
		) {
			return null;
		}
		return {
			email,
			name: decoded.name ?? null,
			sub: decoded.sub ?? null,
			iat: issuedAt,
			exp: expiresAt,
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

function setSessionCookie(
	c: Context,
	user: Omit<SessionUser, "iat" | "exp">,
): void {
	setCookie(c, SESSION_COOKIE, encodeSession(user), {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: appConfig.authEnabled,
		maxAge: SESSION_MAX_AGE_SECONDS,
	});
}

export function isPublicRequestPath(pathname: string): boolean {
	if (
		pathname === AUTH_LOGIN ||
		pathname === AUTH_CALLBACK ||
		pathname === AUTH_LOGOUT ||
		pathname === AUTH_SESSION ||
		pathname === COLOR_STANDARDS ||
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
	const params = new URLSearchParams({
		client_id: appConfig.authGoogleId,
		redirect_uri: buildGoogleRedirectUri(requestUrl),
		response_type: "code",
		scope: "openid email profile",
		state,
		prompt: "select_account",
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function buildGoogleRedirectUri(requestUrl: string): string {
	return `${new URL(requestUrl).origin}${AUTH_CALLBACK}`;
}

function setTemporaryAuthCookie(
	c: Context,
	name: string,
	value: string,
): void {
	setCookie(c, name, value, {
		httpOnly: true,
		path: "/",
		sameSite: "Lax",
		secure: appConfig.authEnabled,
		maxAge: 10 * 60,
	});
}

async function exchangeGoogleCodeForAccessToken(
	code: string,
	redirectUri: string,
): Promise<string | null> {
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
		return null;
	}
	const tokenPayload = (await tokenResponse.json()) as GoogleTokenResponse;
	return tokenPayload.access_token ?? null;
}

async function fetchGoogleUserInfo(
	accessToken: string,
): Promise<GoogleUserInfo | null> {
	const userInfoResponse = await fetch(
		"https://openidconnect.googleapis.com/v1/userinfo",
		{
			headers: {
				authorization: `Bearer ${accessToken}`,
			},
		},
	);
	if (!userInfoResponse.ok) {
		return null;
	}
	return (await userInfoResponse.json()) as GoogleUserInfo;
}

function normalizeAllowedGoogleUser(
	userInfo: GoogleUserInfo,
): Omit<SessionUser, "iat" | "exp"> | null {
	const email = String(userInfo.email ?? "").trim().toLowerCase();
	if (!email || !userInfo.email_verified || email !== appConfig.allowedEmail) {
		return null;
	}
	return {
		email,
		name: userInfo.name ?? null,
		sub: userInfo.sub ?? null,
	};
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
	setTemporaryAuthCookie(c, STATE_COOKIE, state);
	setTemporaryAuthCookie(c, NEXT_COOKIE, nextPath);
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
		return authErrorResponse(c, `Google sign-in failed: ${error}`, 400);
	}
	if (!code || !state) {
		return authErrorResponse(c, "Missing Google OAuth callback parameters.", 400);
	}

	const expectedState = getCookie(c, STATE_COOKIE);
	const nextPath = sanitizeNextPath(getCookie(c, NEXT_COOKIE));
	if (!expectedState || state !== expectedState) {
		return authErrorResponse(c, "Invalid OAuth state.", 400);
	}

	const redirectUri = buildGoogleRedirectUri(c.req.url);

	try {
		const accessToken = await exchangeGoogleCodeForAccessToken(code, redirectUri);
		if (!accessToken) {
			return authErrorResponse(c, "Failed to verify Google account.", 502);
		}
		const userInfo = await fetchGoogleUserInfo(accessToken);
		if (!userInfo) {
			return authErrorResponse(c, "Failed to verify Google account.", 502);
		}
		const sessionUser = normalizeAllowedGoogleUser(userInfo);
		if (!sessionUser) {
			const email = String(userInfo.email ?? "").trim().toLowerCase();
			if (!email) {
				return authErrorResponse(c, "Google account is missing an email.", 403);
			}
			if (!userInfo.email_verified) {
				return authErrorResponse(c, "Google email is not verified.", 403);
			}
			return authErrorResponse(c, "Google account is not allowed.", 403);
		}
		setSessionCookie(c, sessionUser);
		deleteCookie(c, STATE_COOKIE, { path: "/" });
		deleteCookie(c, NEXT_COOKIE, { path: "/" });
		return c.redirect(nextPath, 307);
	} catch {
		return authErrorResponse(c, "Failed to verify Google account.", 502);
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
