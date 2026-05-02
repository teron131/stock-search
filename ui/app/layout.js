import "../styles.css";
import Script from "next/script";

export const metadata = {
	title: "Stock Search",
	description: "Portfolio dashboard and stock research workspace.",
	icons: {
		icon: "/logo.png?v=4",
	},
};

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<head>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
				<link
					href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700;9..144,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
					rel="stylesheet"
				/>
				<Script
					strategy="afterInteractive"
					type="module"
					crossOrigin="anonymous"
					src="https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js"
				/>
				<Script
					strategy="afterInteractive"
					type="module"
					crossOrigin="anonymous"
					src="https://widgets.tradingview-widget.com/w/en/tv-ticker-tag.js"
				/>
			</head>
			<body>{children}</body>
		</html>
	);
}
