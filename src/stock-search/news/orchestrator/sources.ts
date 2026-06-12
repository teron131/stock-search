/** Fetch and dedupe raw ticker news from configured provider sources. */

import type { NewsArticle } from "../../models/schemas.js";
import * as newsProviders from "../providers/index.js";
import {
	createHttpClient,
	fetchProviderBatch,
	hasEnvValue,
	type ProviderSpec,
} from "./fetch.js";
import type { NewsTickerIdentity } from "./identity.js";
import { dedupeNews } from "./router.js";

export type NewsSourceFetchContext = {
	ticker: string;
	nDays: number;
	maxResults: number;
	tickerIdentity: NewsTickerIdentity;
};

function providerQueryForTickerIdentity(
	tickerIdentity: NewsTickerIdentity,
): string {
	return tickerIdentity.companyName
		? tickerIdentity.label
		: tickerIdentity.ticker;
}

function buildPrimaryProviderSpecs(
	context: NewsSourceFetchContext,
	client: ReturnType<typeof createHttpClient>,
): ProviderSpec[] {
	const { ticker, nDays, tickerIdentity } = context;
	const providerQuery = providerQueryForTickerIdentity(tickerIdentity);
	const primaryProviderSpecs: ProviderSpec[] = [];
	if (hasEnvValue(process.env.NEWSDATA_API_KEY)) {
		primaryProviderSpecs.push([
			"newsdata",
			() =>
				newsProviders.getNewsNewsDataAsync({
					query: providerQuery,
					client,
				}),
		]);
	}
	if (hasEnvValue(process.env.MASSIVE_API_KEY)) {
		primaryProviderSpecs.push([
			"massive",
			() =>
				newsProviders.getNewsMassiveAsync({
					ticker,
					nDays,
					client,
				}),
		]);
	}
	if (hasEnvValue(process.env.NEWS_API_KEY)) {
		primaryProviderSpecs.push([
			"newsapi",
			() =>
				newsProviders.getNewsNewsApiAsync({
					query: providerQuery,
					nDays,
					client,
				}),
		]);
	}
	primaryProviderSpecs.push([
		"yfinance",
		() =>
			newsProviders.getNewsYahooFinance({
				ticker,
			}),
	]);

	return primaryProviderSpecs;
}

export async function fetchRawNewsFromSources(
	context: NewsSourceFetchContext,
): Promise<NewsArticle[]> {
	const client = createHttpClient();
	const providerQuery = providerQueryForTickerIdentity(context.tickerIdentity);
	const primaryProviderSpecs = buildPrimaryProviderSpecs(context, client);
	let rawNewsList = dedupeNews(await fetchProviderBatch(primaryProviderSpecs));

	if (
		rawNewsList.length < context.maxResults &&
		hasEnvValue(process.env.EXA_API_KEY)
	) {
		const exaNewsList = await fetchProviderBatch([
			[
				"exa",
				() =>
					newsProviders.getNewsExaAsync({
						query: providerQuery,
						nDays: context.nDays,
						client,
					}),
			],
		]);
		rawNewsList = dedupeNews([...rawNewsList, ...exaNewsList]);
	}

	return rawNewsList;
}
