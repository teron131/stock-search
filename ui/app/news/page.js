import { ClientApp } from "../client-app.js";

export const metadata = {
	title: "News - Stock Search",
};

export default function NewsPage() {
	return <ClientApp initialView="news" />;
}
