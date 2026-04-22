/** Authentication route module. */

import { Hono } from "hono";

import {
	handleCallback,
	handleLogin,
	handleLogout,
	handleSession,
} from "../auth.js";
import {
	AUTH_CALLBACK,
	AUTH_LOGIN,
	AUTH_LOGOUT,
	AUTH_SESSION,
} from "../route-paths.js";

export function createAuthRouter(): Hono {
	const router = new Hono();
	router.get(AUTH_LOGIN, handleLogin);
	router.get(AUTH_CALLBACK, handleCallback);
	router.on(["GET", "POST"], AUTH_LOGOUT, handleLogout);
	router.get(AUTH_SESSION, handleSession);
	return router;
}
