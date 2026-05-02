import { ClientApp } from "../client-app.js";

export const metadata = {
	title: "Market Map - Stock Search",
};

export default function MarketMapPage() {
	return <ClientApp initialView="marketmap" />;
}
